import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSupervisorConfig, updateSupervisorConfig, resolveSupervisorConfigPath } from '../src/supervisor-config.ts';
import { loadSubagentConfig, updateSubagentConfig } from '../src/subagent-config.ts';
import { globalConfigPath, removeProjectOverride } from '../src/config-scope.ts';

test('global defaults are inherited, project overrides persist, invalid global configuration fails closed', () => {
  const root = mkdtempSync(join(tmpdir(), 'supervisor-global-'));
  const old = process.env.GENTLE_SUPERVISOR_RUNTIME_DIR;
  process.env.GENTLE_SUPERVISOR_RUNTIME_DIR = root;
  try {
    const a = join(root, 'a'), b = join(root, 'b');
    updateSupervisorConfig(a, { rotationThresholdPercent: 42 }, undefined, 'global');
    assert.equal(loadSupervisorConfig(b).config.rotationThresholdPercent, 42);
    updateSupervisorConfig(a, { rotationThresholdPercent: 55 });
    assert.equal(loadSupervisorConfig(a).config.rotationThresholdPercent, 55);
    assert.equal(loadSupervisorConfig(b).config.rotationThresholdPercent, 42);
    removeProjectOverride(resolveSupervisorConfigPath(a));
    assert.equal(loadSupervisorConfig(a).config.rotationThresholdPercent, 42);
    updateSubagentConfig(a, { enabled: true }, undefined, 'global');
    assert.equal(loadSubagentConfig(b).config.enabled, true);
    writeFileSync(globalConfigPath('supervisor.json'), '{broken');
    assert.equal(loadSupervisorConfig(a).source, 'invalid');
    assert.equal(loadSupervisorConfig(a).config.enabled, false);
    assert.throws(() => updateSupervisorConfig(a, { enabled: true }), /JSON/);
  } finally {
    if (old === undefined) delete process.env.GENTLE_SUPERVISOR_RUNTIME_DIR;
    else process.env.GENTLE_SUPERVISOR_RUNTIME_DIR = old;
    rmSync(root, { recursive: true, force: true });
  }
});
