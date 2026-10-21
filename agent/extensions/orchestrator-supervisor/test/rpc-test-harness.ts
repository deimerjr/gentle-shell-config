import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { delimiter, dirname, join } from 'node:path';

function installedCli(): string {
  const require = createRequire(import.meta.url);
  for (const pkg of ['@earendil-works/pi-coding-agent', '@mariozechner/pi-coding-agent']) {
    try {
      const cli = join(dirname(require.resolve(pkg)), 'cli.js');
      if (existsSync(cli)) return cli;
    } catch { /* Try the next scoped installation. */ }
    // Standard npm PATH wrappers have their package under an adjacent node_modules.
    for (const directory of (process.env.PATH || '').split(delimiter).filter(Boolean)) {
      for (const modules of [join(directory, 'node_modules'), join(directory, '..', 'lib', 'node_modules')]) {
        const cli = join(modules, pkg, 'dist', 'cli.js');
        if (existsSync(cli)) return cli;
      }
    }
  }
  throw new Error('No installed Pi JS CLI found');
}

export function resolvePiLaunch(override = process.env.SUPERVISOR_TEST_PI_CLI, resolveInstalled = installedCli) {
  if (override) return /\.[cm]?js$/i.test(override)
    ? { command: process.execPath, args: [override] }
    : { command: override, args: [] as string[] };
  try { return { command: process.execPath, args: [resolveInstalled()] }; }
  catch (cause) {
    throw new Error('Pi RPC integration unavailable: set SUPERVISOR_TEST_PI_CLI to a JS CLI or native executable (no shell wrappers)', { cause });
  }
}

type Launch = { command: string; args: string[] };
type Options = { cwd: string; env: NodeJS.ProcessEnv; args: string[]; events?: any[]; onStderr?: (text: string) => void };
type Spawn = (command: string, args: string[], options: any) => ChildProcessWithoutNullStreams;

export function startRpc(launch: Launch, options: Options, spawnChild: Spawn = spawn) {
  const child = spawnChild(launch.command, [...launch.args, ...options.args], {
    cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'], shell: false,
  });
  let stderr = '', pending = '';
  let failure: Error | undefined;
  let exited = false;
  let ready = false;
  let result: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  const waiters = new Map<string, { resolve: (record: any) => void; reject: (error: Error) => void }>();
  // Resolve (never reject) terminal status so errors before state()/close() cannot be unhandled rejections.
  let settle!: () => void;
  const terminal = new Promise<void>(resolve => { settle = resolve; });
  const fail = (error: Error) => {
    failure ??= error;
    for (const waiter of waiters.values()) waiter.reject(failure);
    waiters.clear();
  };
  const exitError = () => new Error(`Pi exited before RPC response: ${result?.code}/${result?.signal}; ${stderr}`);
  child.once('error', error => { fail(error); settle(); });
  child.stdin.on('error', error => { fail(error); });
  child.once('exit', (code, signal) => {
    exited = true;
    result = { code, signal };
    fail(exitError());
  });
  child.once('close', (code, signal) => {
    exited = true;
    result = { code, signal };
    settle();
  });
  child.stderr.on('data', data => {
    const text = data.toString();
    stderr += text;
    options.onStderr?.(text);
  });
  child.stdout.on('data', data => {
    pending += data.toString();
    let at: number;
    while ((at = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, at).replace(/\r$/, '');
      pending = pending.slice(at + 1);
      let record: any;
      try { record = JSON.parse(line); } catch { continue; }
      options.events?.push(record);
      if (record.type === 'response' && record.id && waiters.has(record.id)) {
        waiters.get(record.id)!.resolve(record);
        waiters.delete(record.id);
      }
    }
  });
  let closing: Promise<void> | undefined;
  return {
    state: () => new Promise<any>((resolve, reject) => {
      if (failure) { reject(failure); return; }
      const timer = setTimeout(() => {
        const error = new Error(`Pi get_state timed out; ${stderr}`);
        fail(error);
        child.kill('SIGKILL');
      }, ready ? 6000 : 20000);
      waiters.set('state', {
        resolve: record => {
          clearTimeout(timer);
          if (record.success === true) ready = true;
          resolve(record);
        },
        reject: error => { clearTimeout(timer); reject(error); },
      });
      try { child.stdin.write(JSON.stringify({ id: 'state', type: 'get_state' }) + '\n'); }
      catch (error) { fail(error as Error); }
    }),
    close: () => closing ??= (async () => {
      const priorFailure = failure;
      if (!exited) {
        if (failure) child.kill('SIGKILL');
        else child.stdin.end();
      }
      const timer = setTimeout(() => child.kill('SIGKILL'), 4000);
      try {
        await terminal;
        if (priorFailure) throw priorFailure;
        if (!result || result.code !== 0 || result.signal !== null) {
          throw new Error(`Pi shutdown failed: ${result?.code}/${result?.signal}; ${stderr}`, { cause: failure });
        }
      } finally { clearTimeout(timer); }
    })(),
  };
}

export async function closeAll(children: Array<{ close: () => Promise<void> }>) {
  const results = await Promise.allSettled(children.map(async child => child.close()));
  const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
  if (errors.length) throw new AggregateError(errors, 'Pi RPC cleanup failed');
}
