import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { getActiveSubagentCandidateIds, loadSubagentConfig } from './subagent-config.ts';

/**
 * Child-side subagent model assignment.
 *
 * Gentle Agents children are separate Pi RPC processes. This adapter runs inside a marked
 * child (`GENTLE_PI_AGENTS_CHILD=1`, `ctx.mode === 'rpc'`) and reserves one model from the
 * operator's per-project Subagents list through the runtime pool, then applies it with the
 * public `pi.setModel` before the first request. It never touches the parent session, the
 * user's settings, provider quota, or any private runtime module.
 *
 * Failure policy: a missing/unusable config, registry or model, or a pool failure is
 * reported as a short non-sensitive diagnostic and the host keeps its current model. No
 * handler ever throws into the Orchestrator.
 *
 * The pool is `src/subagent-pool.ts` (owned by the sibling unit). It is imported lazily so
 * this module and its unit tests do not hard-depend on that file at load time; tests inject
 * `acquire`/`release` through the optional second argument to `registerSubagentAssignment`.
 */

export interface SubagentModelLease {
  token: string;
  modelId: string;
}

export interface SubagentPoolOwner {
  pid: number;
  sessionId: string;
}

export type AcquireSubagentModel = (cwd: string, candidateIds: string[], owner: SubagentPoolOwner) => SubagentModelLease;
export type ReleaseSubagentModel = (cwd: string, lease: SubagentModelLease, owner: SubagentPoolOwner) => void;

export interface SubagentAssignmentDeps {
  /** Test seam for the child marker. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Pool acquire override; when both are set the production import is never loaded. */
  acquire?: AcquireSubagentModel;
  /** Pool release override. */
  release?: ReleaseSubagentModel;
  /** Test seam for diagnostics. Defaults to `ctx.ui.notify`. */
  report?: (message: string, level?: 'info' | 'warning' | 'error') => void;
  /** Owner pid; defaults to `process.pid`. */
  pid?: number;
  /** Test deadline seam. Production catalogue readiness is bounded to 15 seconds. */
  refreshTimeoutMs?: number;
}

interface SubagentPool {
  acquire: AcquireSubagentModel;
  release: ReleaseSubagentModel;
}

interface ChildRuntime {
  sessionId: string;
  cwd: string;
  generation: number;
  disposed: boolean;
  /**
   * Set when the current turn released its lease (or a dispose did). A pending async
   * `setModel` must not claim an assignment once this is set.
   */
  releaseRequested: boolean;
  pool?: SubagentPool;
  lease?: SubagentModelLease;
  assigning?: Promise<void>;
  refreshing?: AbortController;
  reported?: Set<string>;
}

const CHILD_MARKER = 'GENTLE_PI_AGENTS_CHILD';

/** Fixed, non-sensitive diagnostics. No exception body, path or credential is ever echoed. */
const DIAGNOSTIC = {
  noSession: 'Subagent model assignment skipped: the child session identity is unavailable',
  poolUnavailable: 'Subagent model assignment skipped: the model pool is unavailable',
  acquireFailed: 'Subagent model assignment skipped: the model pool could not reserve a model',
  invalidLease: 'Subagent model assignment skipped: the model pool returned an unusable lease',
  unconfiguredModel: 'Subagent model assignment skipped: the model pool selected a model outside the configured slots',
  releaseFailed: 'Subagent model assignment cleanup failed for this lease',
  registryUnavailable: 'Subagent model assignment skipped: the model registry is unavailable',
  refreshFailed: 'Subagent model assignment skipped: the selected provider catalogue could not be refreshed',
  noEligibleModels: 'Subagent model assignment skipped: none of the configured models are available chat models',
  setModelRejected: 'Subagent model assignment skipped: the host did not accept the selected model',
  setModelFailed: 'Subagent model assignment skipped: the host rejected the selected model',
} as const;

/** Splits `<provider>/<modelId>` at the first slash; the model id keeps any later slashes. */
function splitCandidateId(id: string): { provider: string; modelId: string } | undefined {
  const separator = id.indexOf('/');
  if (separator <= 0) return undefined;
  const provider = id.slice(0, separator);
  const modelId = id.slice(separator + 1);
  if (!provider || !modelId) return undefined;
  return { provider, modelId };
}

function isChatModel(model: any): boolean {
  return Boolean(model) && (model.type === undefined || model.type === 'chat');
}

/**
 * Resolves the configured candidate IDs that this Pi session can actually run as chat
 * models. `getAvailable()` reflects configured credentials and is the eligibility source;
 * an older host without it falls back to `find()` per candidate. No model outside the
 * configured list is ever invented.
 */
function eligibleModels(registry: any, candidateIds: string[]): { id: string; model: any }[] {
  let available: any[] | undefined;
  try {
    const value = registry.getAvailable?.();
    if (Array.isArray(value)) available = value;
  } catch { available = undefined; }

  const eligible: { id: string; model: any }[] = [];
  for (const id of candidateIds) {
    const split = splitCandidateId(id);
    if (!split) continue;
    let model: any;
    if (available) {
      model = available.find(entry => entry && entry.provider === split.provider && entry.id === split.modelId);
    } else {
      try { model = registry.find?.(split.provider, split.modelId); } catch { model = undefined; }
    }
    if (!isChatModel(model)) continue;
    eligible.push({ id, model });
  }
  return eligible;
}

/**
 * Registers the child session adapter. Registers nothing when the child marker is absent,
 * so an ordinary parent or RPC session is never affected and never sees a fake hook.
 */
export function registerSubagentAssignment(pi: ExtensionAPI, deps: SubagentAssignmentDeps = {}): void {
  const marker = (): string | undefined => (deps.env ?? process.env)[CHILD_MARKER];
  if (marker() !== '1') return;

  const isChildContext = (ctx: any): boolean => marker() === '1' && ctx?.mode === 'rpc';
  const ownerPid = (): number => (Number.isInteger(deps.pid) ? (deps.pid as number) : process.pid);

  let runtime: ChildRuntime | undefined;
  let generationSeq = 0;

  const sessionIdOf = (ctx: any): string | undefined => {
    try {
      const id = ctx?.sessionManager?.getSessionId?.();
      return typeof id === 'string' && id ? id : undefined;
    } catch { return undefined; }
  };

  const report = (ctx: any, message: string, level: 'info' | 'warning' | 'error' = 'warning'): void => {
    if (deps.report) {
      try { deps.report(message, level); } catch { /* a diagnostic sink never breaks the adapter */ }
      return;
    }
    try { ctx?.ui?.notify?.(message, level); } catch { /* reporting never throws into the host */ }
  };

  const reportOnce = (r: ChildRuntime, ctx: any, message: string): void => {
    const seen = (r.reported ??= new Set<string>());
    if (seen.has(message)) return;
    seen.add(message);
    report(ctx, message);
  };

  const currentRuntime = (ctx: any): ChildRuntime | undefined => {
    const id = sessionIdOf(ctx);
    if (!runtime || runtime.disposed || !id || runtime.sessionId !== id || runtime.cwd !== ctx?.cwd) return undefined;
    return runtime;
  };

  const owner = (r: ChildRuntime): SubagentPoolOwner => ({ pid: ownerPid(), sessionId: r.sessionId });

  const resolvePool = async (): Promise<SubagentPool | undefined> => {
    if (deps.acquire && deps.release) return { acquire: deps.acquire, release: deps.release };
    try {
      const mod: any = await import('./subagent-pool.ts');
      const acquire = deps.acquire ?? mod.acquireSubagentModel;
      const release = deps.release ?? mod.releaseSubagentModel;
      if (typeof acquire !== 'function' || typeof release !== 'function') return undefined;
      return { acquire, release };
    } catch { return undefined; }
  };

  /** Releases a lease exactly as given. Ownership checks live in the pool. */
  const releaseLease = (r: ChildRuntime, ctx: any, lease: SubagentModelLease): void => {
    if (!r.pool) return;
    try { r.pool.release(r.cwd, lease, owner(r)); }
    catch { report(ctx, DIAGNOSTIC.releaseFailed); }
  };

  const releaseCurrentLease = (r: ChildRuntime, ctx: any): void => {
    const lease = r.lease;
    r.lease = undefined;
    if (lease) releaseLease(r, ctx, lease);
  };

  const disposeRuntime = (r: ChildRuntime, ctx: any): void => {
    r.disposed = true;
    r.generation++;
    r.releaseRequested = true;
    r.refreshing?.abort();
    releaseCurrentLease(r, ctx);
    // The disposed runtime stays as a tombstone: a later `before_agent_start` must not
    // re-initialize a session that already shut down. A real new session replaces it.
  };

  /** Await public provider readiness without overriding the host's network/offline policy. */
  const refreshCatalogue = async (r: ChildRuntime, registry: any, candidateIds: string[]): Promise<boolean> => {
    const controller = new AbortController();
    r.refreshing = controller;
    const providers = [...new Set(candidateIds.map(id => splitCandidateId(id)?.provider).filter(Boolean))];
    const timer = setTimeout(() => controller.abort(), deps.refreshTimeoutMs ?? 15_000);
    let onAbort!: () => void;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new Error('Catalogue readiness aborted'));
      controller.signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      // A provider ignoring AbortSignal must not hold the first request indefinitely.
      const result = await Promise.race([
        Promise.resolve().then(() => registry.refresh({ providers, signal: controller.signal })),
        aborted,
      ]);
      return !controller.signal.aborted && !result?.aborted &&
        !providers.some(provider => result?.errors?.has?.(provider));
    } catch { return false; }
    finally {
      clearTimeout(timer);
      controller.signal.removeEventListener('abort', onAbort);
      if (r.refreshing === controller) r.refreshing = undefined;
    }
  };

  /**
   * One allocation attempt: read the latest config, reserve an eligible model, apply it.
   * Re-checks its generation and the release flag at every async boundary, so a settle or
   * shutdown during `setModel` releases the lease and never records an obsolete claim.
   */
  const assignModel = async (r: ChildRuntime, ctx: any): Promise<void> => {
    const generation = r.generation;
    if (r.disposed || r.releaseRequested) return;

    // Configuration is read first: a disabled or empty slot list must never touch pool
    // storage, and must never be reported as a pool failure.
    const loaded = loadSubagentConfig(r.cwd);
    if (loaded.error) {
      reportOnce(r, ctx, `Subagent model assignment skipped: ${loaded.error}`);
      return;
    }
    if (!loaded.config.enabled) return;
    const candidateIds = getActiveSubagentCandidateIds(loaded.config);
    if (!candidateIds.length) return;

    const registry = ctx?.modelRegistry;
    if (!registry) { reportOnce(r, ctx, DIAGNOSTIC.registryUnavailable); return; }
    let eligible = eligibleModels(registry, candidateIds);
    if (eligible.length < candidateIds.length && typeof registry.refresh === 'function') {
      const refreshed = await refreshCatalogue(r, registry, candidateIds);
      if (r.releaseRequested || r.disposed || generation !== r.generation) return;
      if (!refreshed) { reportOnce(r, ctx, DIAGNOSTIC.refreshFailed); return; }
      eligible = eligibleModels(registry, candidateIds);
    }
    if (!eligible.length) { reportOnce(r, ctx, DIAGNOSTIC.noEligibleModels); return; }
    if (r.releaseRequested || r.disposed || generation !== r.generation) return;

    if (!r.pool) {
      const pool = await resolvePool();
      if (!pool) { reportOnce(r, ctx, DIAGNOSTIC.poolUnavailable); return; }
      if (r.disposed || generation !== r.generation) return;
      r.pool = pool;
    }
    if (r.releaseRequested) return;

    let lease: SubagentModelLease;
    try { lease = r.pool.acquire(r.cwd, eligible.map(entry => entry.id), owner(r)); }
    catch { reportOnce(r, ctx, DIAGNOSTIC.acquireFailed); return; }
    if (!lease || typeof lease.token !== 'string' || !lease.token || typeof lease.modelId !== 'string' || !lease.modelId) {
      reportOnce(r, ctx, DIAGNOSTIC.invalidLease);
      return;
    }
    const selected = eligible.find(entry => entry.id === lease.modelId);
    if (!selected) {
      releaseLease(r, ctx, lease);
      reportOnce(r, ctx, DIAGNOSTIC.unconfiguredModel);
      return;
    }
    if (r.disposed || r.releaseRequested || generation !== r.generation) { releaseLease(r, ctx, lease); return; }

    r.lease = lease;
    let applied: boolean;
    try {
      applied = await pi.setModel(selected.model);
    } catch {
      // Only the assignment that still owns the lease releases it; a settle/shutdown that
      // arrived during the await already released this same lease exactly once.
      if (r.lease === lease) releaseCurrentLease(r, ctx);
      reportOnce(r, ctx, DIAGNOSTIC.setModelFailed);
      return;
    }
    // A settle or shutdown during the await already released the lease: never claim it.
    if (r.disposed || r.releaseRequested || generation !== r.generation) {
      if (r.lease === lease) releaseCurrentLease(r, ctx);
      return;
    }
    if (!applied) {
      releaseCurrentLease(r, ctx);
      reportOnce(r, ctx, DIAGNOSTIC.setModelRejected);
    }
  };

  /** Runs one allocation and exposes it through `r.assigning` so concurrent callers await it. */
  const runAssignment = async (r: ChildRuntime, ctx: any): Promise<void> => {
    const task = assignModel(r, ctx);
    r.assigning = task;
    try { await task; } finally { if (r.assigning === task) r.assigning = undefined; }
  };

  const startSession = async (ctx: any): Promise<void> => {
    const id = sessionIdOf(ctx);
    if (!id) { report(ctx, DIAGNOSTIC.noSession); return; }
    const existing = runtime;
    if (existing && !existing.disposed && existing.sessionId === id && existing.cwd === ctx.cwd) {
      // Idempotent startup: adopt the in-flight or completed chain, never acquire again.
      if (existing.assigning) await existing.assigning;
      return;
    }
    if (existing) disposeRuntime(existing, ctx);
    const r: ChildRuntime = {
      sessionId: id,
      cwd: ctx.cwd,
      generation: ++generationSeq,
      disposed: false,
      releaseRequested: false,
    };
    runtime = r;
    const task = assignModel(r, ctx);
    r.assigning = task;
    try { await task; } finally { if (r.assigning === task) r.assigning = undefined; }
  };

  pi.on('session_start', async (_event, ctx) => {
    if (!isChildContext(ctx)) return;
    await startSession(ctx);
  });

  pi.on('before_agent_start', async (_event, ctx) => {
    if (!isChildContext(ctx)) return;
    const r = currentRuntime(ctx);
    if (!r) {
      // A disposed session must not silently re-initialize without a fresh session_start.
      if (runtime && runtime.disposed && sessionIdOf(ctx) === runtime.sessionId) return;
      // session_start always precedes a turn in a live child; this covers a missed or
      // out-of-order start without ever double-acquiring a running session.
      await startSession(ctx);
      return;
    }
    if (r.assigning) await r.assigning;
    const live = currentRuntime(ctx);
    if (!live || live !== r) return;
    // A live lease belongs to the current in-flight turn: keep it until agent_settled.
    if (r.lease) return;
    r.releaseRequested = false;
    await runAssignment(r, ctx);
  });

  // agent_end can still be followed by automatic continuations, so the lease is held. The
  // release boundary is agent_settled: Pi will not continue automatically after it.
  pi.on('agent_settled', (_event, ctx) => {
    if (!isChildContext(ctx)) return;
    const r = currentRuntime(ctx);
    if (!r) return;
    r.releaseRequested = true;
    r.refreshing?.abort();
    releaseCurrentLease(r, ctx);
  });

  pi.on('session_shutdown', (_event, ctx) => {
    if (!isChildContext(ctx)) return;
    const r = runtime;
    if (r && !r.disposed) disposeRuntime(r, ctx);
  });
}
