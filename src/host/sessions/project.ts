import { dirname, join, posix, win32 } from 'node:path';
import { inspectLocal, localPath, pathKey, accessError } from '../discovery/local-path';
import { safePath } from '../privacy/projection';

export interface ProjectIdentity {
  key: string;
  root?: string;
  state: 'local' | 'unresolved' | 'remote';
}

export function recordedPath(value?: string): string | undefined {
  const path = safePath(value);
  if (!path || /^[\\/]{2}/.test(path)) return undefined;
  if (/^[a-z]:[\\/]/i.test(path)) {
    const parts = path.slice(3).split(/[\\/]/);
    return /[:*?"<>|]/.test(path.slice(2)) || parts.some(part => /[. ]$/.test(part) && part !== '.' && part !== '..')
      ? undefined : win32.normalize(path).toLowerCase();
  }
  return posix.isAbsolute(path) && !path.includes('\\') ? posix.normalize(path) : undefined;
}

export async function resolveProject(cwd: string): Promise<ProjectIdentity> {
  const recorded = recordedPath(cwd);
  const path = localPath(cwd);
  if (!recorded) return { key: 'unresolved:' + cwd, state: 'remote' };
  const unresolved: ProjectIdentity = { key: 'cwd:' + recorded, state: 'unresolved' };
  if (!path) return unresolved;
  try {
    await inspectLocal(path, 'directory');
  } catch {
    return unresolved;
  }
  // Look for a .git directory or a linked-worktree marker using metadata only.
  // Keep the worktree path as the identity and never follow the marker's contents.
  for (let candidate = path; dirname(candidate) !== candidate; candidate = dirname(candidate)) {
    const marker = join(candidate, '.git');
    try {
      await inspectLocal(marker, 'directory');
      return { key: 'repo:' + pathKey(candidate), root: candidate, state: 'local' };
    } catch (error) {
      if (accessError(error) === 'missing') continue;
    }
    try {
      await inspectLocal(marker, 'file');
      return { key: 'repo:' + pathKey(candidate), root: candidate, state: 'local' };
    } catch (error) {
      if (accessError(error) !== 'missing') break;
    }
  }
  return { key: 'cwd:' + recorded, root: path, state: 'local' };
}
