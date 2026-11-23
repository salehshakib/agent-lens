import { createHash } from 'node:crypto';
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { inspectLocal, localPath } from '../discovery/local-path';
import { record } from '../privacy/projection';
import { profileKey } from './claude-relay';

/** A top-level member of a JSON object, located by byte offsets so unrelated bytes stay untouched. */
interface Member {
  key: string;
  keyStart: number;
  valueStart: number;
  valueEnd: number;
}

interface Scan {
  open: number;
  close: number;
  members: Member[];
}

class Cursor {
  position = 0;
  constructor(readonly text: string) {}

  space(): void {
    while (this.position < this.text.length && /[\s\uFEFF]/.test(this.text[this.position]!)) this.position++;
  }

  string(): string | undefined {
    if (this.text[this.position] !== '"') return undefined;
    const start = this.position++;
    while (this.position < this.text.length) {
      const char = this.text[this.position++];
      if (char === '\\') this.position++;
      else if (char === '"') {
        try {
          return JSON.parse(this.text.slice(start, this.position)) as string;
        } catch {
          return undefined;
        }
      }
    }
    return undefined;
  }

  value(): boolean {
    this.space();
    const char = this.text[this.position];
    if (char === '"') return this.string() !== undefined;
    if (char === '{' || char === '[') {
      let depth = 0;
      while (this.position < this.text.length) {
        const current = this.text[this.position]!;
        if (current === '"') {
          if (this.string() === undefined) return false;
          continue;
        }
        this.position++;
        if (current === '{' || current === '[') depth++;
        else if ((current === '}' || current === ']') && --depth === 0) return true;
      }
      return false;
    }
    const match = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|^true|^false|^null/.exec(this.text.slice(this.position, this.position + 64));
    if (!match) return false;
    this.position += match[0].length;
    return true;
  }
}

/** Locate the top-level members of a strict JSON object. Returns undefined for anything else. */
export function scanObject(text: string): Scan | undefined {
  const cursor = new Cursor(text);
  cursor.space();
  if (text[cursor.position] !== '{') return undefined;
  const open = cursor.position++;
  const members: Member[] = [];
  cursor.space();
  if (text[cursor.position] === '}') {
    cursor.position++;
  } else {
    for (;;) {
      cursor.space();
      const keyStart = cursor.position;
      const key = cursor.string();
      if (key === undefined) return undefined;
      cursor.space();
      if (text[cursor.position++] !== ':') return undefined;
      cursor.space();
      const valueStart = cursor.position;
      if (!cursor.value()) return undefined;
      members.push({ key, keyStart, valueStart, valueEnd: cursor.position });
      cursor.space();
      const next = text[cursor.position++];
      if (next === '}') break;
      if (next !== ',') return undefined;
    }
  }
  const close = cursor.position - 1;
  cursor.space();
  if (cursor.position !== text.length) return undefined;
  try {
    JSON.parse(text);
  } catch {
    return undefined;
  }
  return { open, close, members };
}

export function findMembers(scan: Scan, key: string): Member[] {
  return scan.members.filter(member => member.key === key);
}

function newline(text: string): string {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

function indentation(text: string, scan: Scan): string {
  const first = scan.members[0];
  if (!first) return '  ';
  const lineStart = text.lastIndexOf('\n', first.keyStart) + 1;
  const prefix = text.slice(lineStart, first.keyStart);
  return /^[ \t]+$/.test(prefix) ? prefix : '  ';
}

/** Set or add a top-level member, preserving every other byte of the document. */
export function setMember(text: string, scan: Scan, key: string, valueText: string): string {
  const existing = findMembers(scan, key)[0];
  if (existing) return text.slice(0, existing.valueStart) + valueText + text.slice(existing.valueEnd);
  const eol = newline(text);
  const indent = indentation(text, scan);
  const member = JSON.stringify(key) + ': ' + valueText;
  const last = scan.members[scan.members.length - 1];
  if (!last) return text.slice(0, scan.open + 1) + eol + indent + member + eol + text.slice(scan.close);
  return text.slice(0, last.valueEnd) + ',' + eol + indent + member + text.slice(last.valueEnd);
}

/** Remove a top-level member and its separating comma, preserving every other byte. */
export function removeMember(text: string, scan: Scan, key: string): string {
  const index = scan.members.findIndex(member => member.key === key);
  const member = scan.members[index];
  if (!member) return text;
  const previous = scan.members[index - 1];
  const next = scan.members[index + 1];
  if (previous) return text.slice(0, previous.valueEnd) + text.slice(member.valueEnd);
  if (next) return text.slice(0, member.keyStart) + text.slice(next.keyStart);
  return text.slice(0, scan.open + 1) + text.slice(scan.close);
}

export function hashText(text: string | undefined): string {
  return text === undefined ? 'absent' : createHash('sha256').update(text).digest('hex');
}

export interface OwnershipState {
  v: 1;
  home: string;
  /** Raw JSON text of the prior user-level statusLine value, or null when it was absent. */
  prior: string | null;
  /** Raw JSON text Agent Lens wrote. */
  installed: string;
  createdFile: boolean;
}

export interface RelayLocations {
  /** Profile home (CLAUDE_CONFIG_DIR or default). */
  home: string;
  /** Extension-owned storage directory. */
  storage: string;
}

export interface InstallOptions extends RelayLocations {
  /** Built relay script to copy into storage. */
  relayScript: string;
  /** Command used to start the relay. Defaults to node. */
  node?: string;
  /** Higher-precedence settings files to check (managed, project and local). */
  precedencePaths?: readonly string[];
}

export type RelayCode = 'path' | 'unreadable' | 'precedence' | 'unrecognized' | 'unowned' | 'changed' | 'script' | 'node';

export type RelayResult =
  | { ok: true; status: 'installed' | 'already-installed' | 'restored' | 'edited' | 'not-installed'; message: string }
  | { ok: false; code: RelayCode; message: string };

const unsafeCommandCharacters = /["$`\r\n%!]/;

export function relayDirectories(storage: string, home: string): { root: string; script: string; profile: string; snapshots: string; state: string; chain: string } {
  const root = join(storage, 'relay');
  const profile = join(root, profileKey(home));
  return { root, script: join(root, 'relay.js'), profile, snapshots: join(profile, 'snap'),
    state: join(profile, 'state.json'), chain: join(profile, 'chain.json') };
}

export function defaultPrecedencePaths(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string[] {
  if (platform === 'win32') return [join(env.ProgramFiles ?? 'C:\\Program Files', 'ClaudeCode', 'managed-settings.json')];
  if (platform === 'darwin') return ['/Library/Application Support/ClaudeCode/managed-settings.json'];
  return ['/etc/claude-code/managed-settings.json'];
}

/** Whether an executable name resolves on PATH, without running it. */
export async function onPath(name: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const extensions = process.platform === 'win32' ? ['', ...(env.PATHEXT ?? '.EXE;.CMD').split(';')] : [''];
  for (const directory of (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      try {
        if ((await stat(join(directory, name + extension))).isFile()) return true;
      } catch {
        // Keep looking.
      }
    }
  }
  return false;
}

async function readText(path: string): Promise<string | undefined> {
  try {
    await inspectLocal(path, 'file');
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
  return readFile(path, 'utf8');
}

async function precedenceConflict(paths: readonly string[]): Promise<string | undefined> {
  for (const path of paths) {
    let text: string | undefined;
    try {
      text = await readFile(path, 'utf8');
    } catch {
      continue;
    }
    const scan = scanObject(text);
    if (scan && findMembers(scan, 'statusLine').length) return path;
  }
  return undefined;
}

function command(options: { node: string; script: string; profile: string }): string {
  const forward = (value: string) => value.replace(/\\/g, '/');
  return options.node + ' "' + forward(options.script) + '" "' + forward(options.profile) + '"';
}

function installedValue(text: string): string {
  return JSON.stringify({ type: 'command', command: text });
}

function canonical(text: string | undefined): string | undefined {
  try {
    return text === undefined ? undefined : JSON.stringify(JSON.parse(text));
  } catch {
    return undefined;
  }
}

async function writeAtomic(path: string, text: string, expected: string): Promise<boolean> {
  const temporary = path + '.agent-lens.' + process.pid + '.tmp';
  await writeFile(temporary, text, { encoding: 'utf8', mode: 0o600 });
  try {
    // Detect an edit made while the new content was prepared.
    const current = await readFile(path, 'utf8').catch(() => undefined);
    if (hashText(current) !== expected) {
      await unlink(temporary);
      return false;
    }
    await rename(temporary, path);
    return true;
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function loadState(path: string): Promise<OwnershipState | undefined> {
  try {
    const value = record(JSON.parse(await readFile(path, 'utf8')));
    if (value?.v !== 1 || typeof value.home !== 'string' || typeof value.installed !== 'string' ||
        (value.prior !== null && typeof value.prior !== 'string') || typeof value.createdFile !== 'boolean') return undefined;
    return { v: 1, home: value.home, prior: value.prior, installed: value.installed, createdFile: value.createdFile };
  } catch {
    return undefined;
  }
}

export async function relayState(options: RelayLocations): Promise<'installed' | 'not-installed'> {
  return await loadState(relayDirectories(options.storage, options.home).state) ? 'installed' : 'not-installed';
}

/** Install the relay in one profile. Writes only the profile's user-level statusLine member. */
export async function installRelay(options: InstallOptions): Promise<RelayResult> {
  const home = localPath(options.home);
  const storage = localPath(options.storage);
  if (!home || !storage) return { ok: false, code: 'path', message: 'The Claude profile or storage location is not a safe local path.' };
  const dirs = relayDirectories(storage, home);
  const node = options.node ?? 'node';
  const started = command({ node, script: dirs.script, profile: dirs.profile });
  if ([node, dirs.script, dirs.profile].some(part => unsafeCommandCharacters.test(part))) {
    return { ok: false, code: 'path', message: 'A path contains characters that cannot be quoted safely in a status-line command.' };
  }
  const target = join(home, 'settings.json');
  let before: string | undefined;
  try {
    before = await readText(target);
  } catch {
    return { ok: false, code: 'unreadable', message: 'The Claude settings file could not be read safely. Nothing was changed.' };
  }
  const document = before ?? '{}';
  const scan = scanObject(document);
  if (!scan) return { ok: false, code: 'unreadable', message: 'The Claude settings file is not a strict JSON object. Nothing was changed.' };
  const conflicts = findMembers(scan, 'statusLine');
  if (conflicts.length > 1) return { ok: false, code: 'unrecognized', message: 'The settings file defines statusLine more than once. Nothing was changed.' };
  const higher = await precedenceConflict(options.precedencePaths ?? defaultPrecedencePaths());
  if (higher) {
    return { ok: false, code: 'precedence', message: 'A higher-precedence settings file defines statusLine, so the user-level value would not apply: ' + higher };
  }
  const existing = conflicts[0];
  const existingText = existing ? document.slice(existing.valueStart, existing.valueEnd) : undefined;
  const previous = await loadState(dirs.state);
  const newValue = installedValue(started);
  if (existingText !== undefined && canonical(existingText) === canonical(newValue)) {
    if (!previous) return { ok: false, code: 'unowned', message: 'The relay command is present but its ownership record is missing. Nothing was changed.' };
    try {
      await copyFile(options.relayScript, dirs.script);
    } catch {
      return { ok: false, code: 'script', message: 'The relay script could not be refreshed.' };
    }
    return { ok: true, status: 'already-installed', message: 'The relay is already enabled for this profile.' };
  }
  let prior: string | undefined;
  if (existingText !== undefined) {
    const value = record(JSON.parse(existingText));
    if (value?.type !== 'command' || typeof value.command !== 'string' || !value.command.trim()) {
      return { ok: false, code: 'unrecognized', message: 'The existing statusLine is not a command, so it cannot be chained. Nothing was changed.' };
    }
    prior = value.command;
  }
  try {
    await mkdir(dirs.snapshots, { recursive: true });
    await copyFile(options.relayScript, dirs.script);
    await writeFile(dirs.chain, JSON.stringify(prior === undefined ? {} : { command: prior }), { encoding: 'utf8', mode: 0o600 });
    const state: OwnershipState = { v: 1, home, prior: existingText ?? null, installed: newValue, createdFile: before === undefined };
    await writeFile(dirs.state, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 });
  } catch {
    await rm(dirs.profile, { recursive: true, force: true }).catch(() => undefined);
    return { ok: false, code: 'script', message: 'The relay files could not be created in extension storage. Nothing was changed.' };
  }
  const after = setMember(document, scan, 'statusLine', newValue);
  try {
    if (before === undefined) await mkdir(home, { recursive: true });
    const wrote = before === undefined
      ? await writeFile(target, after, { encoding: 'utf8', flag: 'wx', mode: 0o600 }).then(() => true, () => false)
      : await writeAtomic(target, after, hashText(before));
    if (!wrote) {
      await rm(dirs.profile, { recursive: true, force: true }).catch(() => undefined);
      return { ok: false, code: 'changed', message: 'The Claude settings changed while enabling the relay. Your configuration was left as it is.' };
    }
  } catch {
    await rm(dirs.profile, { recursive: true, force: true }).catch(() => undefined);
    return { ok: false, code: 'changed', message: 'The Claude settings could not be written. Your configuration was left as it is.' };
  }
  return { ok: true, status: 'installed', message: prior === undefined
    ? 'The relay is enabled with a minimal status line.' : 'The relay is enabled and passes through your existing status line.' };
}

/** Restore the prior statusLine only if Agent Lens still owns it, then remove Agent Lens artifacts. */
export async function uninstallRelay(options: RelayLocations): Promise<RelayResult> {
  const home = localPath(options.home);
  const storage = localPath(options.storage);
  if (!home || !storage) return { ok: false, code: 'path', message: 'The Claude profile or storage location is not a safe local path.' };
  const dirs = relayDirectories(storage, home);
  const state = await loadState(dirs.state);
  if (!state) return { ok: true, status: 'not-installed', message: 'The relay is not enabled for this profile.' };
  const target = join(home, 'settings.json');
  let before: string | undefined;
  try {
    before = await readText(target);
  } catch {
    return { ok: false, code: 'unreadable', message: 'The Claude settings file could not be read safely. Nothing was changed.' };
  }
  const scan = before === undefined ? undefined : scanObject(before);
  if (before !== undefined && !scan) return { ok: false, code: 'unreadable', message: 'The Claude settings file is not a strict JSON object. Nothing was changed.' };
  const members = scan ? findMembers(scan, 'statusLine') : [];
  const member = members.length === 1 ? members[0] : undefined;
  const currentText = member && before !== undefined ? before.slice(member.valueStart, member.valueEnd) : undefined;
  const owned = currentText !== undefined && canonical(currentText) === canonical(state.installed);
  if (owned && before !== undefined && scan) {
    let restored = state.prior === null ? removeMember(before, scan, 'statusLine')
      : setMember(before, scan, 'statusLine', state.prior);
    if (state.prior === null && state.createdFile && restored.replace(/\s/g, '') === '{}') restored = '';
    if (restored === '') {
      if (hashText(await readFile(target, 'utf8').catch(() => undefined)) !== hashText(before)) {
        return { ok: false, code: 'changed', message: 'The Claude settings changed during removal. Your configuration was left as it is.' };
      }
      await unlink(target);
    } else if (!await writeAtomic(target, restored, hashText(before))) {
      return { ok: false, code: 'changed', message: 'The Claude settings changed during removal. Your configuration was left as it is.' };
    }
  } else if (currentText !== undefined && currentText.includes(dirs.profile.replace(/\\/g, '/'))) {
    return { ok: true, status: 'edited', message: 'The relay setting was edited after setup, so it was left in place. Remove it from your Claude settings if you no longer want it.' };
  }
  await rm(dirs.profile, { recursive: true, force: true });
  try {
    const remaining = (await readdir(dirs.root, { withFileTypes: true })).filter(entry => entry.isDirectory());
    if (!remaining.length) await rm(dirs.script, { force: true });
  } catch {
    // Nothing left to clean.
  }
  return owned
    ? { ok: true, status: 'restored', message: state.prior === null
      ? 'The relay was removed. Your Claude settings have no statusLine, as before.'
      : 'The relay was removed and your previous status line was restored.' }
    : { ok: true, status: 'edited', message: 'Your statusLine was changed after setup, so it was kept. Agent Lens files were removed.' };
}
