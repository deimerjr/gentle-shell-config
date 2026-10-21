import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { randomUUID } from 'node:crypto';
import { SUPERVISOR_EXTENSION_NAME, computeFlowIdentity, isExtensionEnabled, resolveSupervisorDir } from './src/config.ts';
import { ContextGuard } from './src/context-guard.ts';
import { ErrorClassifier, type ClassificationAction } from './src/error-classifier.ts';
import { FlowJournal, isMutatingTool } from './src/journal.ts';
import { FlowLock } from './src/lock.ts';
import { QuotaManager } from './src/quota-manager.ts';
import { isSupervisorEnabled, loadSupervisorConfig, updateSupervisorConfig, getActiveCandidateIds, type SupervisorConfig } from './src/supervisor-config.ts';
import { assertWorkSettled, undeliverableTasks, verifiedCheckpoint } from './src/bridge.ts';
import { type SupervisorPanelState } from './src/supervisor-panel.ts';
import { createSupervisorDashboard } from './src/supervisor-dashboard.ts';
import { loadSubagentConfig, updateSubagentConfig } from './src/subagent-config.ts';
import { registerSubagentAssignment } from './src/subagent-assignment.ts';
import { isValidCandidateId } from './src/candidate-id.ts';
import { applyLiveSupervisorConfig } from './src/supervisor-live-config.ts';
import type { ModelCandidate, RegisteredModel, SupervisorSafetyFaultKind, SupervisorState } from './src/types.ts';

interface ReadyRotation {
  token: string;
  sessionId: string;
  checkpoint: { id: number; content: string };
  continueTask: boolean;
}

/**
 * `@earendil-works/pi-tui` is a host virtual module, not a dependency of this directory,
 * so it is loaded only when this host actually offers custom components. Failure keeps
 * the command working through its plain dialog instead of breaking the `/supervisor` panel.
 */
async function loadRoutingSelectorLib(): Promise<any | undefined> {
  try { return await import('@earendil-works/pi-tui'); } catch { return undefined; }
}

interface Runtime {
  /** Session-bound API: never reuse the outgoing factory API after replacement. */
  api: ExtensionAPI;
  sessionId: string;
  cwd: string;
  state: SupervisorState;
  journal: FlowJournal;
  lock: FlowLock;
  errors: ErrorClassifier;
  quotas: QuotaManager;
  guard: ContextGuard;
  /** Automatic rotation at the measured boundary; false leaves only the explicit command. */
  autoRotate: boolean;
  /** Automatic model assignment (startup, failover, provider recovery). */
  autoSwitchModel: boolean;
  timer?: ReturnType<typeof setInterval>;
  /** Interval the current timer was created with; panel edits compare against it. */
  pollMs: number;
  polling: boolean;
  inventoryReady: boolean;
  inventoryError?: string;
  inventoryRefresh?: Promise<void>;
  disposed: boolean;
  ready?: ReadyRotation;
  dispatched: boolean;
  checkpointPrompted: boolean;
  pendingAction?: ClassificationAction;
  pendingTurnTrigger?: boolean;
  modelRevision: number;
  applyingModel?: string;
  ctx: any;
}

// The host caches this module's factory, but invokes it for each new session.
// Key by the actual manager, not a session-id string, to avoid cross-session lookup.
const sessionRuntimes = new WeakMap<object, Runtime>();
const sessionId = (ctx: any) => ctx.sessionManager?.getSessionId?.();
// The environment opt-in gates loading; the persisted per-project flag gates acting.
// Both are re-read on every bind so a live toggle takes effect before the next handler.
const boundRuntime = (r: Runtime | undefined, ctx: any): Runtime | undefined => r && !r.disposed &&
  ctx.mode === 'tui' && r.sessionId === sessionId(ctx) && r.cwd === ctx.cwd &&
  (!ctx.isProjectTrusted || ctx.isProjectTrusted()) &&
  isExtensionEnabled(SUPERVISOR_EXTENSION_NAME, ctx.cwd) && isSupervisorEnabled(ctx.cwd) ? r : undefined;

/**
 * Host capabilities the suite injects explicitly. `@earendil-works/pi-tui` is a virtual
 * module resolved only by a live host, so `npm test` can never import it.
 */
export interface SupervisorHostOverrides {
  panelLib?: any;
}

export default function supervisor(pi: ExtensionAPI, overrides: SupervisorHostOverrides = {}): void {
  registerSubagentAssignment(pi);
  let runtime: Runtime | undefined;
  let switching = false;
  let preparing = false;
  let reportedConfigError: string | undefined;
  // Live enable/disable: a persisted flag turned off while this session runs tears the
  // runtime down before any handler can act, and turning it back on recreates the
  // runtime with its timer on the next interaction, without a reload.
  const bound = (ctx: any): Runtime | undefined => {
    if (runtime && !runtime.disposed && !isSupervisorEnabled(ctx.cwd)) teardownRuntime(ctx);
    if (!runtime || runtime.disposed) ensureRuntime(ctx);
    return boundRuntime(runtime, ctx);
  };
  const persist = (r: Runtime) => { r.state.updatedAt = Date.now(); r.journal.saveState(r.state); };
  /**
   * The only fences that stop a live runtime: interrupted mutation effects that a human has
   * not confirmed yet, and a real safety fault (credentials, handover, WAL). Manual pause and
   * cancel are gone, and legacy `userPaused`/`userCancelled` state never gates anything.
   */
  const halted = (r: Runtime) => r.state.uncertainMutationsCount > 0 || Boolean(r.state.safetyFault);
  const haltedMessage = (r: Runtime) => r.state.uncertainMutationsCount > 0
    ? 'Supervisor halted: interrupted mutation effects are unconfirmed. Inspect them, then switch the supervisor off and on in the configuration panel (/supervisor).'
    : `Supervisor halted by a ${r.state.safetyFault?.kind ?? 'safety'} fault. Resolve it, then switch the supervisor off and on in the configuration panel (/supervisor).`;
  const fault = (r: Runtime, kind: SupervisorSafetyFaultKind, message: string) => {
    r.state.safetyFault = { kind, message, at: Date.now() };
  };
  const notify = (ctx: any, message: string, level: 'info' | 'warning' | 'error' = 'info') => ctx.ui?.notify?.(message, level);
  const status = (r: Runtime, label: string) => r.ctx.ui?.setStatus?.('orchestrator-supervisor', `supervisor · ${label}`);
  const modelId = (ctx: any) => ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
  // "Habilitado entra al pool" (S3): the supervisor supervises exactly the models of the
  // saved routing slots. A model outside those slots is never managed, so a manual
  // selection is not silently hijacked by a failover.
  const selected = (r: Runtime, id?: string): boolean => {
    if (typeof id !== 'string' || !id) return false;
    try {
      if (r.quotas.getPriorityCandidateIds().includes(id)) return true;
      return r.quotas.isSelected(id);
    }
    catch { return false; }
  };
  const refreshCandidates = async (r: Runtime, ctx: any) => {
    // Commands, polling and turn-start share one discovery. No competing snapshots.
    if (r.inventoryRefresh) return r.inventoryRefresh;
    const refresh = (async () => {
      // The host registry needs no network: publish it first so the selector always
      // contains every model this Pi can run, even if account discovery later fails.
      if (runtime !== r || r.disposed) return;
      if (typeof ctx.modelRegistry?.refresh === 'function') {
        try { await ctx.modelRegistry.refresh({ providers: ['cliproxyapi'] }); }
        catch { /* Optional refresh failure */ }
      }
      try { r.quotas.setRegisteredModels(hostRegisteredModels(ctx)); }
      catch { /* No host catalogue available: account routes alone populate the pool. */ }
      try {
        await r.quotas.discoverCandidates(id => Boolean(ctx.modelRegistry?.find?.('cliproxyapi', id.slice('cliproxyapi/'.length))));
        if (runtime !== r || r.disposed) return;
        r.inventoryReady = true;
        r.inventoryError = undefined;
      } catch (error) {
        if (runtime === r && !r.disposed) r.inventoryError = inventoryFailure(error);
        throw error;
      }
    })();
    r.inventoryRefresh = refresh;
    try { await refresh; }
    finally { if (r.inventoryRefresh === refresh) r.inventoryRefresh = undefined; }
  };
  const refreshRecoveryCandidates = async (r: Runtime, ctx: any) => {
    try { await refreshCandidates(r, ctx); }
    catch (error) {
      // Management failure is not missing host authentication. Only explicitly selected
      // host routes without a quota protocol may recover without management inventory.
      if (!r.quotas.getCandidates().some(c => c.quotaProtocol === 'none' && selected(r, c.id))) throw error;
    }
  };
  const contextMetrics = (r: Runtime, ctx: any) => {
    const usage = ctx.getContextUsage?.();
    if (!usage) return undefined;
    const measured = Number.isFinite(usage.tokens) && usage.tokens >= 0;
    // Rotation and tool fences must share the same estimate when measured usage is absent.
    return r.guard.evaluateUsage(usage, modelId(ctx) || r.state.activeModel,
      measured ? undefined : r.guard.extractFallbackDetails(ctx));
  };
  const exceeded = (r: Runtime, ctx: any): boolean =>
    contextMetrics(r, ctx)?.isReserveExceeded ?? false;
  const cancelReady = (r: Runtime) => { r.ready = undefined; r.dispatched = false; };
  /**
   * Creates the session runtime once, driven by the persisted project configuration.
   * Returns undefined when the environment opt-out or the persisted flag disables the
   * supervisor, when the context is not an eligible interactive session, or when the
   * stored configuration cannot be trusted. A malformed file is reported once and treated
   * as disabled; it is never rewritten here. The configuration is loaded once per runtime
   * and drives the classifier, quota manager and context guard.
   */
  function ensureRuntime(ctx: any): Runtime | undefined {
    if (ctx.mode !== 'tui' || !sessionId(ctx) || (ctx.isProjectTrusted && !ctx.isProjectTrusted()) ||
        !isExtensionEnabled(SUPERVISOR_EXTENSION_NAME, ctx.cwd)) return undefined;
    const loaded = loadSupervisorConfig(ctx.cwd);
    // A runtime this process already started must not outlive its own control file (S7):
    // an out-of-band disable or an unusable file stops it now, on this call, instead of
    // staying alive until the next poll tick notices. Only this project's runtime is
    // touched, so a sibling project's runtime is never torn down by this decision.
    const stopOwnLiveRuntime = (): boolean => {
      if (!runtime || runtime.disposed || runtime.cwd !== ctx.cwd) return false;
      teardownRuntime(ctx);
      return true;
    };
    if (loaded.error) {
      stopOwnLiveRuntime();
      // One diagnostic per distinct failure; every later command still reports inactive.
      if (reportedConfigError !== loaded.error) {
        reportedConfigError = loaded.error;
        notify(ctx, `Supervisor disabled: ${loaded.error}`, 'warning');
      }
      return undefined;
    }
    reportedConfigError = undefined;
    if (!loaded.config.enabled) { stopOwnLiveRuntime(); return undefined; }
    if (runtime && !runtime.disposed) { runtime.ctx = ctx; return runtime; }
    let lock: FlowLock | undefined;
    try {
      const id = sessionId(ctx)!;
      const identity = computeFlowIdentity(ctx.cwd, id);
      const dir = resolveSupervisorDir(identity);
      lock = new FlowLock(dir, identity, id); lock.acquire({ enforceDistinctSession: true });
      const journal = new FlowJournal(dir, identity, id);
      const state: SupervisorState = journal.loadState() || { flowIdentity: identity, sessionId: id, activeModel: modelId(ctx) ?? '', status: 'active', activeGeneration: 1, uncertainMutationsCount: 0, updatedAt: Date.now() };
      if (state.flowIdentity !== identity || state.sessionId !== id) throw new Error('Invalid supervisor state identity');
      // Legacy manual pause/cancel flags no longer govern a live runtime: they are dropped
      // here, never trusted and never written back as a control. The files that carried
      // them stay untouched on disk.
      const legacy = state as unknown as Record<string, unknown>;
      delete legacy.userPaused; delete legacy.userCancelled;
      // A fresh runtime is running by definition: only durable `idle` (owed provider work)
      // survives a reload. Legacy pause/cancel statuses are display history, never control.
      if (state.status !== 'idle') state.status = 'active';
      journal.recoverOnStartup(); state.uncertainMutationsCount = journal.getUncertainEntries().length;
      const { config } = loaded;
      const errors = new ErrorClassifier(id, { maxTransientFailures: config.maxTransientFailures, cooldownMs: config.cooldownMinutes * 60_000 });
      // Automatic routing competes over exactly the saved slots the configuration exposes
      // (S3): the first `modelCount` entries, in order. An empty list routes nothing.
      const quotas = new QuotaManager({ codexQuotaThresholdPercent: config.codexQuotaThresholdPercent, priorityCandidateIds: getActiveCandidateIds(config) });
      const guard = new ContextGuard({ rotationThresholdPercent: config.rotationThresholdPercent });
      guard.setAutoRotate(config.autoRotate);
      const r: Runtime = { api: pi, sessionId: id, cwd: ctx.cwd, state, journal, lock, errors, quotas, guard, autoRotate: config.autoRotate, autoSwitchModel: config.autoSwitchModel, polling: false, inventoryReady: false, modelRevision: 0, disposed: false, dispatched: false, checkpointPrompted: false, pollMs: config.pollIntervalSeconds * 1000, ctx };
      reconcileDeliveries(r, ctx);
      runtime = r; persist(r);
      sessionRuntimes.set(ctx.sessionManager, r);
      status(r, state.safetyFault ? `halted: ${state.safetyFault.kind}` : state.uncertainMutationsCount ? 'uncertain effects' : 'active');
      if (state.uncertainMutationsCount) notify(ctx, 'Interrupted mutations detected. Inspect their effects, then confirm them by switching the supervisor off and on in the configuration panel (/supervisor). Read-only tools remain available.', 'warning');
      if (state.safetyFault) notify(ctx, `${haltedMessage(r)} (${state.safetyFault.message})`, 'warning');
      r.timer = setInterval(() => poll(r), config.pollIntervalSeconds * 1000); r.timer.unref();
      return r;
    } catch (error) { lock?.release(); notify(ctx, `Supervisor initialization failed: ${String(error)}`, 'error'); return undefined; }
  }

  /**
   * Live disable (S4/S7): stops the runtime immediately and leaves the project off until
   * the user enables it again. Cancels pending automatic work, persists the stopped state,
   * clears the status line and drops the session binding so every later command reports
   * inactive.
   */
  function teardownRuntime(ctx?: any): void {
    const r = runtime;
    runtime = undefined;
    if (r) {
      if (r.timer) { clearInterval(r.timer); r.timer = undefined; }
      cancelReady(r);
      r.state.owedProviderTurn = false;
      r.state.status = 'stopped';
      try { persist(r); } catch { /* Teardown must not fail on a persistence error. */ }
      try { sessionRuntimes.delete(r.ctx.sessionManager); } catch { /* Context may already be disposed. */ }
      try { r.lock.release(); } catch { /* Lock cleanup is best effort. */ }
      r.disposed = true;
      try { r.ctx?.ui?.setStatus?.(SUPERVISOR_EXTENSION_NAME, undefined); } catch { /* Stale context. */ }
    }
    try { ctx?.ui?.setStatus?.(SUPERVISOR_EXTENSION_NAME, undefined); } catch { /* Stale context. */ }
  }

  /**
   * Applies a stored configuration change to the runtime that is already running, so a panel
   * edit takes effect immediately instead of waiting for the next reload (S6).
   */
  const applyLiveConfig = (ctx: any, next: SupervisorConfig): void => {
    const live = boundRuntime(runtime, ctx);
    if (!live) return;
    applyLiveSupervisorConfig({
      quotas: live.quotas,
      guard: live.guard,
      errors: live.errors,
      // The capability switches live on the runtime; the guard adopts its own copy above.
      setAutoSwitchModel: (enabled: boolean) => { live.autoSwitchModel = enabled; },
      pollMs: live.pollMs,
      restartPollTimer: (intervalMs: number) => {
        if (live.timer) clearInterval(live.timer);
        live.timer = setInterval(() => poll(live), intervalMs);
        live.timer.unref();
        live.pollMs = intervalMs;
      },
    }, next);
  };

  /**
   * The catalogue the priority pickers offer. A live runtime answers from its own inventory
   * (one shared discovery). With the runtime off there is no manager to ask, so this builds
   * a throwaway one for the same discovery; a failed account lookup still leaves the host
   * registry models selectable, and no account route is invented.
   */
  async function panelCatalogue(ctx: any): Promise<{ candidates: ModelCandidate[]; discoveryFailed: boolean }> {
    const live = boundRuntime(runtime, ctx);
    if (live) {
      try { await refreshCandidates(live, ctx); } catch { /* Reported through inventoryError. */ }
      if (boundRuntime(runtime, ctx) === live) {
        return { candidates: live.quotas.getCandidates(), discoveryFailed: Boolean(live.inventoryError) };
      }
    }
    const loaded = loadSupervisorConfig(ctx.cwd);
    const probe = new QuotaManager({
      codexQuotaThresholdPercent: loaded.config.codexQuotaThresholdPercent,
      priorityCandidateIds: getActiveCandidateIds(loaded.config),
    });
    try { probe.setRegisteredModels(hostRegisteredModels(ctx)); } catch { /* Host catalogue unavailable. */ }
    let discoveryFailed = false;
    try {
      await probe.discoverCandidates(id => Boolean(ctx.modelRegistry?.find?.('cliproxyapi', id.slice('cliproxyapi/'.length))));
    } catch { discoveryFailed = true; }
    return { candidates: probe.getCandidates(), discoveryFailed };
  }

  /**
   * Uncertain mutation effects as recorded on disk, read without recovering or writing.
   * The panel must require explicit confirmation even while the runtime is off, so the
   * answer can never depend on a live runtime having loaded the journal first.
   */
  const persistedUncertain = (ctx: any): number => {
    const id = sessionId(ctx);
    if (!id) return 0;
    try {
      const identity = computeFlowIdentity(ctx.cwd, id);
      const journal = new FlowJournal(resolveSupervisorDir(identity), identity, id);
      // A pending mutation from a crashed session is interrupted exactly like an already
      // recovered one: both need the same confirmation before anything acts again.
      return journal.getEntries().filter(entry => entry.isMutating && entry.status !== 'settled').length;
    } catch {
      // Unreadable evidence never names a count; the runtime refuses the same file, so
      // nothing can route from it.
      return 0;
    }
  };

  /**
   * Read-only state for the panel's state section. It resolves the runtime at call time: the
   * panel stays open while the user switches the project on or off.
   */
  const panelState = (ctx: any): SupervisorPanelState => {
    const live = boundRuntime(runtime, ctx);
    const enabled = isSupervisorEnabled(ctx.cwd);
    if (!live) return { enabled, running: false, uncertain: persistedUncertain(ctx), activeModel: modelId(ctx) };
    let ids: string[] = [];
    try { ids = live.quotas.getCandidates().map(candidate => candidate.id); } catch { /* No inventory to report. */ }
    return {
      enabled,
      running: true,
      status: live.state.safetyFault ? `halted: ${live.state.safetyFault.kind}`
        : live.state.uncertainMutationsCount > 0 ? 'halted: uncertain effects' : live.state.status,
      activeModel: modelId(ctx) || live.state.activeModel,
      checkpoint: live.ready?.checkpoint.id,
      lastCheckpoint: live.state.lastCheckpointMemoryId,
      uncertain: live.state.uncertainMutationsCount,
      inventory: live.inventoryReady ? (ids.join(', ') || 'none') : 'not discovered yet',
      inventoryError: live.inventoryError,
    };
  };

  /**
   * Opens the configuration panel (S4, S6, S8). Deliberately independent from `bound()`: the
   * panel is how a project is switched back on, so it must open with the runtime off. It refuses
   * to open over an unusable config file instead of letting a UI surface rewrite one, and it
   * closes without writing when its session was replaced.
   */
  async function openSupervisorPanel(ctx: any): Promise<void> {
    const loaded = loadSupervisorConfig(ctx.cwd);
    if (loaded.error) {
      notify(ctx, `Supervisor panel unavailable: ${loaded.error}`, 'warning');
      return;
    }
    const lib = overrides.panelLib ?? await loadRoutingSelectorLib();
    if (!lib || typeof ctx.ui?.custom !== 'function') {
      notify(ctx, 'The configuration panel needs a host with custom components; this session cannot configure the supervisor.', 'warning');
      return;
    }
    const owner = sessionId(ctx);
    const current = (): boolean => {
      try {
        return ctx.mode === 'tui' && sessionId(ctx) === owner && (!ctx.isProjectTrusted || ctx.isProjectTrusted());
      } catch {
        // A replaced session's context throws on every access: close instead of writing.
        return false;
      }
    };
    const catalogue = await panelCatalogue(ctx);
    if (!current()) return;
    // Subagent preferences use the complete Pi registry, independently from account
    // discovery's one-model-per-account inventory and the Orchestrator's active slots.
    const subagents = loadSubagentConfig(ctx.cwd);
    const subagentCandidates: ModelCandidate[] = hostRegisteredModels(ctx)
      .filter(model => isValidCandidateId(`${model.provider}/${model.id}`))
      .map(model => ({
        id: `${model.provider}/${model.id}`,
        provider: model.provider,
        modelSlug: model.id,
        source: 'registered',
        quotaProtocol: 'none',
        reasoningEffort: 'high',
        contextWindowCap: model.contextWindow,
      }));
    try {
      await ctx.ui.custom((tui: any, theme: any, keybindings: any, done: () => void) => createSupervisorDashboard({ orchestrator: {
        lib,
        tui,
        theme,
        keybindings,
        config: loaded.config,
        state: () => panelState(ctx),
        candidates: catalogue.candidates,
        discoveryFailed: catalogue.discoveryFailed,
        isBound: current,
        applyConfig: (patch: Partial<SupervisorConfig>) => {
          const next = updateSupervisorConfig(ctx.cwd, patch);
          applyLiveConfig(ctx, next);
          return next;
        },
        onEnabledChange: (enabled: boolean, acknowledgeUncertain = false) => {
          // Switching off cancels pending automatic work now; switching on rebuilds the runtime.
          if (!enabled) { teardownRuntime(ctx); return; }
          const r = ensureRuntime(ctx);
          if (!r) return;
          // The exact callback contract: only the panel's explicit second confirmation may
          // acknowledge interrupted mutation effects. A reload never does this implicitly.
          if (acknowledgeUncertain) {
            r.journal.acknowledgeUncertainEntries();
            r.state.uncertainMutationsCount = 0;
          }
          // An explicit human enable is also the decision that clears a recorded safety fault,
          // so a credentials/handover/WAL stop is never a dead end now that pause is gone.
          r.state.safetyFault = undefined;
          r.state.status = 'active';
          r.state.owedProviderTurn = false; r.checkpointPrompted = false;
          persist(r);
          status(r, halted(r) ? 'halted: unconfirmed effects' : 'active');
        },
        onError: (message: string) => notify(ctx, message, 'warning'),
        done,
      }, subagents: {
        config: subagents.config,
        candidates: subagentCandidates,
        error: subagents.error,
        applyConfig: patch => {
          if (!current()) throw new Error('The supervisor panel session was replaced.');
          // Child assignment reads these preferences at its next allocation. Saving
          // them here never changes the parent runtime or model.
          return updateSubagentConfig(ctx.cwd, patch);
        },
      } }));
    } catch (error) {
      notify(ctx, `Supervisor panel failed: ${String(error)}`, 'error');
    }
  }

  // The host executes extension commands immediately, even while the agent streams
  // (`_tryExecuteExtensionCommand`), and `newSession` aborts the current run on teardown.
  // Dispatching here makes the handover instant instead of waiting for settlement.
  const dispatchHandover = (r: Runtime): void => {
    const ready = r.ready;
    if (!ready) return;
    r.dispatched = true;
    try { pi.sendUserMessage(`/supervisor-rotate ${ready.token}`, { expandPromptTemplates: true }); }
    catch (error) { r.dispatched = false; throw error; }
  };
  const hasPending = (r: Runtime) => r.journal.getEntries().some(e => e.status === 'pending' && e.isMutating);
  const reconcileDeliveries = (r: Runtime, ctx: any) => {
    if ((!r.state.pendingTaskDeliveries?.length && !r.state.pendingJobDeliveries?.length) || boundRuntime(r, ctx) !== r) return;
    let branch: any;
    try { branch = ctx.sessionManager.getBranch?.(); }
    catch { return; } // Missing history never proves delivery.
    if (!Array.isArray(branch)) return;
    const tasks = new Set<string>(), jobs = new Set<string>();
    for (const entry of branch) {
      if (entry?.type !== 'custom_message') continue;
      if (['gentle-agents.result', 'gentle-agents.stale-notice'].includes(entry.customType)) {
        const id = entry.details?.gentleAgents?.taskId;
        if (typeof id === 'string' && id) tasks.add(id);
      }
      if (entry.customType === 'gentle-jobs.notice' && ['exited', 'stopped', 'failed'].includes(entry.details?.gentleJobs?.status)) {
        const id = entry.details?.gentleJobs?.jobId;
        if (typeof id === 'string' && id) jobs.add(id);
      }
    }
    const pendingTaskDeliveries = r.state.pendingTaskDeliveries?.filter(id => !tasks.has(id));
    const pendingJobDeliveries = r.state.pendingJobDeliveries?.filter(id => !jobs.has(id));
    if (pendingTaskDeliveries?.length === r.state.pendingTaskDeliveries?.length &&
        pendingJobDeliveries?.length === r.state.pendingJobDeliveries?.length) return;
    const next = { ...r.state, pendingTaskDeliveries, pendingJobDeliveries, updatedAt: Date.now() };
    // Publish the reduced obligations only after their durable write succeeds.
    r.journal.saveState(next);
    r.state = next;
  };
  // A cancelled subagent can never deliver, so its obligation is retired from the host's own
  // status. Everything unverifiable stays owed: never retire on absence, and never on a job,
  // whose `stopped` status cannot be told apart from a queued stop notice.
  const retireUndeliverable = async (r: Runtime, ctx: any) => {
    const tasks = await undeliverableTasks(ctx, r.state.pendingTaskDeliveries ?? []);
    if (!tasks.size) return;
    const next = { ...r.state,
      pendingTaskDeliveries: r.state.pendingTaskDeliveries?.filter(id => !tasks.has(id)),
      updatedAt: Date.now() };
    // Publish the reduced obligations only after their durable write succeeds.
    r.journal.saveState(next);
    r.state = next;
  };
  const assertDeliveries = async (r: Runtime, ctx: any) => {
    reconcileDeliveries(r, ctx);
    if (r.state.pendingTaskDeliveries?.length || r.state.pendingJobDeliveries?.length) await retireUndeliverable(r, ctx);
    if (r.state.pendingTaskDeliveries?.length || r.state.pendingJobDeliveries?.length) {
      throw new Error('Rotation deferred: awaiting background completion delivery');
    }
  };
  const updateModel = async (r: Runtime, ctx: any, id: string): Promise<boolean> => {
    // Fail closed: with automatic switching off no caller may move the model either.
    if (!r.autoSwitchModel) return false;
    const candidate = r.quotas.getCandidates().find(c => c.id === id);
    if (!candidate || halted(r) || !r.quotas.isSelected(id)) return false;
    const modelSlug = id.slice(candidate.provider.length + 1);
    let model = ctx.modelRegistry?.find?.(candidate.provider, modelSlug);
    if (!model) {
      model = hostRegisteredModels(ctx).find(item => item.provider === candidate.provider && item.id === modelSlug);
    }
    if (!model && typeof ctx.modelRegistry?.refresh === 'function') {
      try {
        await ctx.modelRegistry.refresh({ providers: [candidate.provider] });
        model = ctx.modelRegistry.find?.(candidate.provider, modelSlug);
      } catch { /* Refresh error */ }
    }
    if (!model) { status(r, `model unavailable: ${id}`); return false; }
    const revision = r.modelRevision;
    r.applyingModel = id;
    let applied: boolean;
    try { applied = await pi.setModel(model); }
    finally { r.applyingModel = undefined; }
    if (!applied || runtime !== r || r.disposed || halted(r) || revision !== r.modelRevision) return false;
    r.state.activeModel = id as SupervisorState['activeModel'];
    pi.setThinkingLevel('high');
    persist(r);
    status(r, id);
    notify(ctx, `Supervisor switched to routing model ${id}.`);
    void sendNotification(`Model changed to ${id}`);
    return true;
  };
  const poll = async (r: Runtime) => {
    // Disabled mid-session: the timer must not act, and it is stopped by teardown.
    if (!isSupervisorEnabled(r.cwd)) { teardownRuntime(r.ctx); return; }
    // A reload reaches the poll with an empty catalogue, so slot membership cannot be decided
    // yet. An owed provider turn always discovers first; without debt the gate stays as before,
    // so a model outside the saved slots is still never polled for.
    if (r.polling || r.disposed || halted(r) || (!r.state.owedProviderTurn && !selected(r, modelId(r.ctx)))) return;
    r.polling = true;
    try {
      await refreshRecoveryCandidates(r, r.ctx);
      if (r.disposed || runtime !== r || halted(r)) return;
      if (!selected(r, modelId(r.ctx))) return;
      if (r.state.owedProviderTurn && r.autoSwitchModel && r.state.status === 'idle') {
        const revision = r.modelRevision;
        const best = await r.quotas.selectBestCandidate(r.errors.getCooldowns(), { forceFresh: true, excluded: r.errors.getExcludedCandidates() });
        if (!best.candidate || revision !== r.modelRevision || !r.state.owedProviderTurn || r.disposed || runtime !== r || halted(r) || !r.ctx.isIdle?.() || r.ready || preparing || hasPending(r)) return;
        if (!(await updateModel(r, r.ctx, best.candidate.id))) return;
        if (r.disposed || runtime !== r || halted(r) || !r.state.owedProviderTurn || !r.ctx.isIdle?.()) return;
        // Clear durable debt before dispatch; never periodically prompt completed work.
        r.state.owedProviderTurn = false; r.state.status = 'active'; persist(r);
        pi.sendMessage({ customType: 'supervisor-provider-recovery',
          content: providerRecoveryMessage,
          display: true, details: {} }, { triggerTurn: true });
        return;
      }
      // Inventory polling is observational unless a provider failure left work owed.
      // A restored higher-priority account never displaces a manual selection.
    } catch { if (!r.disposed) status(r, 'account/quota unavailable; current model unchanged'); }
    finally { r.polling = false; }
  };

  pi.registerCommand('supervisor', {
    description: 'Supervisor configuration: Orchestrator state, model slots and automation; Subagents enable, unique Pi model slots (2–20), saved JSON preferences and least-loaded model assignment in Gentle Agents RPC children.',
    handler: async (args, ctx) => {
      if (args.trim()) {
        // Exactly one human command exists. Anything else is a usage error, never a hidden alias.
        notify(ctx, 'Usage: /supervisor (opens the configuration panel). Only settings live there; rotation stays automatic or on explicit request.', 'warning');
        return;
      }
      await openSupervisorPanel(ctx);
    },
  });

  pi.registerCommand('supervisor-rotate', {
    description: 'Internal verified session handover; requires the pending supervisor token.',
    handler: async (token, ctx) => {
      const r = bound(ctx);
      if (r) reconcileDeliveries(r, ctx);
      const ready = r?.ready;
      if (!r || !ready || token.trim() !== ready.token || ready.sessionId !== sessionId(ctx) || halted(r) || hasPending(r) || r.state.pendingTaskDeliveries?.length || r.state.pendingJobDeliveries?.length) {
        notify(ctx, 'Rotation rejected: no matching verified handover.', 'warning'); return;
      }
      // The tool dispatches this command immediately, so the run is normally still streaming
      // here. newSession() aborts the current turn itself (teardownCurrent) and is safe to call.
      switching = true;
      let replacementContext: any;
      try {
        const parentSession = ctx.sessionManager.getSessionFile();
        // Plain values only: ctx and pi become invalid when newSession disposes this session.
        const outgoing = { provider: ctx.model?.provider, id: ctx.model?.id, thinking: pi.getThinkingLevel() };
        if (!outgoing.provider || !outgoing.id || !outgoing.thinking) throw new Error('Outgoing model or thinking level unavailable');
        const result = await ctx.newSession({
          parentSession,
          setup: async manager => { manager.appendCustomEntry('supervisor-checkpoint', { memoryId: ready.checkpoint.id, parentSession }); },
          withSession: async fresh => {
            replacementContext = fresh;
            if (!sessionId(fresh) || sessionId(fresh) === ready.sessionId) throw new Error('Session replacement did not change the session identity');
            // This callback belongs to the disposed outgoing factory instance.
            // Validate the incoming runtime, including the original trust guards.
            const next = boundRuntime(sessionRuntimes.get(fresh.sessionManager), fresh);
            if (!next || fresh.cwd !== r.cwd || halted(next) || hasPending(next) ||
                next.state.pendingTaskDeliveries?.length || next.state.pendingJobDeliveries?.length) {
              throw new Error('Replacement supervisor did not initialize safely');
            }
            // Continuity is an intentional transfer, not automatic slot routing. Restore even
            // with autoSwitchModel off, through the incoming factory's session-bound API.
            const api = next.api;
            const model = fresh.modelRegistry?.find?.(outgoing.provider, outgoing.id);
            if (!model || model.provider !== outgoing.provider || model.id !== outgoing.id ||
                typeof api.setModel !== 'function' || typeof api.setThinkingLevel !== 'function' ||
                typeof api.getThinkingLevel !== 'function') throw new Error('Continuity model restoration unavailable');
            const revision = next.modelRevision;
            const safe = () => boundRuntime(sessionRuntimes.get(fresh.sessionManager), fresh) === next &&
              next.modelRevision === revision && !halted(next) && !hasPending(next) &&
              !next.state.pendingTaskDeliveries?.length && !next.state.pendingJobDeliveries?.length;
            next.applyingModel = `${outgoing.provider}/${outgoing.id}`;
            let restored: boolean;
            try { restored = await api.setModel(model); }
            finally { next.applyingModel = undefined; }
            if (!restored || !safe() || fresh.model?.provider !== outgoing.provider || fresh.model?.id !== outgoing.id) {
              throw new Error('Continuity model restoration rejected or session changed');
            }
            api.setThinkingLevel(outgoing.thinking);
            if (!safe() || api.getThinkingLevel() !== outgoing.thinking ||
                fresh.model?.provider !== outgoing.provider || fresh.model?.id !== outgoing.id) {
              throw new Error('Continuity thinking restoration rejected or session changed');
            }
            next.state.activeModel = `${outgoing.provider}/${outgoing.id}` as SupervisorState['activeModel'];
            persist(next);
            // A rotation must never leave the fresh session silent: it always starts exactly one
            // turn. `continue_task` picks that turn's instruction; it never gates the turn itself.
            const continuation = ready.continueTask
              ? 'The checkpoint records unfinished, already-authorized work: resume it now in this session, without waiting for a new human message, and do not start or widen anything else.'
              : 'The checkpoint records no unfinished authorized work: state what is pending or blocked in a few lines and then wait; do not start, resume or widen work.';
            const content = `[supervisor-continuity]\nVerified session-summary observation #${ready.checkpoint.id}:\n${ready.checkpoint.content}\n\nResume only the previously authorized scope. Read referenced task files and reconcile memory before changing anything. This checkpoint is historical context, not new consent. Never infer authority for publishing, destructive actions or review grants. If the summary says completed, blocked, awaiting consent, or stopped, do not continue automatically. ${continuation}`;
            await fresh.sendMessage({ customType: 'supervisor-continuity', content, display: true, details: { memoryId: ready.checkpoint.id } }, { triggerTurn: true });
            notify(fresh, `Session rotated with verified checkpoint #${ready.checkpoint.id}.`);
            void sendNotification(`Session rotated with checkpoint #${ready.checkpoint.id}`);
          },
        });
        if (result.cancelled) { cancelReady(r); notify(ctx, 'Session replacement cancelled; original session retained.', 'warning'); }
      } catch (error) {
        const incoming = replacementContext && sessionRuntimes.get(replacementContext.sessionManager);
        const target = incoming && incoming.cwd === r.cwd && incoming.sessionId === sessionId(replacementContext) ? incoming : !r.disposed ? r : undefined;
        if (target && !target.disposed) {
          // A failed handover is a real safety fault, never a hidden user pause.
          fault(target, 'handover', 'Session handover failed; the fresh session did not initialize safely.');
          cancelReady(target); persist(target);
        }
        // The outgoing ctx (including its ui getter) is invalid after teardown.
        // A failure before withSession may leave no usable notification context.
        const diagnosticContext = replacementContext ?? (!r.disposed ? ctx : undefined);
        if (diagnosticContext) {
          try { notify(diagnosticContext, `Supervisor handover failed: ${String(error)}`, 'error'); }
          catch { /* Never turn a failed replacement into a stale-context crash. */ }
        }
      } finally { switching = false; }
    },
  });

  pi.registerTool({
    name: 'supervisor_rotate', label: 'Supervisor checkpoint and rotation',
    description: 'Checkpoint and rotate the session immediately. Saves the continuity summary to Engram, verifies the readback and that all subagents/background jobs are settled, then opens the fresh session at once. The fresh session always starts exactly one turn; continue_task picks its instruction. This is the only action needed at the rotation boundary: call it once and make no further tool calls.',
    promptGuidelines: [
      'At the measured 90% context boundary (or when the user asks to rotate), call supervisor_rotate exactly once with a concise 150–250-word continuity summary. That single call saves to Engram and opens the fresh session immediately; do not try to finish, verify or edit work first, and make no other tool calls in that turn.',
      'Include active goal and exact user limits, completed/pending work and checks, task-file pointers (not file contents), environment state, and next authorized step. Clearly state completed, blocked, stopped or awaiting consent when applicable.',
      'Set continue_task true only when there is unfinished work already authorized by the user: the fresh session always starts one turn, and with true that turn resumes that work immediately without waiting for a new human message; with false it reports the pending or blocked state and then waits. It grants no new authority. If jobs are active, the tool reports that concrete blocker instead of rotating; do not stop jobs just to rotate.',
    ],
    parameters: { type: 'object', additionalProperties: false, properties: {
      summary: { type: 'string', minLength: 1, maxLength: 12000 },
      memory_id: { type: 'integer', minimum: 1, description: 'An existing session_summary observation, as an alternative to summary.' },
      continue_task: { type: 'boolean', description: 'Continue only unfinished work already authorized. Default false.' },
      _: { type: 'boolean', description: 'Ignored. Accepted for compatibility with host prompt injections that include this field.' },
    } } as never,
    reachesTools: () => ['mem_save', 'mem_get_observation', 'subagent_list_tasks', 'job_list'],
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const r = bound(ctx);
      if (!r) throw new Error('Supervisor inactive; requires an interactive parent session');
      if (halted(r)) throw new Error(haltedMessage(r));
      if (preparing || r.ready) throw new Error('Supervisor checkpoint already in progress or scheduled');
      preparing = true;
      try {
        await assertWorkSettled(ctx);
        await assertDeliveries(r, ctx);
        if (hasPending(r)) throw new Error('Rotation deferred: unsettled mutation effects');
        const checkpoint = await verifiedCheckpoint(ctx, params as { summary?: string; memory_id?: number });
        // Catch jobs launched in a sibling tool call while memory was being saved.
        await assertWorkSettled(ctx);
        await assertDeliveries(r, ctx);
        if (runtime !== r || r.disposed || halted(r) || hasPending(r)) throw new Error('Session changed or has unsettled effects during checkpoint');
        r.ready = { token: randomUUID(), sessionId: r.sessionId, checkpoint, continueTask: (params as any).continue_task === true };
        r.state.lastCheckpointMemoryId = checkpoint.id; persist(r);
        // Open the fresh session now: the summary is already saved, so nothing else may run.
        dispatchHandover(r);
        return { content: [{ type: 'text', text: `Rotation scheduled with verified checkpoint #${checkpoint.id}; opening the fresh session now. Do not call any more tools.` }], details: { scheduled: true, memoryId: checkpoint.id, dispatched: true } };
      } finally { preparing = false; }
    },
  });

  pi.on('session_start', async (event, ctx) => {
    const alreadyRunning = Boolean(runtime && !runtime.disposed);
    const r = ensureRuntime(ctx);
    if (!r) { ctx.ui?.setStatus?.(SUPERVISOR_EXTENSION_NAME, undefined); return; }
    if (alreadyRunning) return;
    if (['startup', 'new'].includes(event.reason) && !halted(r)) {
      const revision = r.modelRevision;
      try {
        await refreshCandidates(r, ctx);
        // Only the saved slots authorize fresh-session selection. With an empty selection the
        // supervisor routes nothing, so Pi's initial or manual model is never hijacked.
        if (r.autoSwitchModel && r.quotas.getPriorityCandidateIds().length > 0 &&
            bound(ctx) === r && revision === r.modelRevision && !halted(r)) {
          const best = await r.quotas.selectBestCandidate(r.errors.getCooldowns(), { forceFresh: true, excluded: r.errors.getExcludedCandidates() });
          if (bound(ctx) !== r || revision !== r.modelRevision || halted(r)) return;
          if (!best.candidate) {
            status(r, 'startup routing unavailable; no eligible routing model; current model unchanged');
          } else if (best.candidate.id !== modelId(ctx)) {
            await updateModel(r, ctx, best.candidate.id);
          }
        }
      } catch { if (bound(ctx) === r) status(r, 'startup routing unavailable; current model unchanged'); }
    }
  });

  pi.on('before_agent_start', async (_event, ctx) => {
    const r = bound(ctx); if (!r) return;
    r.ctx = ctx; r.checkpointPrompted = false;
    // New user input supersedes any interrupted-response debt before asynchronous discovery.
    if ((_event as any).messageType === 'user' && r.state.owedProviderTurn) { r.state.owedProviderTurn = false; persist(r); }
    if ((_event as any).messageType === 'user') { r.pendingAction = undefined; r.modelRevision++; }
  });

  pi.on('model_select', (event, ctx) => {
    const r = bound(ctx); if (!r) return;
    const id = `${event.model.provider}/${event.model.id}`;
    if (r.applyingModel === id) return; // pi.setModel emits the same public event.
    r.modelRevision++;
    r.pendingAction = undefined;
    r.state.owedProviderTurn = false;
    if (selected(r, id)) r.state.activeModel = id as SupervisorState['activeModel'];
    if (r.state.status === 'idle') r.state.status = 'active';
    persist(r);
  });

  pi.on('tool_call', (event, ctx) => {
    const r = bound(ctx); if (!r) return;
    const name = event.toolName;
    // The new tool itself is orchestration-only; its nested mem_save is journaled separately.
    const mutating = name !== 'supervisor_rotate' && isMutatingTool(name, event.input);
    if (r.state.uncertainMutationsCount && mutating) return { block: true, reason: 'Uncertain prior effects: inspect them, then confirm by switching the supervisor off and on in the configuration panel (/supervisor).' };
    // Only new mutating effects are fenced while the verified handover runs. Read-only
    // verification stays available so the turn can settle instead of looping on blocks.
    if (r.ready && name !== 'supervisor_rotate' && isMutatingTool(name, event.input)) {
      return { block: true, reason: 'Verified rotation is scheduled; no new mutating effects until handover.' };
    }
    if (!halted(r) && name !== 'supervisor_rotate') {
      const metrics = contextMetrics(r, ctx);
      if (metrics?.isReserveExceeded) {
        const blocked = r.guard.interceptToolCall(event, metrics.tokens, metrics.contextWindow);
        if (blocked?.block) return { block: true, reason: blocked.reason };
      }
    }
    try {
      r.journal.recordToolCallPre({ toolCallId: event.toolCallId, parentToolCallId: event.parentToolCallId, sessionId: r.sessionId, turnIndex: 0, toolName: name, args: event.input, isMutating: mutating });
    } catch { return { block: true, reason: 'Supervisor WAL failed; tool execution blocked.' }; }
  });
  pi.on('tool_result', (event, ctx) => {
    const r = bound(ctx); if (!r) return;
    try {
      r.journal.recordToolCallResult(event.toolCallId, event.isError, { content: event.content, details: event.details });
      const details = event.details as any;
      if (!event.isError && ['subagent_run', 'subagent_continue'].includes(event.toolName) && details?.gentleAgents?.mode === 'background') {
        const id = details.gentleAgents.taskId;
        if (typeof id !== 'string' || !id) throw new Error('Missing background task identity');
        r.state.pendingTaskDeliveries = [...new Set([...(r.state.pendingTaskDeliveries ?? []), id])];
        persist(r);
      }
      if (!event.isError && ['bash_background', 'monitor'].includes(event.toolName)) {
        const id = details?.gentleJobs?.jobId;
        if (typeof id !== 'string' || !id) throw new Error('Missing background job identity');
        r.state.pendingJobDeliveries = [...new Set([...(r.state.pendingJobDeliveries ?? []), id])];
        persist(r);
      }
      if (!event.isError && event.toolName === 'job_stop' && typeof details?.gentleJobs?.jobId === 'string') {
        r.state.pendingJobDeliveries = r.state.pendingJobDeliveries?.filter(id => id !== details.gentleJobs.jobId);
        persist(r);
      }
    }
    // A WAL failure is a real safety fault: report it and stop acting until the human decides.
    catch { fault(r, 'wal', 'Tool journal write failed; effects may be unsaved.'); r.state.uncertainMutationsCount = Math.max(1, r.state.uncertainMutationsCount); status(r, 'WAL failure; halted'); }
  });
  pi.on('message_end', (event, ctx) => {
    const r = bound(ctx); if (!r) return;
    const message = event.message as any;
    if (['gentle-agents.result', 'gentle-agents.stale-notice'].includes(message?.customType)) {
      const id = message.details?.gentleAgents?.taskId;
      if (typeof id === 'string') { r.state.pendingTaskDeliveries = r.state.pendingTaskDeliveries?.filter(task => task !== id); persist(r); }
    }
    if (message?.customType === 'gentle-jobs.notice' && ['exited', 'stopped', 'failed'].includes(message.details?.gentleJobs?.status)) {
      const id = message.details.gentleJobs.jobId;
      if (typeof id === 'string') { r.state.pendingJobDeliveries = r.state.pendingJobDeliveries?.filter(job => job !== id); persist(r); }
    }
  });
  pi.on('turn_end', async (event, ctx) => {
    const r = bound(ctx); if (!r || halted(r)) return;
    const active = modelId(ctx) as SupervisorState['activeModel'];
    if (!active) return;
    const isSelectedModel = selected(r, active);
    // If neither selected nor configured with routing candidates, ignore unmanaged models.
    if (!isSelectedModel && (!r.autoSwitchModel || r.quotas.getPriorityCandidateIds().length === 0)) return;
    r.state.activeModel = active;
    if (event.message?.stopReason !== 'error') { r.state.owedProviderTurn = false; if (r.state.status === 'idle') r.state.status = 'active'; persist(r); }
    const action = r.errors.handleMessageEnd(event.message, active, { mode: ctx.mode, sessionId: r.sessionId });
    if (action.type === 'fatal_proxy_key') {
      // Rejected credentials are a genuine safety stop, not a user preference.
      fault(r, 'credentials', 'Provider credentials rejected; automatic and manual rotation stay halted.');
      persist(r); status(r, 'provider credentials rejected; halted');
      r.pendingAction = action;
      return;
    }
    if (action.type === 'ignored' || action.type === 'success') {
      r.pendingAction = undefined;
      return;
    }
    // An unselected manual model is only failed over when it reaches the 3-failure threshold
    if (!isSelectedModel && action.type !== 'cooldown_failover') {
      r.pendingAction = undefined;
      return;
    }
    r.pendingAction = action;
    // Pi's built-in retry runs before agent_before_settle. For explicit account quota
    // exhaustion, move its next request to an eligible route at this earlier boundary.
    // Do not add a continuation: the host still owns retry scheduling and error history.
    const explicitCooldown = /model_cooldown|individual quota reached/i.test(event.message?.errorMessage ?? '');
    if (action.type === 'immediate_failover' && action.isHardQuota && explicitCooldown &&
        isSelectedModel && r.autoSwitchModel) {
      const revision = r.modelRevision;
      r.state.owedProviderTurn = true; persist(r);
      try {
        await refreshRecoveryCandidates(r, ctx);
        const best = await r.quotas.selectBestCandidate(r.errors.getCooldowns(), { forceFresh: true, excluded: r.errors.getExcludedCandidates() });
        if (bound(ctx) !== r || revision !== r.modelRevision || halted(r) || ctx.signal?.aborted) return;
        if (best.candidate && await updateModel(r, ctx, best.candidate.id)) {
          r.pendingAction = undefined;
          r.state.owedProviderTurn = false; r.state.status = 'active'; persist(r);
        }
      } catch { /* Preserve the obligation for the settlement/polling recovery path. */ }
    }
  });
  pi.on('agent_before_settle', async (event, ctx) => {
    const r = bound(ctx); if (!r || halted(r) || event.outcome === 'aborted' || r.ready) return;
    if (r.autoRotate && exceeded(r, ctx) && !r.checkpointPrompted) {
      r.checkpointPrompted = true;
      return { entries: [{ type: 'custom_message', customType: 'supervisor-checkpoint-request', content: checkpointRequest, display: true, details: {} }], continue: true };
    }
    const action = r.pendingAction; r.pendingAction = undefined;
    if (!action) return;
    const revision = r.modelRevision;
    const recover = () => ({ entries: [{ type: 'custom_message' as const, customType: 'supervisor-provider-recovery', content: providerRecoveryMessage, display: true, details: {} }], continue: true });
    // A provider error ends on an assistant message, so canContinue is false.
    // Adding a recovery message makes the projected context continuable without
    // erasing error history or replaying any preceding tool calls.
    if (action.type === 'transient_retry') {
      await new Promise(resolve => setTimeout(resolve, action.retryDelayMs ?? 1000));
      if (bound(ctx) === r && revision === r.modelRevision && !halted(r) && !ctx.signal?.aborted) return recover();
    } else if (action.type === 'immediate_failover' || action.type === 'cooldown_failover') {
      r.state.owedProviderTurn = true; persist(r);
      if (!r.autoSwitchModel) {
        // The debt is durable on purpose: re-enabling the capability resumes it on the next
        // poll, and no recovery turn is fabricated on the route that just failed.
        r.state.status = 'idle'; persist(r); status(r, 'model autoswitch off; current model unchanged');
        return;
      }
      let best;
      try {
        await refreshRecoveryCandidates(r, ctx);
        best = await r.quotas.selectBestCandidate(r.errors.getCooldowns(), { forceFresh: true, excluded: r.errors.getExcludedCandidates() });
      } catch {
        if (bound(ctx) === r && revision === r.modelRevision && !halted(r)) {
          r.state.status = 'idle'; persist(r); status(r, 'account or routing slots unavailable; waiting');
        }
        return;
      }
      if (bound(ctx) !== r || revision !== r.modelRevision || halted(r) || ctx.signal?.aborted) return;
      try {
        if (best.candidate && await updateModel(r, ctx, best.candidate.id)) {
          r.state.owedProviderTurn = false;
          r.pendingTurnTrigger = true;
          r.state.status = 'active';
          persist(r);
          return recover();
        }
      } catch { /* The saved slots may change during discovery; leave recoverable debt. */ }
      if (bound(ctx) !== r || revision !== r.modelRevision || halted(r)) return;
      r.state.status = 'idle'; persist(r); status(r, 'no selected fallback; idle');
    }
  });
  pi.on('agent_settled', (event, ctx) => {
    const r = bound(ctx); if (!r) return;
    if (event.aborted) {
      r.pendingAction = undefined; r.pendingTurnTrigger = false; r.state.owedProviderTurn = false;
      const pendingHandover = Boolean(r.ready);
      cancelReady(r);
      // Stopping an agent response is never a request to halt the supervisor. Retire only
      // the interrupted work; preserve the uncertain-effect and safety-fault fences.
      if (!halted(r)) r.state.status = 'active';
      persist(r);
      status(r, halted(r) ? 'halted' : pendingHandover ? 'handover cancelled; active' : 'response interrupted; active');
      return;
    }
    if (r.pendingTurnTrigger && !halted(r)) {
      r.pendingTurnTrigger = false;
      r.state.owedProviderTurn = false;
      r.state.status = 'active';
      persist(r);
      pi.sendMessage({
        customType: 'supervisor-provider-recovery',
        content: providerRecoveryMessage,
        display: true,
        details: {},
      }, { triggerTurn: true });
    }
    reconcileDeliveries(r, ctx);
    if (!r.ready || r.dispatched || halted(r) || hasPending(r) || r.state.pendingTaskDeliveries?.length || r.state.pendingJobDeliveries?.length) return;
    r.dispatched = true;
    const token = r.ready.token;
    setImmediate(() => {
      if (runtime === r && !r.disposed && isSupervisorEnabled(r.cwd) && r.ready?.token === token && !halted(r) && !hasPending(r)) {
        try { dispatchHandover(r); }
        catch (error) { r.dispatched = false; status(r, `handover dispatch failed: ${String(error)}`); }
      }
    });
  });
  pi.on('session_before_switch', (_event, ctx) => {
    const r = bound(ctx); if (!r || switching) return;
    if (preparing || hasPending(r) || r.state.uncertainMutationsCount) return { cancel: true };
    // Never replay readiness into manually selected/new sessions.
    cancelReady(r);
  });
  pi.on('session_shutdown', (_event, ctx) => {
    if (runtime) {
      sessionRuntimes.delete(runtime.ctx.sessionManager);
      runtime.disposed = true; if (runtime.timer) clearInterval(runtime.timer); runtime.lock.release(); runtime = undefined;
    }
    ctx.ui?.setStatus?.('orchestrator-supervisor', undefined);
  });
}

const providerRecoveryMessage = 'Resume the response interrupted by a provider error, only within the already authorized task. Reconcile effects before executing tools; do not replay mutations or infer any new consent.';

/**
 * The host catalogue: every chat model this Pi session can actually run. `getAvailable()`
 * reflects configured credentials; when the host build exposes none (or predates it) the
 * full known list is used so the selector is never empty just because a build is older.
 * Unaddressable routes are dropped later by QuotaManager.setRegisteredModels.
 */
function hostRegisteredModels(ctx: any): RegisteredModel[] {
  const registry = ctx?.modelRegistry;
  if (!registry) return [];
  const read = (method: 'getAvailable' | 'getAll'): any[] => {
    try {
      const value = registry[method]?.();
      return Array.isArray(value) ? value : [];
    } catch { return []; }
  };
  const available = read('getAvailable');
  const models = available.length ? available : read('getAll');
  const seen = new Set<string>();
  const registered: RegisteredModel[] = [];
  for (const model of models) {
    if (!model || typeof model.provider !== 'string' || typeof model.id !== 'string' || !model.id) continue;
    // `getAll()` may include image/classifier entries; only chat models are routing targets.
    if (model.type !== undefined && model.type !== 'chat') continue;
    const id = `${model.provider}/${model.id}`;
    if (seen.has(id)) continue;
    seen.add(id);
    registered.push({
      provider: model.provider,
      id: model.id,
      contextWindow: Number.isFinite(model.contextWindow) ? model.contextWindow : undefined,
    });
  }
  return registered;
}

const checkpointRequest = 'Context reached the supervisor boundary or the user requested rotation. Call supervisor_rotate exactly once with a concise 150–250-word continuity summary: exact user goal and limits, completed/pending work and checks, task-file pointers, environment state, and next authorized action. That single call saves the summary to Engram and opens the fresh session immediately: make no other tool calls, and do not try to finish or verify pending work first. Set continue_task true only for unfinished already-authorized work; false for completed, stopped, blocked or awaiting-consent work. Either way the fresh session starts one turn immediately: true resumes that work without waiting for me; false makes it report what is pending or blocked and then wait. Do not rewrite tools, stop active jobs, publish, or invent consent. If the tool reports a concrete blocker, explain it and end the turn.';

function inventoryFailure(error: unknown): string {
  // Never print response bodies, credential values or arbitrary network error text.
  const allowed = new Set(['Account inventory unavailable', 'Unsupported account inventory',
    'Account model inventory unavailable', 'Unsupported account model inventory']);
  if (error instanceof Error && allowed.has(error.message)) return error.message;
  if (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)) return 'Account discovery timed out or was interrupted';
  return 'Account discovery failed; check management endpoint access and registered models';
}

async function sendNotification(body: string): Promise<void> {
  const endpoint = process.env.PI_NTFY_URL;
  if (!endpoint) return;
  try { await fetch(endpoint, { method: 'POST', body, headers: { Title: 'Gentle Shell supervisor' }, signal: AbortSignal.timeout(3000) }); } catch { /* Optional notifications never authorize or block work. */ }
}
