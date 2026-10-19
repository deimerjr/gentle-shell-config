import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withExclusiveFileLock } from '../src/atomic-json.ts';

test('S1: atomic JSON lock reclaims a deterministically stale lock', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'atomic-json-lock-stale-'));
  try {
    const filePath = join(tmpDir, 'config.json');
    const lockPath = `${filePath}.lock`;
    writeFileSync(lockPath, JSON.stringify({ pid: 99999999 }) + '\n', { mode: 0o600 });

    const result = withExclusiveFileLock(filePath, 'configuration', () => {
      assert.equal(existsSync(lockPath), true);
      writeFileSync(filePath, '{"updated":true}\n', { mode: 0o600 });
      return 'updated';
    });

    assert.equal(result, 'updated');
    assert.equal(readFileSync(filePath, 'utf8'), '{"updated":true}\n');
    assert.equal(existsSync(lockPath), false);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('S1: atomic JSON lock does not reclaim a recent lock', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'atomic-json-lock-live-'));
  try {
    const filePath = join(tmpDir, 'config.json');
    const lockPath = `${filePath}.lock`;
    writeFileSync(lockPath, '', { mode: 0o600 });

    assert.throws(
      () => withExclusiveFileLock(filePath, 'configuration', () => undefined),
      /Configuration lock held by another process/,
    );
    assert.equal(existsSync(lockPath), true);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
