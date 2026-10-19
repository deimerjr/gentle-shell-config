export interface PlatformOps {
  /**
   * Deterministic system boot identifier or boot-time fingerprint.
   * Linux: contents of /proc/sys/kernel/random/boot_id.
   * Windows: boot timestamp derived from os.uptime().
   * Inconclusive: 'unknown-boot-id'.
   */
  getBootId(): string;

  /**
   * Process start time ticks or high-resolution creation timestamp.
   * Linux: field 22 from /proc/<pid>/stat.
   * Windows: process creation timestamp (or -1 if unavailable).
   * Inconclusive: -1.
   */
  getProcessStartTime(pid: number): number;

  /**
   * Conservative process liveness check.
   * Returns false ONLY when conclusive proof exists that the process is dead (e.g. ESRCH).
   * Returns true if alive or if existence is inconclusive (fail-closed).
   */
  isProcessAlive(pid: number): boolean;

  /**
   * Atomically replaces or renames a source file to destination.
   * POSIX: fs.renameSync(source, destination).
   * Windows: handles EBUSY/EPERM retries across NTFS locked handles.
   */
  atomicRename(source: string, destination: string): void;

  /**
   * Recommended directory mode for private state directories (0o700 on POSIX, undefined on Windows).
   */
  directoryMode(): number | undefined;

  /**
   * Recommended file mode for private lock/state files (0o600 on POSIX, undefined on Windows).
   */
  fileMode(): number | undefined;

  /**
   * Name or command for the default Pi CLI executable ('pi' on POSIX, 'pi.cmd' on Windows).
   */
  defaultPiCli(): string;
}
