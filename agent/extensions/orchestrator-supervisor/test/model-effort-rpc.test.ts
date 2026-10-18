import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { updateSubagentConfig } from '../src/subagent-config.ts';
import { EFFORT_PROVIDER } from './fixtures/effort-provider.ts';

const extensionPath = fileURLToPath(new URL('../index.ts', import.meta.url));
const providerPath = fileURLToPath(new URL('./fixtures/effort-provider.ts', import.meta.url));

/**
 * Real offline Pi RPC: capability discovery must equal the host's own public resolver, and
 * an explicit per-model effort must reach the actual assigned child session. No model
 * request is ever sent; settings stay isolated in a temporary home.
 */
test('real Pi RPC: discovery equals host resolver and a marked child applies the stored effort', { timeout: 25000 }, async () => {
  const root = mkdtempSync(resolve('.tmp-effort-rpc-'));
  const home = join(root, 'home');
  const project = join(root, 'project');
  const agentDir = join(home, 'agent');
  const runtime = join(root, 'runtime');
  const probe = join(root, 'probe.json');
  for (const path of [home, project, agentDir, join(root, 'tmp')]) mkdirSync(path, { recursive: true });
  mkdirSync(join(project, '.git'));
  const oldRuntime = process.env.GENTLE_SUPERVISOR_RUNTIME_DIR;
  const oldAgent = process.env.PI_CODING_AGENT_DIR;
  process.env.GENTLE_SUPERVISOR_RUNTIME_DIR = runtime;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const closers: Array<() => Promise<void>> = [];
  const events: any[] = [];
  let stderr = '';

  const start = async (marked: boolean, extraEnv: NodeJS.ProcessEnv = {}) => {
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: home, TMPDIR: join(root, 'tmp'),
      XDG_CONFIG_HOME: join(home, 'config'), XDG_CACHE_HOME: join(home, 'cache'), XDG_DATA_HOME: join(home, 'data'),
      PI_CODING_AGENT_DIR: agentDir, GENTLE_PI_AGENT_HOME: agentDir,
      GENTLE_SUPERVISOR_RUNTIME_DIR: runtime,
      PI_OFFLINE: '1', NO_COLOR: '1',
      NODE_COMPILE_CACHE: join(root, 'compile-cache'),
      ...(marked ? { GENTLE_PI_AGENTS_CHILD: '1' } : {}),
      ...extraEnv,
    };
    const child = spawn(process.env.SUPERVISOR_TEST_PI_CLI || 'pi', [
      '--mode', 'rpc', '--offline', '--no-session', '--no-extensions',
      '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files', '--no-mcp', '--no-tools',
      '--extension', providerPath, '--extension', extensionPath,
      '--model', `${EFFORT_PROVIDER}/baseline`,
    ], { cwd: project, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let pending = '';
    let waiter: { resolve: (r: any) => void; reject: (e: Error) => void } | undefined;
    let exited = false;
    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(res => {
      child.once('exit', (code, signal) => {
        exited = true;
        waiter?.reject(new Error(`Pi exited before RPC response: ${code}/${signal}; ${stderr}`));
        res({ code, signal });
      });
    });
    child.once('error', error => waiter?.reject(error));
    child.stderr.on('data', data => { stderr += data.toString(); });
    child.stdout.on('data', data => {
      pending += data.toString();
      let at: number;
      while ((at = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, at).replace(/\r$/, '');
        pending = pending.slice(at + 1);
        let record: any;
        try { record = JSON.parse(line); } catch { continue; }
        events.push(record);
        if (record.type === 'response' && record.id === 'state') waiter?.resolve(record);
      }
    });
    const close = async () => {
      if (exited) return;
      child.stdin.end();
      const timer = setTimeout(() => child.kill('SIGKILL'), 4000);
      try {
        const result = await exit;
        assert.equal(result.signal, null, 'Pi should shut down normally after stdin EOF');
        assert.equal(result.code, 0, stderr);
      } finally { clearTimeout(timer); }
    };
    closers.push(close);
    const response = await new Promise<any>((res, rej) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); rej(new Error(`Pi get_state timed out; ${stderr}`)); }, 6000);
      waiter = {
        resolve: r => { clearTimeout(timer); waiter = undefined; res(r); },
        reject: e => { clearTimeout(timer); waiter = undefined; rej(e); },
      };
      child.stdin.write(JSON.stringify({ id: 'state', type: 'get_state' }) + '\n');
    });
    assert.equal(response.success, true, JSON.stringify(response));
    return { model: response.data.model.id as string, thinkingLevel: response.data.thinkingLevel as string, close };
  };

  try {
    // 1. Capability discovery, inside a real host process, equals the host resolver.
    const ordinary = await start(false, { SUPERVISOR_EFFORT_PROBE: probe });
    await ordinary.close();
    const found = JSON.parse(readFileSync(probe, 'utf8'));
    for (const id of ['baseline', 'reasoner']) {
      assert.deepEqual(found[id].extension, found[id].host, `${id}: discovery must equal getSupportedThinkingLevels`);
    }
    assert.ok(found.reasoner.host.includes('low'), `fixture premise: reasoner supports low (${JSON.stringify(found.reasoner.host)})`);
    assert.ok(found.reasoner.host.length > found.baseline.host.length, 'reasoning model exposes more levels than a non-reasoning one');

    // 2. Without an override the child keeps the host's thinking level.
    updateSubagentConfig(project, { enabled: true, modelCount: 2, priorityCandidateIds: ['', `${EFFORT_PROVIDER}/reasoner`] });
    const plain = await start(true);
    assert.equal(plain.model, 'reasoner');
    const hostDefault = plain.thinkingLevel;
    await plain.close();

    // 3. An explicit override for the selected model reaches the actual child session.
    const override = hostDefault === 'low' ? 'high' : 'low';
    assert.ok(found.reasoner.host.includes(override), `fixture premise: reasoner supports ${override}`);
    updateSubagentConfig(project, { modelEfforts: { [`${EFFORT_PROVIDER}/reasoner`]: override } });
    const marked = await start(true);
    assert.equal(marked.model, 'reasoner');
    assert.equal(marked.thinkingLevel, override, 'stored effort must be applied after the model assignment');
    await marked.close();

    assert.ok(!events.some(event => event.type === 'message_start' || event.type === 'agent_start'), 'no model request was sent');
    assert.doesNotMatch(stderr, /failed to load extension|error loading extension/i);
  } finally {
    try {
      for (const close of closers) await close();
    } finally {
      if (oldRuntime === undefined) delete process.env.GENTLE_SUPERVISOR_RUNTIME_DIR;
      else process.env.GENTLE_SUPERVISOR_RUNTIME_DIR = oldRuntime;
      if (oldAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = oldAgent;
      rmSync(root, { recursive: true, force: true });
    }
  }
});
