import { posixPlatform } from './posix.ts';
import { win32Platform } from './win32.ts';
import type { PlatformOps } from './types.ts';

export const platform: PlatformOps =
  process.platform === 'win32' ? win32Platform : posixPlatform;

export { posixPlatform, win32Platform };
export type { PlatformOps };
