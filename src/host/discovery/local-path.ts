import { constants } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, parse, relative, resolve, sep } from 'node:path';
import { safePath } from '../privacy/projection';

export type Access = 'available' | 'missing' | 'unavailable' | 'rejected';

export class SourceAccessError extends Error {
  constructor(readonly state: Exclude<Access, 'available'>) {
    super(state);
  }
}

export function accessError(error: unknown): Exclude<Access, 'available'> {
  if (error instanceof SourceAccessError) return error.state;
  if (typeof error === 'object' && error !== null && 'code' in error
      && ['ENOENT', 'ENOTDIR'].includes(String(error.code))) return 'missing';
  return 'unavailable';
}

export function localPath(value: unknown): string | undefined {
  const path = safePath(value);
  if (!path || !isAbsolute(path) || /^[\\/]{2}/.test(path)) return undefined;
  if (process.platform === 'win32' && (!/^[a-z]:[\\/]/i.test(path)
      || /[:*?"<>|]/.test(path.slice(2))
      || path.slice(3).split(/[\\/]/).some(part => /[. ]$/.test(part) && part !== '.' && part !== '..'))) {
    return undefined;
  }
  const normalized = resolve(path);
  return normalized === parse(normalized).root ? undefined : normalized;
}

export function pathKey(path: string): string {
  return process.platform === 'win32' ? path.toLowerCase() : path;
}

export function within(root: string, path: string): boolean {
  const suffix = relative(pathKey(root), pathKey(path));
  return !isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith('..' + sep);
}

export async function inspectLocal(path: string, type: 'directory' | 'file'): Promise<BigIntStats> {
  const info = await lstat(path, { bigint: true });
  if (info.isSymbolicLink() || (type === 'file' ? !info.isFile() || info.nlink !== 1n : !info.isDirectory())
      || pathKey(await realpath(path)) !== pathKey(path)) {
    throw new SourceAccessError('rejected');
  }
  return info;
}

export function sameFile(a: BigIntStats, b: BigIntStats): boolean {
  // Windows path stats can report dev=0 while a stat on the same open handle
  // reports the volume serial number.
  const sameDevice = a.dev === b.dev || (process.platform === 'win32' && (a.dev === 0n || b.dev === 0n));
  return sameDevice && a.ino === b.ino && a.birthtimeNs === b.birthtimeNs;
}

// Verify the handle against both path checks before consuming bytes, including
// on Windows where O_NOFOLLOW may be unavailable.
export async function openLocalFile(path: string) {
  const before = await inspectLocal(path, 'file');
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const file = await handle.stat({ bigint: true });
    const after = await inspectLocal(path, 'file');
    if (!file.isFile() || file.nlink !== 1n || file.ino === 0n || !sameFile(before, file) || !sameFile(file, after)) {
      throw new SourceAccessError('rejected');
    }
    return { handle, file };
  } catch (error) {
    await handle.close();
    throw error;
  }
}
