// Integrate only through the host's existing tools. No HTTP memory bypass.
export function toolText(result: any): string {
  return (result?.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n');
}

export function toolData(result: any): any {
  if (result?.isError) throw new Error(toolText(result) || 'Existing tool failed');
  if (result?.details?.data) return result.details.data;
  try { return JSON.parse(toolText(result)); }
  catch { throw new Error('Existing memory tool returned an unsupported response'); }
}

export async function existingTool(ctx: any, name: string, args: any): Promise<any> {
  if (!ctx.tools?.some((t: any) => t.name === name) || typeof ctx.executeTool !== 'function') {
    throw new Error(`Required existing tool is unavailable: ${name}`);
  }
  const outcome = await ctx.executeTool(name, args);
  if (outcome.isError) throw new Error(toolText(outcome.result) || `${name} failed`);
  if (!outcome.result || !Array.isArray(outcome.result.content)) throw new Error(`${name} returned an unsupported execution outcome`);
  return outcome.result;
}

export async function assertWorkSettled(ctx: any): Promise<void> {
  // An installed tool that is hidden/inactive is not evidence that no work exists.
  for (const [name, empty, kind] of [
    ['subagent_list_tasks', 'No subagent tasks in this session.', 'tasks'],
    ['job_list', 'No background jobs in this session.', 'jobs'],
  ]) {
    const result = await existingTool(ctx, name!, {});
    const text = toolText(result).trim();
    if (text === empty) continue;
    if (!text) throw new Error(`Cannot verify ${kind}: empty response`);
    let entriesCount = 0;
    for (const rawLine of text.split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;
      const fields = line.split(' · ');
      if (kind === 'tasks') {
        const isHeader = fields.length >= 4 && Boolean(fields[0]) && Boolean(fields[1]) && ['task', 'background'].includes(fields[3]!);
        if (isHeader) {
          const status = fields[2]!;
          if (['queued', 'running', 'waiting', 'stopping'].includes(status)) {
            throw new Error(`Rotation deferred: active ${kind} (${fields[0]})`);
          }
          if (!['completed', 'failed', 'cancelled', 'timed_out'].includes(status)) {
            throw new Error(`Cannot verify ${kind}: unknown status ${status}`);
          }
          entriesCount++;
          continue;
        }
        if (entriesCount > 0) continue;
        throw new Error(`Cannot verify ${kind}: unsupported response`);
      } else {
        const rawStatus = fields[1];
        const status = rawStatus?.replace(/^monitor /, '');
        const isJobLine = fields.length >= 3 && Boolean(fields[0]) && Boolean(status);
        if (isJobLine) {
          if (['queued', 'running', 'waiting', 'stopping'].includes(status!)) {
            throw new Error(`Rotation deferred: active ${kind} (${fields[0]})`);
          }
          if (!/^(exited( -?\d+|\s+\?)?|stopped|failed)$/.test(status!)) {
            throw new Error(`Cannot verify ${kind}: unknown status ${status}`);
          }
          entriesCount++;
          continue;
        }
        if (entriesCount > 0) continue;
        throw new Error(`Cannot verify ${kind}: unsupported response`);
      }
    }
    if (entriesCount === 0) throw new Error(`Cannot verify ${kind}: unsupported response`);
  }
}

/**
 * Task ids whose pending delivery can never arrive, so their obligation may be retired without
 * weakening the fence. The harness excludes a cancelled subagent from completion delivery
 * (`settleCompletion` is skipped for `TASK_STATUS.CANCELLED`), so the parent would otherwise
 * wait forever for a report that is never sent. Absence of evidence is never proof: an unknown
 * or mismatched id, an unreadable status or an unavailable tool leaves the obligation owed.
 *
 * A stopped JOB is deliberately not included here. `job_stop` publishes no notice, but a monitor
 * stopped by timeout or flood queues one (`stopFor` in `background-monitor.ts` flushes its lines
 * and delivers a `stopped` notice), and `job_list` cannot tell those two apart. Retiring on
 * `stopped` could therefore drop a notice that is still queued, so job obligations stay owed.
 */
export async function undeliverableTasks(ctx: any, taskIds: readonly string[]): Promise<Set<string>> {
  const tasks = new Set<string>();
  for (const id of taskIds) {
    try {
      const answered = (await existingTool(ctx, 'subagent_status', { task_id: id }))?.details?.gentleAgents;
      // Only the id we asked about may be retired, and only on its own verified status.
      if (answered?.taskId === id && answered.status === 'cancelled') tasks.add(id);
    } catch { /* Unverifiable work stays owed. */ }
  }
  return tasks;
}

export async function verifiedCheckpoint(ctx: any, params: { summary?: string; memory_id?: number }): Promise<{ id: number; content: string }> {
  let id = params.memory_id;
  if (params.summary !== undefined) {
    const summary = params.summary.trim();
    if (!summary || summary.length > 12000) throw new Error('Checkpoint summary must contain 1–12000 characters');
    const saved = toolData(await existingTool(ctx, 'mem_save', {
      title: 'Supervisor continuity checkpoint', content: summary, type: 'session_summary', capture_prompt: false,
    }));
    id = saved.id;
  }
  if (!Number.isSafeInteger(id) || id! <= 0) throw new Error('Checkpoint requires a positive memory_id or a summary');
  const data = toolData(await existingTool(ctx, 'mem_get_observation', { id }));
  if (typeof data.content !== 'string' || !data.content.trim() || data.content.length > 12000) throw new Error('Checkpoint readback is empty or too large');
  if (data.type !== 'session_summary') throw new Error('Checkpoint must be a session_summary observation');
  if (params.summary !== undefined && data.content !== params.summary.trim()) throw new Error('Checkpoint readback mismatch');
  return { id: id!, content: data.content };
}
