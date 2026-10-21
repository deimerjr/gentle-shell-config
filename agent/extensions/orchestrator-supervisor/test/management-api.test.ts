import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { manageSupervisor } from '../src/management-api.ts';

test('management API validates edits, reports scope, and removes only project overrides', () => {
  const root = mkdtempSync(join(tmpdir(), 'supervisor-management-'));
  const old = process.env.GENTLE_SUPERVISOR_RUNTIME_DIR;
  process.env.GENTLE_SUPERVISOR_RUNTIME_DIR = root;
  const cwd = join(root, 'project');
  const read = (scope = 'project'): any => manageSupervisor(cwd, { action: 'read', scope });
  try {
    assert.throws(() => manageSupervisor(cwd, { action: 'erase', scope: 'global' }), /request/);
    const global = read('global').orchestrator;
    manageSupervisor(cwd, { action: 'save', scope: 'global', section: 'orchestrator', config: { ...global, rotationThresholdPercent: 44 } });
    assert.equal(read().orchestrator.rotationThresholdPercent, 44);
    assert.equal(read().projectOverrides.orchestrator, false);
    manageSupervisor(cwd, { action: 'save', scope: 'project', section: 'orchestrator', config: { ...global, rotationThresholdPercent: 55 } });
    assert.equal(read().orchestrator.rotationThresholdPercent, 55);
    manageSupervisor(cwd, { action: 'inherit', scope: 'project', section: 'orchestrator' });
    assert.equal(read().orchestrator.rotationThresholdPercent, 44);
    assert.throws(() => manageSupervisor(cwd, { action: 'save', scope: 'global', section: 'orchestrator', config: { ...global, modelCount: 999 } }), /modelCount/);
    assert.equal(read().orchestrator.rotationThresholdPercent, 44);
  } finally {
    if (old === undefined) delete process.env.GENTLE_SUPERVISOR_RUNTIME_DIR;
    else process.env.GENTLE_SUPERVISOR_RUNTIME_DIR = old;
    rmSync(root, { recursive: true, force: true });
  }
});
