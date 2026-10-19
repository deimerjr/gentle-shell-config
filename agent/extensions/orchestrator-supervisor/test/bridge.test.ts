import test from 'node:test';
import assert from 'node:assert/strict';
import { assertWorkSettled, verifiedCheckpoint } from '../src/bridge.ts';

const text = (value: string, details?: any) => ({
  content: [{ type: 'text', text: value }],
  ...(details !== undefined ? { details } : {}),
});

function normalizeMock(name: string, payload: any) {
  if (typeof payload === 'string') {
    return text(payload);
  }
  if (payload === undefined) {
    return text(name === 'subagent_list_tasks' ? 'No subagent tasks in this session.' : 'No background jobs in this session.');
  }
  if (name === 'subagent_list_tasks') {
    const tasks = Array.isArray(payload) ? payload : payload.tasks;
    return text('Tasks listed', { gentleAgents: { tasks } });
  }
  if (name === 'job_list') {
    const jobs = Array.isArray(payload) ? payload : payload.jobs;
    return text('Jobs listed', { gentleJobs: { count: jobs?.length ?? 0, jobs } });
  }
  return payload;
}

function context(tasksPayload?: any, jobsPayload?: any) {
  const calls: any[] = [];
  return {
    calls,
    tools: ['subagent_list_tasks', 'job_list', 'mem_save', 'mem_get_observation'].map(name => ({ name })),
    async executeTool(name: string, args: any) {
      calls.push([name, args]);
      const result = name === 'subagent_list_tasks' ? normalizeMock(name, tasksPayload) :
        name === 'job_list' ? normalizeMock(name, jobsPayload) :
        { ...text('{}'), details: { data: name === 'mem_save' ? { id: 42 } : { id: 42, type: 'session_summary', content: '- Active goal\n- Next step' } } };
      return { toolCall: { id: 'nested', name, arguments: args }, result, isError: false };
    },
  };
}

test('public tool fence rejects waiting subagents and running monitors, accepts settled work with structured details', async () => {
  await assertWorkSettled(context());
  await assert.rejects(
    assertWorkSettled(context([{ id: 'task1', status: 'waiting' }])),
    /active tasks \(task1\)/,
  );
  await assert.rejects(
    assertWorkSettled(context(undefined, [{ id: 'job1', status: 'running' }])),
    /active jobs \(job1\)/,
  );
  await assertWorkSettled(
    context(
      [{ id: 'task1', status: 'completed' }],
      [{ id: 'job1', status: 'exited' }],
    ),
  );
});

test('missing tools or unsupported response fail closed', async () => {
  const ctx = context();
  ctx.tools = [];
  await assert.rejects(assertWorkSettled(ctx), /unavailable/);
  await assert.rejects(assertWorkSettled(context('unexpected format')), /Cannot verify/);
  await assert.rejects(assertWorkSettled(context(undefined, 'unexpected job format')), /Cannot verify/);
});

test('assertWorkSettled accepts failed, cancelled or timed_out tasks in structured data', async () => {
  await assertWorkSettled(
    context([
      { id: 'task1', status: 'cancelled', error: 'Cancelled by user\nmultiline reason' },
      { id: 'task2', status: 'failed', error: 'Error: exit code 1\n  at worker.js:10' },
      { id: 'task3', status: 'timed_out' },
    ]),
  );
});

test('assertWorkSettled rejects unknown task or job statuses in structured data', async () => {
  await assert.rejects(
    assertWorkSettled(context([{ id: 'task1', status: 'weird-status' }])),
    /unknown status weird-status/,
  );
  await assert.rejects(
    assertWorkSettled(context(undefined, [{ id: 'job1', status: 'weird-job-status' }])),
    /unknown status weird-job-status/,
  );
});

test('checkpoint delegates to unchanged mem tools and verifies exact readback', async () => {
  const ctx = context();
  assert.deepEqual(await verifiedCheckpoint(ctx, { summary: '- Active goal\n- Next step' }), { id: 42, content: '- Active goal\n- Next step' });
  assert.deepEqual(ctx.calls.map(c => c[0]), ['mem_save', 'mem_get_observation']);
  await assert.rejects(verifiedCheckpoint(context(), { summary: 'different' }), /mismatch/);
  await assert.rejects(verifiedCheckpoint(context(), { memory_id: 0 }), /positive/);
});
