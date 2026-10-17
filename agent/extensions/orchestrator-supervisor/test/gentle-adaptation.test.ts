import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ContextGuard } from '../src/context-guard.ts';
import { isExtensionEnabled, resolveSupervisorDir } from '../src/config.ts';
import { FlowJournal, isMutatingTool } from '../src/journal.ts';

test('standalone loading requires no changes to project settings', () => {
  const dir = mkdtempSync(join(tmpdir(), 'supervisor-config-'));
  try {
    assert.equal(isExtensionEnabled('orchestrator-supervisor', dir), true);
    assert.match(resolveSupervisorDir('flow'), /orchestrator-supervisor\/\.runtime\/flow$/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('existing mem and work-management tools remain available at the context ceiling', () => {
  const guard = new ContextGuard();
  for (const toolName of ['mem_save', 'mem_session_summary', 'mem_get_observation', 'subagent_list_tasks', 'job_list', 'job_stop', 'subagent_cancel']) {
    assert.equal(guard.interceptToolCall({ toolName }, 250000, 272000), null, toolName);
  }
  assert.equal(guard.interceptToolCall({ toolName: 'write' }, 250000, 272000)?.block, true);
  assert.equal(isMutatingTool('mem_search', {}), false);
  assert.equal(isMutatingTool('mem_save', {}), true);
  assert.equal(isMutatingTool('mem_delete', {}), true);
});

test('corrupt journal fails closed rather than losing pending mutation evidence', () => {
  const dir = mkdtempSync(join(tmpdir(), 'supervisor-corrupt-'));
  try {
    writeFileSync(join(dir, 'tool-journal.json'), '{broken');
    assert.throws(() => new FlowJournal(dir, 'flow', 'session'), /journal/i);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
