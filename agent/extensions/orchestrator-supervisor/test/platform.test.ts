import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { platform, posixPlatform, win32Platform } from '../src/platform/index.ts';

test('posixPlatform implements Linux/POSIX contracts', () => {
  assert.equal(posixPlatform.directoryMode(), 0o700);
  assert.equal(posixPlatform.fileMode(), 0o600);
  assert.equal(posixPlatform.defaultPiCli(), 'pi');

  // Liveness check on current process
  assert.equal(posixPlatform.isProcessAlive(process.pid), true);
  // Non-existent process returns false (ESRCH)
  assert.equal(posixPlatform.isProcessAlive(99999999), false);

  // atomicRename
  const tmpDir = mkdtempSync(join(tmpdir(), 'platform-posix-'));
  try {
    const src = join(tmpDir, 'source.txt');
    const dst = join(tmpDir, 'dest.txt');
    writeFileSync(src, 'content');
    posixPlatform.atomicRename(src, dst);
    assert.equal(existsSync(src), false);
    assert.equal(readFileSync(dst, 'utf8'), 'content');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('win32Platform implements Windows contracts safely', () => {
  assert.equal(win32Platform.directoryMode(), undefined);
  assert.equal(win32Platform.fileMode(), undefined);
  assert.equal(win32Platform.defaultPiCli(), 'pi.cmd');

  // getBootId produces a deterministic boot string
  const bootId = win32Platform.getBootId();
  assert.match(bootId, /^win32-boot-\d+$/);

  // getProcessStartTime returns -1 (conservative without /proc)
  assert.equal(win32Platform.getProcessStartTime(12345), -1);

  // Liveness check on current process
  assert.equal(win32Platform.isProcessAlive(process.pid), true);
  // Non-existent process returns false
  assert.equal(win32Platform.isProcessAlive(99999999), false);

  // atomicRename
  const tmpDir = mkdtempSync(join(tmpdir(), 'platform-win32-'));
  try {
    const src = join(tmpDir, 'source.txt');
    const dst = join(tmpDir, 'dest.txt');
    writeFileSync(src, 'win32-content');
    win32Platform.atomicRename(src, dst);
    assert.equal(existsSync(src), false);
    assert.equal(readFileSync(dst, 'utf8'), 'win32-content');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('platform singleton selects correct adapter based on process.platform', () => {
  const expected = process.platform === 'win32' ? win32Platform : posixPlatform;
  assert.equal(platform.defaultPiCli(), expected.defaultPiCli());
  assert.equal(platform.directoryMode(), expected.directoryMode());
  assert.equal(platform.fileMode(), expected.fileMode());
});
