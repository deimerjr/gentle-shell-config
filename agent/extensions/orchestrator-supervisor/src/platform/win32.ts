import { renameSync } from 'node:fs';
import { uptime } from 'node:os';
import type { PlatformOps } from './types.ts';

const RENAME_RETRY_ATTEMPTS = 5;
const RENAME_RETRY_WAIT_MS = 10;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export const win32Platform: PlatformOps = {
  getBootId(): string {
    try {
      const bootSeconds = Math.floor((Date.now() - uptime() * 1000) / 10000) * 10;
      return `win32-boot-${bootSeconds}`;
    } catch {
      return 'unknown-boot-id';
    }
  },

  getProcessStartTime(_pid: number): number {
    return -1;
  },

  isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err: any) {
      if (err.code === 'ESRCH') return false;
      return true;
    }
  },

  atomicRename(source: string, destination: string): void {
    for (let attempt = 0; attempt < RENAME_RETRY_ATTEMPTS; attempt++) {
      try {
        renameSync(source, destination);
        return;
      } catch (err: any) {
        if (['EPERM', 'EBUSY', 'EACCES'].includes(err.code) && attempt < RENAME_RETRY_ATTEMPTS - 1) {
          sleepSync(RENAME_RETRY_WAIT_MS);
          continue;
        }
        throw err;
      }
    }
  },

  directoryMode(): number | undefined {
    return undefined;
  },

  fileMode(): number | undefined {
    return undefined;
  },

  defaultPiCli(): string {
    return 'pi.cmd';
  },
};
