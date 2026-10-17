import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { registerSubagentAssignment } from '../src/subagent-assignment.ts';
import { resolveSubagentConfigPath, updateSubagentConfig } from '../src/subagent-config.ts';

/**
 * The adapter is a child-side lifecycle hook: it never touches the parent runtime, never
 * calls a provider and never writes user settings. Every test therefore mocks the host
 * (Pi) surface and the pool, and points the per-project configuration at a private
 * `GENTLE_SUPERVISOR_RUNTIME_DIR`, exactly like the sibling subagent-config suite.
 */

const MODEL_A = { provider: 'cliproxyapi', id: 'main/gpt-6.1-sol', type: 'chat' };
const MODEL_B = { provider: 'openrouter', id: 'llama-3-70b', type: 'chat' };
const MODEL_IMAGE = { provider: 'openai', id: 'gpt-image-1', type: 'image' };

const ID_A = 'cliproxyapi/main/gpt-6.1-sol';
const ID_B = 'openrouter/llama-3-70b';
const ID_IMAGE = 'openai/gpt-image-1';

interface HarnessOptions {
  config?: { enabled: boolean; modelCount: number; priorityCandidateIds: string[] } | false;
  models?: any[];
  registry?: any;
  mode?: string;
  marker?: Record<string, string | undefined>;
  sessionId?: string;
  acquire?: (cwd: string, ids: string[], owner: any) => any;
  release?: (cwd: string, lease: any, owner: any) => void;
  setModelResult?: () => Promise<boolean>;
}

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'subagent-assignment-'));
  const previous = process.env.GENTLE_SUPERVISOR_RUNTIME_DIR;
  process.env.GENTLE_SUPERVISOR_RUNTIME_DIR = join(dir, 'runtime');
  const cwd = join(dir, 'project');
  mkdirSync(cwd, { recursive: true });
  return {
    dir,
    cwd,
    configPath: () => resolveSubagentConfigPath(cwd),
    configBytes: () => readFileSync(resolveSubagentConfigPath(cwd), 'utf8'),
    seedRaw: (text: string) => {
      const path = resolveSubagentConfigPath(cwd);
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(path, text);
    },
    close: () => {
      rmSync(dir, { recursive: true, force: true });
      if (previous === undefined) delete process.env.GENTLE_SUPERVISOR_RUNTIME_DIR;
      else process.env.GENTLE_SUPERVISOR_RUNTIME_DIR = previous;
    },
  };
}

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const REFRESH_FAILURE = 'Subagent model assignment skipped: the selected provider catalogue could not be refreshed';

function childHarness(options: HarnessOptions = {}) {
  const s = scratch();
  if (options.config !== false && options.config) updateSubagentConfig(s.cwd, options.config);
  const hooks = new Map<string, any>();
  const acquireCalls: any[] = [];
  const releaseCalls: any[] = [];
  const setModelCalls: any[] = [];
  const setThinkingCalls: any[] = [];
  const reports: any[] = [];
  const leases: any[] = [];
  const models = options.models ?? [MODEL_A, MODEL_B, MODEL_IMAGE];
  const registry = options.registry === undefined
    ? {
      getAvailable: () => models,
      find: (provider: string, id: string) => models.find(m => m.provider === provider && m.id === id),
    }
    : options.registry;
  const acquireImpl = options.acquire ?? ((_cwd: string, ids: string[]) => {
    const lease = { token: `token-${leases.length + 1}`, modelId: ids[0] };
    leases.push(lease);
    return lease;
  });
  const releaseImpl = options.release ?? (() => {});
  const ctx: any = {
    cwd: s.cwd,
    mode: options.mode ?? 'rpc',
    sessionManager: { getSessionId: () => options.sessionId ?? 'child-session' },
    modelRegistry: registry,
    ui: { notify: (...args: any[]) => reports.push(args) },
  };
  const pi: any = {
    on: (name: string, fn: any) => { hooks.set(name, fn); return () => {}; },
    setModel: async (model: any) => {
      setModelCalls.push(model);
      return options.setModelResult ? await options.setModelResult() : true;
    },
    setThinkingLevel: (...args: any[]) => { setThinkingCalls.push(args); },
  };
  const deps = {
    env: options.marker ?? { GENTLE_PI_AGENTS_CHILD: '1' },
    acquire: (cwd: string, ids: string[], owner: any) => {
      acquireCalls.push({ cwd, ids, owner });
      return acquireImpl(cwd, ids, owner);
    },
    release: (cwd: string, lease: any, owner: any) => {
      releaseCalls.push({ cwd, lease, owner });
      releaseImpl(cwd, lease, owner);
    },
    report: (...args: any[]) => reports.push(args),
    pid: 4242,
  };
  const h = {
    s,
    hooks,
    acquireCalls,
    releaseCalls,
    setModelCalls,
    setThinkingCalls,
    reports,
    leases,
    ctx,
    pi,
    deps,
    register: () => registerSubagentAssignment(pi, deps),
    fire: async (name: string, event: any = {}, c: any = ctx) => {
      const fn = hooks.get(name);
      if (fn) await fn(event, c);
    },
    start: () => h.fire('session_start', { reason: 'startup' }),
    settle: () => h.fire('agent_settled', { aborted: false }),
    shutdown: () => h.fire('session_shutdown', { reason: 'quit' }),
    beforeTurn: () => h.fire('before_agent_start', { messageType: 'user' }),
  };
  return h;
}

const config = (ids: string[], modelCount = ids.length || 5) => ({ enabled: true, modelCount: Math.max(2, modelCount), priorityCandidateIds: ids });

// ---------------------------------------------------------------------------
// Registration gates
// ---------------------------------------------------------------------------

test('SUBAGENT-ASSIGN-001 (S1, S4): without the child marker no hook is registered for the parent', () => {
  for (const marker of [{}, { GENTLE_PI_AGENTS_CHILD: '0' }, { GENTLE_PI_AGENTS_CHILD: 'true' }]) {
    const h = childHarness({ config: config([ID_A]), marker });
    try {
      h.register();
      assert.equal(h.hooks.size, 0, `marker ${JSON.stringify(marker)} must not register hooks`);
    } finally { h.s.close(); }
  }
});

test('SUBAGENT-ASSIGN-002 (S1, S4): a marked child registers only the four subagent lifecycle hooks, not agent_end', () => {
  const h = childHarness({ config: config([ID_A]) });
  try {
    h.register();
    assert.deepEqual([...h.hooks.keys()].sort(), ['agent_settled', 'before_agent_start', 'session_shutdown', 'session_start']);
    assert.equal(h.hooks.has('agent_end'), false, 'the lease must survive agent_end retries');
    assert.equal(h.hooks.has('model_select'), false);
  } finally { h.s.close(); }
});

test('SUBAGENT-ASSIGN-003 (S1, S4): a non-rpc context is ignored even in a marked child', async () => {
  for (const mode of ['tui', 'json', 'print']) {
    const h = childHarness({ config: config([ID_A]), mode });
    try {
      h.register();
      await h.start();
      await h.beforeTurn();
      assert.equal(h.acquireCalls.length, 0, `mode ${mode} must not assign`);
      assert.equal(h.setModelCalls.length, 0);
    } finally { h.s.close(); }
  }
});

// ---------------------------------------------------------------------------
// No-op configuration
// ---------------------------------------------------------------------------

test('SUBAGENT-ASSIGN-004 (S2, S4): disabled configuration performs no pool write and no model mutation', async () => {
  const h = childHarness({ config: { enabled: false, modelCount: 5, priorityCandidateIds: [ID_A] } });
  try {
    h.register();
    await h.start();
    await h.beforeTurn();
    assert.equal(h.acquireCalls.length, 0);
    assert.equal(h.releaseCalls.length, 0);
    assert.equal(h.setModelCalls.length, 0);
  } finally { h.s.close(); }
});

test('SUBAGENT-ASSIGN-005 (S2, S4): an enabled configuration with an empty active list is a no-op', async () => {
  const h = childHarness({ config: { enabled: true, modelCount: 5, priorityCandidateIds: [] } });
  try {
    h.register();
    await h.start();
    assert.equal(h.acquireCalls.length, 0);
    assert.equal(h.setModelCalls.length, 0);
  } finally { h.s.close(); }
});

// ---------------------------------------------------------------------------
// Delegation to the pool and setModel
// ---------------------------------------------------------------------------

test('SUBAGENT-ASSIGN-006 (S3): only the active configured slots are delegated, least-load pick wins', async () => {
  const hidden = 'anthropic/claude-hidden';
  const h = childHarness({ config: { enabled: true, modelCount: 2, priorityCandidateIds: [ID_A, ID_B, hidden] } });
  try {
    h.register();
    await h.start();
    assert.equal(h.acquireCalls.length, 1);
    assert.deepEqual(h.acquireCalls[0].ids, [ID_A, ID_B], 'only the first modelCount slots are delegated');
    assert.equal(h.setModelCalls.length, 1);
    assert.equal(h.setModelCalls[0], MODEL_A, 'the pool-selected model is applied');
  } finally { h.s.close(); }
});

test('SUBAGENT-ASSIGN-007 (S1, S4): the full provider/model split happens at the first slash', async () => {
  const registryFindCalls: any[] = [];
  const registry = {
    find: (provider: string, id: string) => {
      registryFindCalls.push([provider, id]);
      return provider === 'cliproxyapi' && id === 'main/gpt-6.1-sol' ? MODEL_A : undefined;
    },
  };
  const h = childHarness({ config: config([ID_A]), registry });
  try {
    h.register();
    await h.start();
    assert.deepEqual(registryFindCalls, [['cliproxyapi', 'main/gpt-6.1-sol']]);
    assert.equal(h.setModelCalls[0], MODEL_A);
  } finally { h.s.close(); }
});

test('SUBAGENT-ASSIGN-008 (S2, S4): setModel is awaited before the first request and the owner carries pid and session', async () => {
  const h = childHarness({ config: config([ID_A]) });
  try {
    h.register();
    const order: string[] = [];
    h.deps.acquire = (cwd: string, ids: string[], owner: any) => {
      order.push('acquire');
      h.acquireCalls.push({ cwd, ids, owner });
      return { token: 't1', modelId: ids[0] };
    };
    h.pi.setModel = async (model: any) => { order.push('setModel'); h.setModelCalls.push(model); return true; };
    await h.start();
    assert.deepEqual(order, ['acquire', 'setModel']);
    assert.deepEqual(h.acquireCalls[0].owner, { pid: 4242, sessionId: 'child-session' });
  } finally { h.s.close(); }
});

test('SUBAGENT-ASSIGN-009 (S2): a non-chat model is never eligible', async () => {
  const h = childHarness({ config: config([ID_IMAGE]), models: [MODEL_IMAGE] });
  try {
    h.register();
    await h.start();
    assert.equal(h.acquireCalls.length, 0);
    assert.equal(h.setModelCalls.length, 0);
    assert.ok(h.reports.some(args => /none of the configured models/.test(String(args[0]))));
  } finally { h.s.close(); }
});

test('SUBAGENT-ASSIGN-010 (S3): a pool pick outside the configured slots is released and never applied', async () => {
  const h = childHarness({
    config: config([ID_A]),
    acquire: () => ({ token: 't1', modelId: ID_B }),
  });
  try {
    h.register();
    await h.start();
    assert.equal(h.setModelCalls.length, 0);
    assert.equal(h.releaseCalls.length, 1);
    assert.equal(h.releaseCalls[0].lease.modelId, ID_B);
  } finally { h.s.close(); }
});

// ---------------------------------------------------------------------------
// Failure paths stay honest, non-sensitive and non-throwing
// ---------------------------------------------------------------------------

test('SUBAGENT-ASSIGN-011 (S2, S4): setModel false releases the lease and keeps the host model', async () => {
  const h = childHarness({ config: config([ID_A]), setModelResult: async () => false });
  try {
    h.register();
    await h.start();
    assert.equal(h.setModelCalls.length, 1);
    assert.equal(h.releaseCalls.length, 1);
    assert.equal(h.releaseCalls[0].lease.token, 'token-1');
    assert.ok(h.reports.some(args => /did not accept the selected model/.test(String(args[0]))));
  } finally { h.s.close(); }
});

test('SUBAGENT-ASSIGN-012 (S2, S4): setModel throwing releases the lease, never rethrows and never leaks the body', async () => {
  const h = childHarness({
    config: config([ID_A]),
    setModelResult: async () => { throw new Error('provider rejected request api-key=SECRET123'); },
  });
  try {
    h.register();
    await h.start();
    assert.equal(h.releaseCalls.length, 1);
    const text = h.reports.map(args => String(args[0])).join('\n');
    assert.ok(!text.includes('SECRET123'), 'exception bodies must never be reported');
    assert.ok(/host rejected the selected model/.test(text));
  } finally { h.s.close(); }
});

test('SUBAGENT-ASSIGN-013 (S4): a pool failure is reported as a safe diagnostic and never thrown', async () => {
  const h = childHarness({
    config: config([ID_A]),
    acquire: () => { throw new Error('locked storage api-key=SECRET123'); },
  });
  try {
    h.register();
    await h.start();
    await h.beforeTurn();
    assert.equal(h.setModelCalls.length, 0);
    const text = h.reports.map(args => String(args[0])).join('\n');
    assert.ok(!text.includes('SECRET123'));
    assert.ok(/model pool could not reserve/.test(text));
  } finally { h.s.close(); }
});

test('SUBAGENT-ASSIGN-014 (S2, S4): a missing registry fails honestly without any pool or model write', async () => {
  const h = childHarness({ config: config([ID_A]), registry: null });
  try {
    h.register();
    await h.start();
    assert.equal(h.acquireCalls.length, 0);
    assert.equal(h.setModelCalls.length, 0);
    assert.ok(h.reports.some(args => /model registry is unavailable/.test(String(args[0]))));
  } finally { h.s.close(); }
});

test('SUBAGENT-ASSIGN-015 (S2, S4): configured models absent from getAvailable fail honestly', async () => {
  const h = childHarness({ config: config([ID_B]), models: [MODEL_A] });
  try {
    h.register();
    await h.start();
    assert.equal(h.acquireCalls.length, 0);
    assert.equal(h.setModelCalls.length, 0);
    assert.ok(h.reports.some(args => /none of the configured models/.test(String(args[0]))));
  } finally { h.s.close(); }
});

test('SUBAGENT-ASSIGN-016 (S2, S4): an unusable config is reported, never repaired and never written', async () => {
  const h = childHarness({ config: false });
  try {
    const malformed = '{"enabled": true, "priorityCandidateIds": "not-an-array"}';
    h.s.seedRaw(malformed);
    const before = h.s.configBytes();
    h.register();
    await h.start();
    assert.equal(h.acquireCalls.length, 0);
    assert.equal(h.setModelCalls.length, 0);
    assert.equal(h.s.configBytes(), before, 'the unusable file must be left byte-identical');
    assert.deepEqual(readdirSync(dirname(h.s.configPath())), ['subagents.json'], 'no pool or lock file is written');
    assert.ok(h.reports.some(args => /Malformed subagent configuration/.test(String(args[0]))));
  } finally { h.s.close(); }
});

test('SUBAGENT-ASSIGN-017 (S2, S4): invalid lease payloads are rejected before setModel', async () => {
  for (const bad of [undefined, {}, { token: '', modelId: ID_A }, { token: 't', modelId: '' }]) {
    const h = childHarness({ config: config([ID_A]), acquire: () => bad as any });
    try {
      h.register();
      await h.start();
      assert.equal(h.setModelCalls.length, 0, `lease ${JSON.stringify(bad)} must not be applied`);
    } finally { h.s.close(); }
  }
});

// ---------------------------------------------------------------------------
// Idempotent startup and race guards
// ---------------------------------------------------------------------------

test('SUBAGENT-ASSIGN-018 (S4): a repeated session_start never acquires twice', async () => {
  const h = childHarness({ config: config([ID_A]) });
  try {
    h.register();
    await h.start();
    await h.start();
    assert.equal(h.acquireCalls.length, 1);
    assert.equal(h.setModelCalls.length, 1);
  } finally { h.s.close(); }
});

test('SUBAGENT-ASSIGN-019 (S4): concurrent startup converges on a single assignment', async () => {
  const h = childHarness({ config: config([ID_A]) });
  try {
    h.register();
    await Promise.all([h.start(), h.start(), h.beforeTurn()]);
    assert.equal(h.acquireCalls.length, 1);
    assert.equal(h.setModelCalls.length, 1);
  } finally { h.s.close(); }
});

// ---------------------------------------------------------------------------
// Release and reacquisition
// ---------------------------------------------------------------------------

test('SUBAGENT-ASSIGN-020 (S4): agent_settled releases the held lease exactly once and agent_end does nothing', async () => {
  const h = childHarness({ config: config([ID_A]) });
  try {
    h.register();
    await h.start();
    assert.equal(h.releaseCalls.length, 0);
    await h.fire('agent_end', { stopReason: 'stop' });
    assert.equal(h.releaseCalls.length, 0, 'agent_end must not release the in-flight lease');
    await h.settle();
    assert.equal(h.releaseCalls.length, 1);
    await h.settle();
    assert.equal(h.releaseCalls.length, 1, 'release is idempotent once no lease is held');
  } finally { h.s.close(); }
});

test('SUBAGENT-ASSIGN-021 (S4): session_shutdown releases the lease and disposes the adapter', async () => {
  const h = childHarness({ config: config([ID_A]) });
  try {
    h.register();
    await h.start();
    await h.shutdown();
    assert.equal(h.releaseCalls.length, 1);
    await h.beforeTurn();
    assert.equal(h.acquireCalls.length, 1, 'a disposed adapter never reassigns');
  } finally { h.s.close(); }
});

test('SUBAGENT-ASSIGN-022 (S4): the next turn reacquires after the previous turn released', async () => {
  const h = childHarness({ config: config([ID_A]) });
  try {
    h.register();
    await h.start();
    await h.settle();
    assert.equal(h.releaseCalls.length, 1);
    await h.beforeTurn();
    assert.equal(h.acquireCalls.length, 2);
    assert.equal(h.setModelCalls.length, 2);
    assert.equal(h.releaseCalls.length, 1, 'reacquisition does not release the new lease');
  } finally { h.s.close(); }
});

test('SUBAGENT-ASSIGN-023 (S2, S4): configuration changes apply only at the next turn allocation', async () => {
  const h = childHarness({ config: { enabled: true, modelCount: 2, priorityCandidateIds: [ID_A] } });
  try {
    h.register();
    await h.start();
    assert.deepEqual(h.acquireCalls.at(-1)!.ids, [ID_A]);
    updateSubagentConfig(h.s.cwd, { priorityCandidateIds: [ID_B], modelCount: 2 });
    await h.beforeTurn();
    assert.deepEqual(h.acquireCalls.at(-1)!.ids, [ID_A], 'the live lease keeps its own turn');
    await h.settle();
    await h.beforeTurn();
    assert.deepEqual(h.acquireCalls.at(-1)!.ids, [ID_B], 'the next allocation reads the latest config');
  } finally { h.s.close(); }
});

// ---------------------------------------------------------------------------
// Pending setModel races
// ---------------------------------------------------------------------------

test('SUBAGENT-ASSIGN-024 (S4): settle while setModel is pending releases without an obsolete claim', async () => {
  let resolveSet!: (value: boolean) => void;
  let first = true;
  const h = childHarness({ config: config([ID_A]) });
  try {
    h.register();
    h.pi.setModel = async (model: any) => {
      h.setModelCalls.push(model);
      if (first) { first = false; return await new Promise<boolean>(resolve => { resolveSet = resolve; }); }
      return true;
    };
    const start = h.start();
    await tick();
    assert.equal(h.acquireCalls.length, 1);
    assert.equal(h.setModelCalls.length, 1);
    await h.settle();
    assert.equal(h.releaseCalls.length, 1, 'the pending lease is released immediately');
    resolveSet(true);
    await start;
    assert.equal(h.releaseCalls.length, 1, 'no second release after the pending setModel resolves');
    await h.beforeTurn();
    assert.equal(h.acquireCalls.length, 2, 'the fixed turn reacquires instead of keeping an obsolete claim');
    assert.equal(h.setModelCalls.length, 2);
  } finally { h.s.close(); }
});

test('SUBAGENT-ASSIGN-025 (S4): shutdown while setModel is pending releases the lease and never reassigns', async () => {
  let resolveSet!: (value: boolean) => void;
  const h = childHarness({ config: config([ID_A]), setModelResult: () => new Promise<boolean>(resolve => { resolveSet = resolve; }) });
  try {
    h.register();
    const start = h.start();
    await tick();
    await h.shutdown();
    assert.equal(h.releaseCalls.length, 1);
    resolveSet(true);
    await start;
    assert.equal(h.releaseCalls.length, 1);
    assert.equal(h.setModelCalls.length, 1);
    await h.beforeTurn();
    assert.equal(h.acquireCalls.length, 1);
  } finally { h.s.close(); }
});

test('SUBAGENT-ASSIGN-026 (S4): a dispose during async pool resolution never acquires', async () => {
  // The injected acquire is only reachable through the async resolve step, so shutdown
  // has a real window to dispose the runtime before any lease exists.
  const h = childHarness({ config: config([ID_A]) });
  try {
    h.register();
    const start = h.start();
    await h.shutdown();
    await start;
    assert.equal(h.acquireCalls.length, 0);
    assert.equal(h.setModelCalls.length, 0);
  } finally { h.s.close(); }
});

// ---------------------------------------------------------------------------
// Boundary: no unrequested changes
// ---------------------------------------------------------------------------

test('SUBAGENT-ASSIGN-027 (S1, S4): the adapter never calls setThinkingLevel and never mutates the environment', async () => {
  const h = childHarness({ config: config([ID_A]) });
  try {
    const envBefore = JSON.stringify(process.env.GENTLE_PI_AGENTS_CHILD ?? null);
    h.register();
    await h.start();
    await h.settle();
    assert.deepEqual(h.setThinkingCalls, []);
    assert.equal(JSON.stringify(process.env.GENTLE_PI_AGENTS_CHILD ?? null), envBefore, 'the adapter never writes the marker env');
  } finally { h.s.close(); }
});

test('SUBAGENT-ASSIGN-028 (S3): empty slot placeholders are skipped when delegating the active slots', async () => {
  const h = childHarness({ config: { enabled: true, modelCount: 3, priorityCandidateIds: [ID_A, '', ID_B] } });
  try {
    h.register();
    await h.start();
    assert.deepEqual(h.acquireCalls[0].ids, [ID_A, ID_B], 'empty placeholders are not model identities');
  } finally { h.s.close(); }
});

test('SUBAGENT-ASSIGN-030 (S5): startup awaits selected-provider readiness before reserving or applying', async () => {
  let ready!: () => void;
  let published: any[] = [];
  const calls: any[] = [];
  const registry = {
    getAvailable: () => published,
    refresh: async (options: any) => {
      calls.push(options);
      await new Promise<void>(resolve => { ready = resolve; });
      published = [MODEL_A, MODEL_B];
      return { aborted: false, errors: new Map() };
    },
  };
  const h = childHarness({ config: config([ID_A, ID_B]), registry });
  try {
    h.register();
    const bytes = h.s.configBytes();
    const start = h.start();
    const firstTurn = h.beforeTurn();
    await tick();
    assert.equal(calls.length, 1, 'startup and first turn share the readiness attempt');
    assert.deepEqual(calls[0].providers, ['cliproxyapi', 'openrouter']);
    assert.deepEqual(Object.keys(calls[0]).sort(), ['providers', 'signal'], 'do not override host offline/network policy');
    assert.ok(calls[0].signal instanceof AbortSignal);
    assert.equal(h.acquireCalls.length, 0);
    assert.equal(h.setModelCalls.length, 0);
    ready();
    await Promise.all([start, firstTurn]);
    assert.deepEqual(h.acquireCalls.map(call => call.ids), [[ID_A, ID_B]]);
    assert.deepEqual(h.setModelCalls, [MODEL_A]);
    assert.deepEqual(h.reports, []);
    assert.equal(h.s.configBytes(), bytes);
    await h.beforeTurn();
    assert.equal(calls.length, 1, 'live lease does not refresh or switch mid-turn');
    await h.settle();
    await h.beforeTurn();
    assert.equal(calls.length, 1, 'already available selections need no refresh');
    assert.equal(h.acquireCalls.length, 2);
  } finally { await h.shutdown(); h.s.close(); }
});

test('SUBAGENT-ASSIGN-031 (S4, S5): parent, non-RPC, disabled and empty settings never refresh', async () => {
  for (const options of [
    { marker: {} }, { mode: 'tui' },
    { config: { enabled: false, modelCount: 2, priorityCandidateIds: [ID_A] } },
    { config: config([]) },
  ]) {
    let refreshes = 0;
    const h = childHarness({ config: config([ID_A]), ...options, registry: {
      getAvailable: () => [], refresh: async () => { refreshes++; },
    } });
    try {
      h.register(); await h.start(); await h.beforeTurn();
      assert.equal(refreshes, 0);
      assert.equal(h.acquireCalls.length, 0);
      assert.equal(h.setModelCalls.length, 0);
      assert.deepEqual(h.reports, []);
    } finally { h.s.close(); }
  }
});

test('SUBAGENT-ASSIGN-032 (S5): failed catalogue refresh reports safely without pool writes or settings changes', async () => {
  for (const result of ['throw', 'errors', 'aborted']) {
    const h = childHarness({ config: config([ID_A]), registry: {
      getAvailable: () => [],
      refresh: async () => {
        if (result === 'throw') throw new Error('secret=SECRET123');
        return { aborted: result === 'aborted', errors: new Map(result === 'errors' ? [['cliproxyapi', new Error('SECRET123')]] : []) };
      },
    } });
    try {
      h.register(); const bytes = h.s.configBytes(); await h.start();
      assert.deepEqual(h.reports, [[REFRESH_FAILURE, 'warning']]);
      assert.equal(h.acquireCalls.length, 0);
      assert.equal(h.setModelCalls.length, 0);
      assert.equal(h.s.configBytes(), bytes);
      assert.deepEqual(readdirSync(dirname(h.s.configPath())), ['subagents.json']);
    } finally { h.s.close(); }
  }
});

test('SUBAGENT-ASSIGN-033 (S5): refresh never substitutes find() for authenticated availability', async () => {
  const calls: any[] = [];
  const h = childHarness({ config: config([ID_A]), registry: {
    getAvailable: () => [], find: () => { throw new Error('must not bypass available snapshot'); },
    refresh: async (options: any) => { calls.push(options); return { aborted: false, errors: new Map() }; },
  } });
  try {
    h.register(); await h.start();
    assert.equal(calls.length, 1);
    assert.equal(Object.hasOwn(calls[0], 'allowNetwork'), false);
    assert.equal(h.acquireCalls.length, 0);
    assert.equal(h.setModelCalls.length, 0);
    assert.deepEqual(h.reports, [['Subagent model assignment skipped: none of the configured models are available chat models', 'warning']]);
  } finally { h.s.close(); }
});

test('SUBAGENT-ASSIGN-034 (S4, S5): settle or shutdown aborts readiness and late refresh cannot assign', async () => {
  for (const event of ['agent_settled', 'session_shutdown']) {
    let finish!: () => void;
    let signal!: AbortSignal;
    let available: any[] = [];
    const h = childHarness({ config: config([ID_A]), registry: {
      getAvailable: () => available,
      refresh: async (options: any) => {
        signal = options.signal;
        await new Promise<void>(resolve => { finish = resolve; });
        available = [MODEL_A];
        return { aborted: false, errors: new Map() };
      },
    } });
    try {
      h.register(); const start = h.start(); await tick();
      assert.ok(signal instanceof AbortSignal);
      await h.fire(event);
      await start;
      assert.equal(signal.aborted, true);
      finish(); await tick();
      assert.equal(h.acquireCalls.length, 0);
      assert.equal(h.setModelCalls.length, 0);
      assert.deepEqual(h.reports, [], 'normal lifecycle cancellation is not a provider failure');
      if (event === 'agent_settled') {
        await h.beforeTurn();
        assert.equal(h.acquireCalls.length, 1, 'a fresh turn can allocate after cancellation');
      }
    } finally { await h.shutdown(); h.s.close(); }
  }
});

test('SUBAGENT-ASSIGN-035 (S5): ignored abort cannot leave startup waiting forever', async () => {
  let signal!: AbortSignal;
  const h = childHarness({ config: config([ID_A]), registry: {
    getAvailable: () => [],
    refresh: (options: any) => { signal = options.signal; return new Promise(() => {}); },
  } });
  try {
    (h.deps as any).refreshTimeoutMs = 15;
    h.register(); await h.start();
    assert.ok(signal instanceof AbortSignal);
    assert.equal(signal.aborted, true);
    assert.deepEqual(h.reports, [[REFRESH_FAILURE, 'warning']]);
    assert.equal(h.acquireCalls.length, 0);
    assert.equal(h.setModelCalls.length, 0);
  } finally { h.s.close(); }
});

test('SUBAGENT-ASSIGN-029 (S2, S4): a disabled configuration never touches the pool module', async () => {
  // Without injected pool deps the adapter would attempt the production import; a
  // disabled feature must short-circuit before that, so no pool diagnostic can appear.
  const h = childHarness({ config: { enabled: false, modelCount: 5, priorityCandidateIds: [ID_A] } });
  try {
    delete (h.deps as any).acquire;
    delete (h.deps as any).release;
    h.register();
    await h.start();
    assert.deepEqual(h.reports, [], 'a disabled feature reports nothing and loads no pool');
  } finally { h.s.close(); }
});
