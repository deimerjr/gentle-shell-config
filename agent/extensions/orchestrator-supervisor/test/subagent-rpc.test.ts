import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { updateSubagentConfig, resolveSubagentConfigPath } from '../src/subagent-config.ts';
import { platform } from '../src/platform/index.ts';

const extensionPath = fileURLToPath(new URL('../index.ts', import.meta.url));
const providerPath = fileURLToPath(new URL('./fixtures/assignment-provider.ts', import.meta.url));
const provider = 'supervisor-assignment-test';

/** Real Pi RPC startup, with isolated settings and a registry-only offline provider. */
test('actual RPC children balance selected models before any provider request; other RPC sessions stay unchanged', { timeout: 25000 }, async () => {
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
      PATH: process.env.PATH,
      HOME: home, TMPDIR: join(root, 'tmp'),
      XDG_CONFIG_HOME: join(home, 'config'), XDG_CACHE_HOME: join(home, 'cache'), XDG_DATA_HOME: join(home, 'data'),
      PI_CODING_AGENT_DIR: agentDir, GENTLE_PI_AGENT_HOME: agentDir,
      GENTLE_SUPERVISOR_RUNTIME_DIR: runtime,
      PI_OFFLINE: '1', NO_COLOR: '1',
      NODE_COMPILE_CACHE: join(root, 'compile-cache'),
      ...(marked ? { GENTLE_PI_AGENTS_CHILD: '1' } : {}),
    };
    const child = spawn(process.env.SUPERVISOR_TEST_PI_CLI || platform.defaultPiCli(), [
      '--mode', 'rpc', '--offline', '--no-session', '--no-extensions',
      '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files', '--no-tools',
      '--extension', providerPath, '--extension', extensionPath,
      '--model', `${provider}/baseline`,
    ], { cwd: project, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let pending = '';
    const states = new Map<string, { resolve: (record: any) => void; reject: (error: Error) => void }>();
    let exited = false;
    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(res => {
      child.once('exit', (code, signal) => {
        exited = true;
        for (const waiter of states.values()) waiter.reject(new Error(`Pi exited before RPC response: ${code}/${signal}; ${stderr}`));
        states.clear();
        res({ code, signal });
      });
    });
    child.once('error', error => {
      for (const waiter of states.values()) waiter.reject(error);
      states.clear();
    });
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
        if (record.type === 'response' && record.id && states.has(record.id)) {
          states.get(record.id)!.resolve(record);
          states.delete(record.id);
        }
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
    children.push({ close });
    const response = await new Promise<any>((res, rej) => {
      const timer = setTimeout(() => {
        states.delete('state');
        child.kill('SIGKILL');
        rej(new Error(`Pi get_state timed out; ${stderr}`));
      }, 6000);
      states.set('state', {
        resolve: record => { clearTimeout(timer); res(record); },
        reject: error => { clearTimeout(timer); rej(error); },
      });
      child.stdin.write(JSON.stringify({ id: 'state', type: 'get_state' }) + '\n');
    });
    assert.equal(response.success, true, JSON.stringify(response));
    return { model: response.data.model.id as string, close };
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
      for (const child of children) await child.close();
    } finally {
      if (oldRuntime === undefined) delete process.env.GENTLE_SUPERVISOR_RUNTIME_DIR;
      else process.env.GENTLE_SUPERVISOR_RUNTIME_DIR = oldRuntime;
      rmSync(root, { recursive: true, force: true });
    }
  }
});
