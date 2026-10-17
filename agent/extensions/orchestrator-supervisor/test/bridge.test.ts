import test from 'node:test';
import assert from 'node:assert/strict';
import { assertWorkSettled, verifiedCheckpoint } from '../src/bridge.ts';
const text = (value: string) => ({ content: [{ type: 'text', text: value }] });
function context(tasks = 'No subagent tasks in this session.', jobs = 'No background jobs in this session.') {
  const calls: any[] = [];
  return { calls, tools: ['subagent_list_tasks', 'job_list', 'mem_save', 'mem_get_observation'].map(name => ({ name })),
    async executeTool(name: string, args: any) {
      calls.push([name, args]);
      const result = name === 'subagent_list_tasks' ? text(tasks) : name === 'job_list' ? text(jobs) :
        { ...text('{}'), details: { data: name === 'mem_save' ? { id: 42 } : { id: 42, type: 'session_summary', content: '- Active goal\n- Next step' } } };
      return { toolCall: { id: 'nested', name, arguments: args }, result, isError: false };
    },
  };
}
test('public tool fence rejects waiting subagents and running monitors, accepts settled work', async () => {
  await assertWorkSettled(context());
  await assert.rejects(assertWorkSettled(context('task1 · worker · waiting · background · cwd: /project')), /active tasks/);
  await assert.rejects(assertWorkSettled(context(undefined, 'job1 · monitor running · log · 1s · output')), /active jobs/);
  await assertWorkSettled(context('task1 · worker · completed · task · cwd: /project', 'job1 · exited 0 · done · 1s · output'));
});
test('missing tools or unsupported response fail closed', async () => {
  const ctx = context(); ctx.tools = [];
  await assert.rejects(assertWorkSettled(ctx), /unavailable/);
  await assert.rejects(assertWorkSettled(context('unexpected format')), /Cannot verify/);
});
test('assertWorkSettled accepts failed or cancelled tasks with error details and multiline error output', async () => {
  const taskWithMultilineError = [
    'task1 · worker · cancelled · background · cwd: /project · 1 turns · 0 tool calls · last: cancelled',
    'Cancelled by user (stopped from the agents panel)',
    'task2 · worker · failed · task · cwd: /project · 2 turns · 1 tool calls · last: error',
    'Error: process terminated with exit code 1',
    '  at Object.run (/app/worker.js:10:5)',
  ].join('\n');
  await assertWorkSettled(context(taskWithMultilineError));
});
test('checkpoint delegates to unchanged mem tools and verifies exact readback', async () => {
  const ctx = context();
  assert.deepEqual(await verifiedCheckpoint(ctx, { summary: '- Active goal\n- Next step' }), { id: 42, content: '- Active goal\n- Next step' });
  assert.deepEqual(ctx.calls.map(c => c[0]), ['mem_save', 'mem_get_observation']);
  await assert.rejects(verifiedCheckpoint(context(), { summary: 'different' }), /mismatch/);
  await assert.rejects(verifiedCheckpoint(context(), { memory_id: 0 }), /positive/);
});
