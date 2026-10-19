import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FlowLock } from '../src/lock.ts';

test('MINI-001 / MINI-006: FlowLock acquires lock with 0700 dir and 0600 file', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'supervisor-lock-test-'));
  try {
    const flowDir = join(tmpDir, 'flow-1234');
    const lock = new FlowLock(flowDir, 'flow-1234', 'session-1');

    const acquired = lock.acquire();
    assert.equal(acquired, true);
    assert.equal(lock.isHeld(), true);

    const dirStat = statSync(flowDir);
    // Dir mode permissions (0o700)
    assert.equal(dirStat.mode & 0o777, 0o700);

    const lockFile = join(flowDir, 'supervisor.lock');
    assert.equal(existsSync(lockFile), true);
    const fileStat = statSync(lockFile);
    // File mode permissions (0o600)
    assert.equal(fileStat.mode & 0o777, 0o600);

    // Concurrent lock attempt with different session rejects
    const lock2 = new FlowLock(flowDir, 'flow-1234', 'session-2');
    // Simulate different owner
    assert.throws(() => {
      lock2.acquire({ enforceDistinctSession: true });
    }, /locked_by_active_owner/);

    // Retaining lock for same process across newSession
    const retained = lock.handover('session-new-2');
    assert.equal(retained, true);

    lock.release();
    assert.equal(existsSync(lockFile), false);
    assert.equal(lock.isHeld(), false);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('S1: FlowLock treats unavailable cross-platform identity evidence as alive', () => {
  const originalBootId = FlowLock.getBootId;
  const originalStartTimeTicks = FlowLock.getStartTimeTicks;
  const originalKill = process.kill;

  try {
    FlowLock.getBootId = () => 'unknown-boot-id';
    FlowLock.getStartTimeTicks = () => -1;
    process.kill = (() => true) as typeof process.kill;

    assert.equal(
      FlowLock.isOwnerAlive({
        pid: 4242,
        startTimeTicks: 12345,
        bootId: 'boot-from-another-platform',
        cmdline: 'pi',
        sessionId: 'session-owner',
        flowIdentity: 'flow-portable',
        createdAt: 1,
      }),
      true,
    );
  } finally {
    FlowLock.getBootId = originalBootId;
    FlowLock.getStartTimeTicks = originalStartTimeTicks;
    process.kill = originalKill;
  }
});

test('S1: FlowLock only rejects PID identity when start-time evidence is conclusive', () => {
  const originalBootId = FlowLock.getBootId;
  const originalStartTimeTicks = FlowLock.getStartTimeTicks;
  const originalKill = process.kill;

  try {
    FlowLock.getBootId = () => 'same-boot';
    process.kill = (() => true) as typeof process.kill;
    const payload = {
      pid: 4242,
      startTimeTicks: 12345,
      bootId: 'same-boot',
      cmdline: 'pi',
      sessionId: 'session-owner',
      flowIdentity: 'flow-identity',
      createdAt: 1,
    };

    FlowLock.getStartTimeTicks = () => -1;
    assert.equal(FlowLock.isOwnerAlive(payload), true);

    FlowLock.getStartTimeTicks = () => 54321;
    assert.equal(FlowLock.isOwnerAlive(payload), false);
  } finally {
    FlowLock.getBootId = originalBootId;
    FlowLock.getStartTimeTicks = originalStartTimeTicks;
    process.kill = originalKill;
  }
});

test('MINI-001: FlowLock reclaims stale lock when PID is dead or boot ID differs', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'supervisor-lock-stale-'));
  try {
    const flowDir = join(tmpDir, 'flow-stale');
    const lockFile = join(flowDir, 'supervisor.lock');

    // Create a fake stale lock with non-existent PID 99999999
    const lock = new FlowLock(flowDir, 'flow-stale', 'session-active');
    lock.ensureDirectory();

    writeFileSync(
      lockFile,
      JSON.stringify({
        pid: 99999999,
        startTimeTicks: 12345,
        bootId: 'old-boot-id',
        cmdline: 'pi',
        sessionId: 'session-dead',
        flowIdentity: 'flow-stale',
        createdAt: Date.now() - 100000,
      }),
      { mode: 0o600 },
    );

    const acquired = lock.acquire();
    assert.equal(acquired, true);
    assert.equal(lock.isHeld(), true);

    lock.release();
    assert.equal(existsSync(lockFile), false);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
