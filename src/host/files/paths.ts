import { posix, win32 } from "node:path";
import { inspectLocal, localPath, within } from "../discovery/local-path";
import { safePath } from "../privacy/projection";
import type { FileAction } from "../sessions/types";

const drive = /^[a-z]:[\\/]/i;
const foreignLocation = /^(?:[a-z][\w+.-]*:\/\/|[\\/]{2})/i;
const protectedDirectory = /(?:^|[\\/])\.(?:git|claude|codex)(?=[\\/]|$)/i;
const protectedFile = /(?:^|[\\/])(?:state_\d+|thread_history_\d+|logs_\d+)\.sqlite(?:-wal|-shm|-journal)?$/i;
const reservedName = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i;

export interface IndexedPath {
  key: string;
  path: string;
  label: string;
}

function ambiguousWindowsPath(path: string): boolean {
  const tail = drive.test(path) ? path.slice(3) : path;
  return /[:*?"<>|]/.test(tail) || tail.split(/[\\/]/).some(part =>
    part !== "." && part !== ".." && (/[. ]$/.test(part) || reservedName.test(part)));
}

function permittedPath(value: unknown): string | undefined {
  const path = safePath(value);
  if (!path || /[\r\n\t]/.test(path) || protectedDirectory.test(path) || protectedFile.test(path)) return undefined;
  return path;
}

export function indexPath(value: unknown, directory?: string): IndexedPath | undefined {
  const input = permittedPath(value);
  if (!input) return undefined;
  if (foreignLocation.test(input)) return { key: `unresolved:${input}`, path: input, label: input };

  const cwd = permittedPath(directory);
  const windows = drive.test(input) || !!cwd && drive.test(cwd);
  const flavor = windows ? win32 : posix;
  if (windows && ambiguousWindowsPath(input)) return undefined;
  if (windows && !drive.test(input) && win32.isAbsolute(input)) {
    return { key: `unresolved:${input}`, path: input, label: input };
  }

  const base = cwd && (windows ? drive.test(cwd) && !ambiguousWindowsPath(cwd) : cwd.startsWith("/")) ? cwd : undefined;
  const path = flavor.normalize(flavor.isAbsolute(input) || !base ? input : flavor.join(base, input));
  if (!permittedPath(path)) return undefined;
  const relative = base && flavor.relative(base, path);
  const label = relative && relative !== ".." && !relative.startsWith(`..${flavor.sep}`) && !flavor.isAbsolute(relative)
    ? relative : path;
  const normalized = windows ? path.toLowerCase() : path;
  return { key: flavor.isAbsolute(path) ? normalized : `unresolved:${normalized}`, path, label };
}

/** Validate the indexed path immediately before handing it to the native editor. */
export async function currentFilePath(action: FileAction, excludedRoots: readonly string[] = []): Promise<string | undefined> {
  const cwd = localPath(permittedPath(action.cwd));
  const root = localPath(permittedPath(action.projectRoot)) ?? cwd;
  const target = action.status === "applied" ? action.movePath ?? action.path : action.path;
  const path = localPath(permittedPath(target));
  if (!root || !path || path === root || !within(root, path) || excludedRoots.some(home => within(home, path)) ||
    (process.platform === "win32" && (ambiguousWindowsPath(path) || ambiguousWindowsPath(root)))) return undefined;
  try {
    await inspectLocal(root, "directory");
    await inspectLocal(path, "file");
    return path;
  } catch {
    return undefined;
  }
}
