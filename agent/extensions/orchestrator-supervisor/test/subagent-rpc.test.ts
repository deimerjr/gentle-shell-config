import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { updateSubagentConfig, resolveSubagentConfigPath } from '../src/subagent-config.ts';
import { closeAll, resolvePiLaunch, startRpc } from './rpc-test-harness.ts';

const extensionPath = fileURLToPath(new URL('../index.ts', import.meta.url));
const providerPath = fileURLToPath(new URL('./fixtures/assignment-provider.ts', import.meta.url));
const provider = 'supervisor-assignment-test';

/** Real Pi RPC startup, with isolated settings and a registry-only offline provider. */
// Five sequential startups (20s each) + five shutdowns (4s each) + 10s margin.
test('actual RPC children balance selected models before any provider request; other RPC sessions stay unchanged', { timeout: 130000 }, async () => {
  const launch = resolvePiLaunch();
  const root = mkdtempSync(resolve('.tmp-assignment-rpc-'));
  const home = join(root, 'home');
  const project = join(root, 'project');
  const agentDir = join(home, 'agent');
  const runtime = join(root, 'runtime');
  for (const path of [home, project, agentDir, join(root, 'tmp')]) mkdirSync(path, { recursive: true });
  const oldRuntime = process.env.GENTLE_SUPERVISOR_RUNTIME_DIR;
  process.env.GENTLE_SUPERVISOR_RUNTIME_DIR = runtime;
  const children: Array<{ close: () => Promise<void> }> = [];
  const events: any[] = [];
  let stderr = '';
  const start = async (marked: boolean) => {
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
      HOME: home, USERPROFILE: home, APPDATA: join(home, 'config'), LOCALAPPDATA: join(home, 'cache'),
      TMPDIR: join(root, 'tmp'), TEMP: join(root, 'tmp'), TMP: join(root, 'tmp'),
      XDG_CONFIG_HOME: join(home, 'config'), XDG_CACHE_HOME: join(home, 'cache'), XDG_DATA_HOME: join(home, 'data'),
      PI_CODING_AGENT_DIR: agentDir, GENTLE_PI_AGENT_HOME: agentDir,
      GENTLE_SUPERVISOR_RUNTIME_DIR: runtime,
      PI_OFFLINE: '1', NO_COLOR: '1',
      NODE_COMPILE_CACHE: join(root, 'compile-cache'),
      ...(marked ? { GENTLE_PI_AGENTS_CHILD: '1' } : {}),
    };
    const child = startRpc(launch, { args: [
      '--mode', 'rpc', '--offline', '--no-session', '--no-extensions',
      '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files', '--no-mcp', '--no-tools',
      '--extension', providerPath, '--extension', extensionPath,
      '--model', `${provider}/baseline`,
    ], cwd: project, env, events, onStderr: text => { stderr += text; } });
    children.push(child);
    const response = await child.state();
    assert.equal(response.success, true, JSON.stringify(response));
    return { model: response.data.model.id as string, close: child.close };
  };
  try {
    updateSubagentConfig(project, {
      enabled: true, modelCount: 3,
      priorityCandidateIds: ['', `${provider}/alpha`, `${provider}/beta`, `${provider}/baseline`],
    });
    const configPath = resolveSubagentConfigPath(project);
    const configBefore = readFileSync(configPath, 'utf8');
    const ordinary = await start(false);
    assert.equal(ordinary.model, 'baseline', 'ordinary RPC must retain its configured model');
    const poolPath = join(dirname(configPath), 'subagent-pool.json');
    assert.equal(existsSync(poolPath), false, 'ordinary RPC must not create assignment state');
    const first = await start(true);
    assert.ok(['alpha', 'beta'].includes(first.model), `first child selected ${first.model}; ${stderr}`);
    const second = await start(true);
    assert.ok(['alpha', 'beta'].includes(second.model));
    assert.notEqual(first.model, second.model, 'the second child uses the less-loaded model');
    const third = await start(true);
    assert.ok(['alpha', 'beta'].includes(third.model), 'sharing is allowed when all selected models are busy');
    assert.equal(readFileSync(configPath, 'utf8'), configBefore, 'assignment never rewrites panel settings');
    await first.close();
    await second.close();
    await third.close();
    updateSubagentConfig(project, { enabled: false });
    const disabled = await start(true);
    assert.equal(disabled.model, 'baseline', 'disabled assignment retains existing model');
    assert.ok(!events.some(event => event.type === 'message_start' || event.type === 'agent_start'), 'no model request was sent');
    assert.doesNotMatch(stderr, /failed to load extension|error loading extension/i);
  } finally {
    try {
      await closeAll(children);
    } finally {
      if (oldRuntime === undefined) delete process.env.GENTLE_SUPERVISOR_RUNTIME_DIR;
      else process.env.GENTLE_SUPERVISOR_RUNTIME_DIR = oldRuntime;
      rmSync(root, { recursive: true, force: true });
    }
  }
});
