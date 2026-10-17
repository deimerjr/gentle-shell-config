import test from 'node:test';
import assert from 'node:assert/strict';
import { MockCpamcServer } from './fixtures/mock-cpamc.ts';
import { QuotaManager } from '../src/quota-manager.ts';

/**
 * Automatic routing is driven only by the saved slot list the configuration exposes
 * (S3): the first `modelCount` saved entries compete, in order, and nothing else does.
 * There is no routing-preference file and no computed-order fallback any more.
 */

const MAIN = 'cliproxyapi/main/gpt-6.1-sol';
const SECOND = 'cliproxyapi/second/gpt-6.1-sol';
const GEMINI = 'cliproxyapi/gemini-account/gemini-3.8-flash-high';
const HOST = 'anthropic/claude-sonnet-4-5';

async function manager(options: Record<string, unknown> = {}) {
  const server = new MockCpamcServer();
  const baseUrl = await server.start();
  const quotas = new QuotaManager({ baseUrl, retryDelayMs: 10, ...options });
  await quotas.discoverCandidates(() => true);
  return { quotas, server, close: () => server.stop() };
}

test('PRIORITY-001: the saved order wins and routes outside the slots never compete', async () => {
  const { quotas, server, close } = await manager();
  try {
    // The computed order puts main first; the saved slots ask for gemini first.
    quotas.setPriorityCandidateIds([GEMINI, MAIN]);
    assert.equal((await quotas.selectBestCandidate()).candidate.id, GEMINI);

    // With gemini exhausted the second slot is used.
    server.options.geminiRemainingFraction = 0;
    quotas.clearCache();
    assert.equal((await quotas.selectBestCandidate()).candidate.id, MAIN);

    // `second` is eligible the whole time but is not a slot, so it is never selected.
    server.options.mainWhamUsedPercentPrimary = 96;
    quotas.clearCache();
    const exhausted = await quotas.selectBestCandidate();
    assert.equal(exhausted.candidate, null);
    assert.equal(exhausted.allUnavailable, true);
    assert.equal(exhausted.reason, 'all_candidates_unavailable');
  } finally { await close(); }
});

test('PRIORITY-002: a route without verified quota never jumps ahead of an available verified account', async () => {
  const { quotas, server, close } = await manager();
  try {
    quotas.setRegisteredModels([{ provider: 'anthropic', id: 'claude-sonnet-4-5' }]);
    quotas.setPriorityCandidateIds([HOST, MAIN]);

    // Slot 1 is unverified; the verified account sits in slot 2 and is available.
    assert.equal((await quotas.selectBestCandidate()).candidate.id, MAIN);

    // Once the verified account is exhausted the guard has nothing to protect.
    server.options.mainWhamUsedPercentPrimary = 96;
    quotas.clearCache();
    assert.equal((await quotas.selectBestCandidate()).candidate.id, HOST);
  } finally { await close(); }
});

test('PRIORITY-003: an empty selection routes nothing, while the catalogue keeps every route', async () => {
  const { quotas, close } = await manager();
  try {
    quotas.setRegisteredModels([{ provider: 'anthropic', id: 'claude-sonnet-4-5' }]);
    assert.deepEqual(quotas.getPriorityCandidateIds(), []);
    assert.deepEqual(quotas.effectiveRoutingOrder(), []);

    const selection = await quotas.selectBestCandidate();
    assert.equal(selection.candidate, null);
    assert.equal(selection.allUnavailable, true);
    assert.equal(quotas.isSelected(MAIN), false);
    assert.equal(quotas.isSelected(HOST), false);

    // The routes stay in the catalogue: they are still shown and can be selected again.
    const ids = quotas.getCandidates().map(candidate => candidate.id);
    assert.ok(ids.includes(MAIN), JSON.stringify(ids));
    assert.ok(ids.includes(HOST), JSON.stringify(ids));
  } finally { await close(); }
});

test('PRIORITY-004: the saved list is stored verbatim: deduped, never truncated, undiscovered routes kept', async () => {
  const { quotas, close } = await manager();
  try {
    quotas.setPriorityCandidateIds([MAIN, MAIN, 'not/discovered-yet']);
    assert.deepEqual(quotas.getPriorityCandidateIds(), [MAIN, 'not/discovered-yet']);
    // An undeliverable slot is skipped, not fatal: the rest of the order still routes.
    assert.equal((await quotas.selectBestCandidate()).candidate.id, MAIN);

    // modelCount caps the selection at ten, so the manager must never truncate on its own.
    const long = Array.from({ length: 12 }, (_, index) => `a/${index + 1}`);
    quotas.setPriorityCandidateIds(long);
    assert.deepEqual(quotas.getPriorityCandidateIds(), long);

    quotas.setPriorityCandidateIds([SECOND]);
    assert.equal((await quotas.selectBestCandidate()).candidate.id, SECOND);
  } finally { await close(); }
});

test('PRIORITY-005: the codex quota threshold is configurable and named in the diagnostic', async () => {
  const configured = await manager({ codexQuotaThresholdPercent: 80 });
  try {
    configured.quotas.setPriorityCandidateIds([MAIN, SECOND]);
    configured.server.options.mainWhamUsedPercentPrimary = 85;
    configured.quotas.clearCache();
    assert.equal((await configured.quotas.selectBestCandidate()).candidate.id, SECOND);

    const main = configured.quotas.getCandidates().find(candidate => candidate.id === MAIN)!;
    const status = await configured.quotas.checkCandidateStatus(main);
    assert.equal(status.isEligible, false);
    assert.match(status.reason, /primary_window_ineligible \(>= 80% policy threshold: 85%\)/);
  } finally { await configured.close(); }

  // Previous behavior holds: without the option the documented 95% policy still applies.
  const fallback = await manager();
  try {
    fallback.quotas.setPriorityCandidateIds([MAIN, SECOND]);
    fallback.server.options.mainWhamUsedPercentPrimary = 85;
    fallback.quotas.clearCache();
    assert.equal((await fallback.quotas.selectBestCandidate()).candidate.id, MAIN);

    const main = fallback.quotas.getCandidates().find(candidate => candidate.id === MAIN)!;
    fallback.server.options.mainWhamUsedPercentPrimary = 96;
    fallback.quotas.clearCache();
    const status = await fallback.quotas.checkCandidateStatus(main);
    assert.match(status.reason, />= 95% policy threshold/);
  } finally { await fallback.close(); }
});

test('PRIORITY-006: recovery looks at higher-priority slots, not the whole catalogue', async () => {
  const { quotas, server, close } = await manager();
  try {
    quotas.setPriorityCandidateIds([GEMINI, MAIN]);
    // main is the running candidate and gemini is its only higher-priority slot.
    server.options.geminiRemainingFraction = 0.5;
    quotas.clearCache();
    const recovery = await quotas.checkResetReturn(MAIN);
    assert.equal(recovery.shouldReturn, true);
    assert.equal(recovery.targetCandidate?.id, GEMINI);
    assert.equal(recovery.reason, 'higher_priority_account_available');

    // A catalogue route outside the slots is not a recovery target any more.
    quotas.setPriorityCandidateIds([MAIN]);
    quotas.clearCache();
    const none = await quotas.checkResetReturn(MAIN);
    assert.equal(none.shouldReturn, false);
  } finally { await close(); }
});

test('PRIORITY-007: a live QuotaManager adopts a codex quota threshold changed from the panel', async () => {
  const { quotas, server, close } = await manager({ codexQuotaThresholdPercent: 95 });
  try {
    quotas.setPriorityCandidateIds([MAIN, SECOND]);
    server.options.mainWhamUsedPercentPrimary = 85;
    quotas.clearCache();
    assert.equal((await quotas.selectBestCandidate()).candidate.id, MAIN);

    // The panel lowers the threshold; eligibility changes without a reload.
    quotas.setCodexQuotaThresholdPercent(80);
    quotas.clearCache();
    assert.equal((await quotas.selectBestCandidate()).candidate.id, SECOND);
  } finally { await close(); }
});

test('PRIORITY-008: a route is selected only through the saved slots, never by catalogue position', async () => {
  const { quotas, server, close } = await manager();
  try {
    quotas.setRegisteredModels([{ provider: 'anthropic', id: 'claude-sonnet-4-5' }]);
    quotas.setPriorityCandidateIds([SECOND, HOST]);
    assert.equal(quotas.isSelected(SECOND), true);
    assert.equal(quotas.isSelected(HOST), true);
    assert.equal(quotas.isSelected(MAIN), false, 'an available catalogue route outside the slots is not selected');
    assert.equal((await quotas.selectBestCandidate()).candidate.id, SECOND);

    // Exhausted verified slots yield to the host model that is also a saved slot.
    server.options.secondWhamUsedPercentPrimary = 99;
    assert.equal((await quotas.selectBestCandidate()).candidate.id, HOST);

    // Clearing the saved list stops every automatic route without deleting the catalogue.
    quotas.setPriorityCandidateIds([]);
    assert.equal(quotas.isSelected(SECOND), false);
    assert.equal(quotas.isSelected(HOST), false);
    assert.equal((await quotas.selectBestCandidate()).allUnavailable, true);
  } finally { await close(); }
});

test('PRIORITY-009: a model is selected only when the Pi registry can address it', async () => {
  const { quotas, close } = await manager();
  try {
    quotas.setRegisteredModels([
      { provider: 'anthropic', id: 'claude-sonnet-4-5' },
      { provider: 'bad provider', id: 'nope' },
      { provider: 'imagen', id: '' },
    ]);
    quotas.setPriorityCandidateIds(['anthropic/claude-sonnet-4-5', 'bad provider/nope', 'imagen/']);
    // Slots naming unaddressable routes stay saved (an outage must not erase the order)
    // but can never become a selected model.
    assert.equal(quotas.getPriorityCandidateIds().length, 3);
    assert.equal(quotas.isSelected('anthropic/claude-sonnet-4-5'), true);
    assert.equal(quotas.isSelected('bad provider/nope'), false);
    assert.equal(quotas.isSelected('imagen/'), false);
    assert.equal((await quotas.selectBestCandidate()).candidate.id, 'anthropic/claude-sonnet-4-5');
  } finally { await close(); }
});
