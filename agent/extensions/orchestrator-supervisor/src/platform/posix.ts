import { readFileSync, renameSync } from 'node:fs';
import type { PlatformOps } from './types.ts';

export const posixPlatform: PlatformOps = {
  getBootId(): string {
    try {
      return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() || 'unknown-boot-id';
    } catch {
      return 'unknown-boot-id';
    }
  },

  getProcessStartTime(pid: number): number {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const parenIndex = stat.lastIndexOf(')');
      if (parenIndex === -1) return -1;
      const fields = stat.slice(parenIndex + 2).split(' ');
      const ticks = Number.parseInt(fields[19] ?? '', 10);
      return Number.isSafeInteger(ticks) && ticks > 0 ? ticks : -1;
    } catch {
      return -1;
    }
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
    renameSync(source, destination);
  },

  directoryMode(): number | undefined {
    return 0o700;
  },

  fileMode(): number | undefined {
    return 0o600;
  },

  defaultPiCli(): string {
    return 'pi';
  },
};
