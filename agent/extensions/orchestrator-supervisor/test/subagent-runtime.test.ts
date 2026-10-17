import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import supervisor from '../index.ts';
import { updateSubagentConfig } from '../src/subagent-config.ts';

/** Exercises the actual factory with the host's multiple-listener event semantics. */
test('the supervisor factory assigns selected models only in marked Gentle Agents RPC children', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'supervisor-child-host-'));
  const saved = {
    runtime: process.env.GENTLE_SUPERVISOR_RUNTIME_DIR,
    child: process.env.GENTLE_PI_AGENTS_CHILD,
  };
  process.env.GENTLE_SUPERVISOR_RUNTIME_DIR = join(dir, 'runtime');
  const candidates = [
    { provider: 'example', id: 'selected-a', type: 'chat' },
    { provider: 'example', id: 'selected-b', type: 'chat' },
    { provider: 'example', id: 'manual', type: 'chat' },
  ];
  const instances: any[] = [];
  const host = (marked: boolean) => {
    if (marked) process.env.GENTLE_PI_AGENTS_CHILD = '1';
    else delete process.env.GENTLE_PI_AGENTS_CHILD;
    const hooks = new Map<string, Array<(...args: any[]) => any>>();
    const changes: string[] = [];
    const sessionId = `session-${instances.length}`;
    const ctx: any = {
      cwd: dir, mode: 'rpc', hasUI: false,
      sessionManager: { getSessionId: () => sessionId },
      model: candidates[2],
      modelRegistry: {
        find: (provider: string, id: string) => candidates.find(m => m.provider === provider && m.id === id),
        getAvailable: () => candidates,
        getAll: () => candidates,
      },
      ui: { setStatus: () => {}, notify: () => {} },
    };
    const pi: any = {
      on: (name: string, fn: (...args: any[]) => any) => {
        hooks.set(name, [...(hooks.get(name) ?? []), fn]);
        return () => {};
      },
      registerCommand: () => {}, registerTool: () => {},
      setModel: async (model: any) => { changes.push(`${model.provider}/${model.id}`); ctx.model = model; return true; },
      setThinkingLevel: () => {},
    };
    supervisor(pi);
    const h = {
      changes, ctx,
      emit: async (name: string, event: any = {}) => {
        for (const fn of hooks.get(name) ?? []) await fn(event, ctx);
      },
    };
    instances.push(h);
    return h;
  };
  try {
    updateSubagentConfig(dir, { enabled: true, modelCount: 3, priorityCandidateIds: ['', 'example/selected-a', 'example/selected-b'] });
    const ordinary = host(false);
    await ordinary.emit('session_start', { reason: 'startup' });
    assert.deepEqual(ordinary.changes, [], 'ordinary RPC is not a Gentle Agents child');
    const child = host(true);
    await child.emit('session_start', { reason: 'startup' });
    assert.equal(child.changes.length, 1, 'assign once before a first request');
    assert.ok(['example/selected-a', 'example/selected-b'].includes(child.changes[0]));
    await child.emit('before_agent_start', { messageType: 'user' });
    assert.equal(child.changes.length, 1, 'startup and before_agent_start share the assignment');
    const second = host(true);
    await second.emit('session_start', { reason: 'startup' });
    assert.equal(second.changes.length, 1);
    assert.notEqual(second.changes[0], child.changes[0], 'choose the least loaded selected model');
    const third = host(true);
    await third.emit('session_start', { reason: 'startup' });
    assert.equal(third.changes.length, 1, 'all busy models may be shared without waiting');
    assert.ok(['example/selected-a', 'example/selected-b'].includes(third.changes[0]));
    assert.equal(ordinary.ctx.model.id, 'manual');
    await child.emit('agent_settled', { aborted: false });
    await second.emit('agent_settled', { aborted: false });
    await third.emit('agent_settled', { aborted: false });
    updateSubagentConfig(dir, { enabled: false });
    await child.emit('before_agent_start', { messageType: 'user' });
    assert.equal(child.changes.length, 1, 'disabled preferences do not reassign');
  } finally {
    for (const h of instances) await h.emit('session_shutdown', { reason: 'quit' });
    if (saved.runtime === undefined) delete process.env.GENTLE_SUPERVISOR_RUNTIME_DIR;
    else process.env.GENTLE_SUPERVISOR_RUNTIME_DIR = saved.runtime;
    if (saved.child === undefined) delete process.env.GENTLE_PI_AGENTS_CHILD;
    else process.env.GENTLE_PI_AGENTS_CHILD = saved.child;
    rmSync(dir, { recursive: true, force: true });
  }
});
