import { createHash } from 'node:crypto';
import { mkdir, open, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { pathKey } from '../discovery/local-path';
import type { ChatIdentity, ChatLaunch, ChatScope } from './types';

/** A separate cwd or saved profile alias cannot create a second writer for the same transcript. */
export function chatWriterKey(identity: ChatIdentity): string {
  return JSON.stringify([identity.provider, pathKey(identity.home), identity.nativeId.toLowerCase()]);
}

export function sameChatScope(a: ChatScope, b: ChatScope): boolean {
  return a.provider === b.provider && a.profile === b.profile
    && pathKey(a.home) === pathKey(b.home) && pathKey(a.cwd) === pathKey(b.cwd);
}

export function sameChatIdentity(a: ChatIdentity, b: ChatIdentity): boolean {
  return a.nativeId === b.nativeId && sameChatScope(a, b);
}

export class ChatOwnership {
  private readonly owners = new Map<string, string>();

  available(identity: ChatIdentity): boolean {
    return !this.owners.has(chatWriterKey(identity));
  }

  claim(launch: ChatLaunch): boolean {
    if (!this.available(launch.identity)) return false;
    this.owners.set(chatWriterKey(launch.identity), launch.owner);
    return true;
  }

  release(launch: ChatLaunch): void {
    const key = chatWriterKey(launch.identity);
    if (this.owners.get(key) === launch.owner) this.owners.delete(key);
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function processExists(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1 || pid > 0x7fff_ffff) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return typeof error !== 'object' || error === null || !('code' in error) || error.code !== 'ESRCH';
  }
}

/** Publish before scanning. Overlapping contenders can both defer, and at most one may enter. */
export async function claimChatWriter(directory: string, launch: ChatLaunch): Promise<(() => Promise<void>) | undefined> {
  const root = join(directory, 'chat-writers');
  await mkdir(root, { recursive: true });
  const key = createHash('sha256').update(chatWriterKey(launch.identity)).digest('hex');
  const prefix = key + '.';
  const name = prefix + process.pid + '.' + launch.owner;
  const path = join(root, name);
  const file = await open(path, 'wx', 0o600);
  const release = async () => {
    await unlink(path).catch((error: unknown) => { if (!isMissing(error)) throw error; });
  };
  let claimed = false;
  try {
    await file.close();
    for (const entry of await readdir(root)) {
      if (entry === name || !entry.startsWith(prefix)) continue;
      const pid = /^(\d+)\.[a-f0-9-]{36}$/i.exec(entry.slice(prefix.length))?.[1];
      if (!pid || processExists(Number(pid))) return undefined;
      // The filename includes the original owner nonce. A replacement owner uses a different file.
      await unlink(join(root, entry)).catch(() => undefined);
    }
    claimed = true;
    return release;
  } finally {
    if (!claimed) await release();
  }
}
