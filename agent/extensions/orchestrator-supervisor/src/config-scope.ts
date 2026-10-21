import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { resolveSupervisorDir } from './config.ts';
import { withExclusiveFileLock } from './atomic-json.ts';

export type ConfigDocument = 'supervisor.json' | 'subagents.json';
export function globalConfigPath(document: ConfigDocument): string {
  return join(resolveSupervisorDir('global'), document);
}
export function effectiveConfigPath(projectPath: string, document: ConfigDocument): string {
  return existsSync(projectPath) ? projectPath : globalConfigPath(document);
}
export function removeProjectOverride(projectPath: string): void {
  withExclusiveFileLock(projectPath, 'project configuration', () => {
    try { unlinkSync(projectPath); }
    catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  });
}
