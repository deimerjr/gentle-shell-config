import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import * as harness from './rpc-test-harness.ts';

function fakeChild() {
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill: () => true,
  });
}

const options = { cwd: '.', env: {}, args: ['--mode', 'rpc'] };

test('launches installed JS with Node; explicit executable overrides resolution', () => {
  assert.deepEqual(harness.resolvePiLaunch('', () => '/installed/pi/dist/cli.js'), {
    command: process.execPath, args: ['/installed/pi/dist/cli.js'],
  });
  assert.deepEqual(harness.resolvePiLaunch('/custom/pi.exe', () => { throw Error('unused'); }), {
    command: '/custom/pi.exe', args: [],
  });
  assert.deepEqual(harness.resolvePiLaunch('/custom/cli.mjs'), {
    command: process.execPath, args: ['/custom/cli.mjs'],
  });
  assert.throws(() => harness.resolvePiLaunch('', () => { throw Error('missing'); }), /SUPERVISOR_TEST_PI_CLI/);
});

test('default launch honors the environment override without resolving an installed CLI', () => {
  const previous = process.env.SUPERVISOR_TEST_PI_CLI;
  try {
    process.env.SUPERVISOR_TEST_PI_CLI = '/environment/cli.js';
    assert.deepEqual(harness.resolvePiLaunch(undefined, () => { throw Error('unused'); }), {
      command: process.execPath, args: ['/environment/cli.js'],
    });
  } finally {
    if (previous === undefined) delete process.env.SUPERVISOR_TEST_PI_CLI;
    else process.env.SUPERVISOR_TEST_PI_CLI = previous;
  }
});

test('spawn error rejects pending and subsequent requests and shutdown without waiting for exit', async () => {
  const child = fakeChild();
  const rpc = harness.startRpc({ command: 'missing', args: [] }, options, () => child as any);
  const response = assert.rejects(rpc.state(), /ENOENT/);
  child.emit('error', new Error('ENOENT'));
  await response;
  await assert.rejects(rpc.state(), /ENOENT/);
  await assert.rejects(rpc.close(), /ENOENT/);
});

test('early exit preserves code, stderr and rejects shutdown even when already exited', async () => {
  const child = fakeChild();
  const rpc = harness.startRpc({ command: 'pi', args: [] }, options, () => child as any);
  child.stderr.write('startup diagnostic');
  child.emit('exit', 7, null);
  child.emit('close', 7, null);
  await assert.rejects(rpc.state(), /7.*startup diagnostic/);
  await assert.rejects(rpc.close(), /7.*startup diagnostic/);
});

test('shell stays false; response parsing and normal EOF shutdown work', async () => {
  const child = fakeChild();
  let spawned: any;
  const events: any[] = [];
  const rpc = harness.startRpc({ command: 'node', args: ['cli.js'] }, { ...options, events }, (command, args, opts) => {
    spawned = { command, args, opts };
    return child as any;
  });
  const response = rpc.state();
  child.stdout.write('not json\n{"type":"response","id":"state","success":true,');
  child.stdout.write('"data":{"model":{"id":"alpha"}}}\r\n');
  assert.equal((await response).data.model.id, 'alpha');
  assert.equal(events.length, 1);
  assert.equal(spawned.opts.shell, false);
  assert.deepEqual(spawned.args, ['cli.js', '--mode', 'rpc']);
  child.stdin.once('finish', () => { child.emit('exit', 0, null); child.emit('close', 0, null); });
  await rpc.close();
  await rpc.close();
});

test('stdin errors are visible and remaining child is killed during cleanup', async () => {
  const child = fakeChild();
  let killed = false;
  child.kill = () => { killed = true; child.emit('exit', null, 'SIGKILL'); child.emit('close', null, 'SIGKILL'); return true; };
  const rpc = harness.startRpc({ command: 'pi', args: [] }, options, () => child as any);
  const response = assert.rejects(rpc.state(), /EPIPE/);
  child.stdin.emit('error', new Error('EPIPE'));
  await response;
  await assert.rejects(rpc.close(), /EPIPE/);
  assert.equal(killed, true);
});

test('successful readiness gets 20 seconds, later requests get 6 seconds and shutdown keeps 4 seconds', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const child = fakeChild();
  let kills = 0;
  child.kill = () => {
    kills++;
    child.emit('exit', null, 'SIGKILL');
    child.emit('close', null, 'SIGKILL');
    return true;
  };
  const rpc = harness.startRpc({ command: 'pi', args: [] }, options, () => child as any);
  let settled = false;
  const initial = rpc.state().finally(() => { settled = true; });
  // Attach a rejection handler before advancing time, including on the RED implementation.
  const initialOutcome = initial.then(record => record, error => error);
  t.mock.timers.tick(6000);
  await Promise.resolve();
  assert.equal(settled, false, 'startup must still be pending at 6 seconds');
  t.mock.timers.tick(13999);
  await Promise.resolve();
  assert.equal(settled, false, 'startup must still be pending at 19,999ms');
  child.stdout.write('{"type":"response","id":"state","success":true}\n');
  assert.equal((await initialOutcome).success, true);
  let laterSettled = false;
  const later = assert.rejects(rpc.state().finally(() => { laterSettled = true; }), /get_state timed out/);
  t.mock.timers.tick(5999);
  await Promise.resolve();
  assert.equal(laterSettled, false);
  t.mock.timers.tick(1);
  await later;
  assert.equal(kills, 1, 'later timeout kills the child at 6 seconds');
  await assert.rejects(rpc.close(), /get_state timed out/);

  const shutdownChild = fakeChild();
  shutdownChild.kill = () => {
    shutdownChild.emit('exit', null, 'SIGKILL');
    shutdownChild.emit('close', null, 'SIGKILL');
    return true;
  };
  const shutdownRpc = harness.startRpc({ command: 'pi', args: [] }, options, () => shutdownChild as any);
  let shutdownSettled = false;
  const shutdown = assert.rejects(shutdownRpc.close().finally(() => { shutdownSettled = true; }), /shutdown failed/);
  t.mock.timers.tick(3999);
  await Promise.resolve();
  assert.equal(shutdownSettled, false);
  t.mock.timers.tick(1);
  await shutdown;
});

for (const unsuccessfulResponse of [false, true]) {
  test(`initial readiness timeout rejects at 20 seconds and cleans up (unsuccessful response: ${unsuccessfulResponse})`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const child = fakeChild();
    let kills = 0;
    child.kill = () => {
      kills++;
      child.emit('exit', null, 'SIGKILL');
      child.emit('close', null, 'SIGKILL');
      return true;
    };
    const rpc = harness.startRpc({ command: 'pi', args: [] }, options, () => child as any);
    if (unsuccessfulResponse) {
      const failedResponse = rpc.state();
      child.stdout.write('{"type":"response","id":"state","success":false}\n');
      assert.equal((await failedResponse).success, false);
    }
    let settled = false;
    const response = assert.rejects(rpc.state().finally(() => { settled = true; }), /get_state timed out/);
    t.mock.timers.tick(6000);
    await Promise.resolve();
    assert.equal(settled, false, 'only a successful response marks readiness');
    t.mock.timers.tick(13999);
    await Promise.resolve();
    assert.equal(settled, false);
    assert.equal(kills, 0);
    t.mock.timers.tick(1);
    await response;
    assert.equal(kills, 1, 'initial timeout kills the child at 20,000ms');
    await assert.rejects(rpc.state(), /get_state timed out/, 'timeout cannot be retried with a new budget');
    await assert.rejects(harness.closeAll([rpc]), /cleanup failed/);
    assert.equal(kills, 1, 'cleanup does not kill an already closed child again');
  });
}

test('cleanup attempts every child even when one shutdown rejects', async () => {
  const closed: number[] = [];
  await assert.rejects(harness.closeAll([
    { close: async () => { closed.push(1); throw Error('first failed'); } },
    { close: async () => { closed.push(2); } },
    { close: async () => { closed.push(3); throw Error('third failed'); } },
  ]), (error: AggregateError) => {
    assert.deepEqual(error.errors.map(error => error.message), ['first failed', 'third failed']);
    return true;
  });
  assert.deepEqual(closed, [1, 2, 3]);
});
