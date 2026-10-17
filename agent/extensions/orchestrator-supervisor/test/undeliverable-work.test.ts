import test from 'node:test';
import assert from 'node:assert/strict';
import { undeliverableTasks } from '../src/bridge.ts';

/**
 * Unit contract of the rule the rotation gate relies on to retire a delivery obligation.
 *
 * Only a cancelled subagent may be retired: the harness skips `settleCompletion` for
 * `TASK_STATUS.CANCELLED`, so its report is never sent and the parent would wait forever. Every
 * other status still delivers, and job obligations are not part of this rule at all, because a
 * `stopped` job in `job_list` cannot be told apart from a monitor stop whose notice is still
 * queued (`stopFor` in `background-monitor.ts` flushes lines and delivers a `stopped` notice,
 * while `job_stop` publishes none).
 *
 * These cases deliberately carry `content`, exactly like a real tool result: without it the
 * bridge rejects the shape before the status comparator ever runs.
 */
const text = (value: string, details: any = {}) => ({ content: [{ type: 'text', text: value }], details });
const ctxFor = (results: Record<string, any>) => ({
  tools: Object.keys(results).map(name => ({ name })),
  executeTool: async (name: string) => results[name],
});
const ok = (result: any) => ({ isError: false, result });
const statusOk = (id: string, status: string) => ok(text(`${id} · gentle-ai-verify · ${status} · background`, { gentleAgents: { taskId: id, status } }));

test('S2/S3: only a cancelled task is retired; every other readable status stays owed', async () => {
  assert.deepEqual([...(await undeliverableTasks(ctxFor({ subagent_status: statusOk('t', 'cancelled') }), ['t']))], ['t']);
  for (const status of ['running', 'queued', 'waiting', 'stopping', 'completed', 'failed', 'timed_out', 'unknown-state', '']) {
    assert.deepEqual([...(await undeliverableTasks(ctxFor({ subagent_status: statusOk('t', status) }), ['t']))], [], `status ${status}`);
  }
});

test('S3: an unreadable or unverifiable answer is never proof, so the task stays owed', async () => {
  const cases: Array<[string, any]> = [
    ['failing tool', ctxFor({ subagent_status: { isError: true, result: text('Error: unknown task') } })],
    ['missing content', ctxFor({ subagent_status: ok({ details: { gentleAgents: { taskId: 't', status: 'cancelled' } } }) })],
    ['missing metadata', ctxFor({ subagent_status: ok(text('nonsense', {})) })],
    ['tool unavailable', ctxFor({})],
  ];
  for (const [name, ctx] of cases) {
    assert.deepEqual([...(await undeliverableTasks(ctx as any, ['t']))], [], name);
  }
});

test('S2: a cancelled task is retired even while other work is still owed', async () => {
  const byId: Record<string, any> = { t: statusOk('t', 'cancelled'), other: statusOk('other', 'running') };
  const ctx = { tools: [{ name: 'subagent_status' }], executeTool: async (_name: string, args: any) => byId[args.task_id] };
  assert.deepEqual([...(await undeliverableTasks(ctx, ['t', 'other']))], ['t'], 'the rule answers per id, never in bulk');
});

test('S3: a status that names a different task never retires the id we asked about', async () => {
  const ctx = ctxFor({ subagent_status: statusOk('somebody-else', 'cancelled') });
  assert.deepEqual([...(await undeliverableTasks(ctx, ['t']))], [], 'only the answered id may be retired');
});
