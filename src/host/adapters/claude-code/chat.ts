import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { opendir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import { promisify, TextDecoder } from 'node:util';
import { ChatLaunchError } from '../../chat/types';
import type { ChatAdapter, ChatConnection, ChatEvent, ChatIdentity, ChatLaunch } from '../../chat/types';
import { accessError, inspectLocal, localPath, openLocalFile } from '../../discovery/local-path';
import { profileEnv, resolveClaude } from '../../limits/claude-probe';
import { record } from '../../privacy/projection';
import { claudeDiagnostic, ClaudeChatStream, isClaudeSessionId, readClaudeFrames } from './stream';
import { normalizeModelChoice, normalizeEffortChoice } from './chat-settings';
import { minimumClaudeCodeVersion, supportsClaudeCodeVersion } from './version';

export { isClaudeSessionId } from './stream';

const args = [
  '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
  '--include-partial-messages', '--replay-user-messages', '--permission-prompts', 'none',
] as const;
/** Claude Code permission modes the chat may start in (agentLens.chat.permissionMode). */
export const chatPermissionModes = ['auto', 'default', 'acceptEdits', 'plan'] as const;
export type ChatPermissionMode = typeof chatPermissionModes[number];
let permissionMode: ChatPermissionMode = 'auto';

/** Applies to chats started or resumed after the call; running workers keep their mode. */
export function setChatPermissionMode(mode: unknown): void {
  permissionMode = chatPermissionModes.includes(mode as ChatPermissionMode) ? mode as ChatPermissionMode : 'auto';
}

const maxInputBytes = 224 * 1024;
const maxPresence = 16 * 1024;
const maxPresenceEntries = 4096;
const presenceName = /^([1-9][0-9]{0,9})\.json$/;
const presenceDecoder = new TextDecoder('utf-8', { fatal: true });
const runFile = promisify(execFile);
const lostInput = 'Claude Code stopped accepting chat input.';
const startFailed = 'Claude Code could not be started in the selected project.';
const unavailable = 'The Claude Code chat connection has closed.';

type Writer = 'present' | 'absent' | 'unknown';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

function processState(pid: number): 'running' | 'stopped' | 'unknown' {
  try {
    process.kill(pid, 0);
    return 'running';
  } catch (error) {
    const code = record(error)?.code;
    return code === 'ESRCH' ? 'stopped' : code === 'EPERM' ? 'running' : 'unknown';
  }
}

async function readPresence(path: string, pid: number): Promise<string | undefined> {
  const { handle, file } = await openLocalFile(path);
  try {
    if (file.size > BigInt(maxPresence) || file.size <= 0) return undefined;
    const buffer = Buffer.alloc(Number(file.size));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const after = await handle.stat({ bigint: true });
    if (bytesRead !== buffer.length || after.size !== file.size || after.mtimeNs !== file.mtimeNs || after.ctimeNs !== file.ctimeNs) return undefined;
    const row = record(JSON.parse(presenceDecoder.decode(buffer)));
    return row?.pid === pid && isClaudeSessionId(row.sessionId) ? row.sessionId : undefined;
  } finally {
    await handle.close();
  }
}

/** Consult only Claude's local per-PID presence directory for the selected profile. */
async function checkWriter(identity: ChatIdentity): Promise<Writer> {
  if (identity.provider !== 'claude-code' || !isClaudeSessionId(identity.nativeId) || localPath(identity.home) !== identity.home) return 'unknown';
  const directory = join(identity.home, 'sessions');
  try {
    await inspectLocal(identity.home, 'directory');
  } catch {
    return 'unknown';
  }
  try {
    await inspectLocal(directory, 'directory');
    const entries = await opendir(directory);
    let uncertain = false;
    let visited = 0;
    for await (const entry of entries) {
      if (++visited > maxPresenceEntries) return 'unknown';
      const name = presenceName.exec(entry.name)?.[1];
      if (!name) continue;
      const pid = Number(name);
      if (pid > 0x7fff_ffff) continue;
      const state = processState(pid);
      if (state === 'stopped') continue;
      if (!entry.isFile()) {
        uncertain = true;
        continue;
      }
      try {
        const sessionId = await readPresence(join(directory, entry.name), pid);
        if (!sessionId) uncertain = true;
        else if (sessionId.toLowerCase() === identity.nativeId.toLowerCase()) {
          if (state === 'running') return 'present';
          uncertain = true;
        }
      } catch (error) {
        if (accessError(error) !== 'missing') uncertain = true;
      }
    }
    return uncertain ? 'unknown' : 'absent';
  } catch (error) {
    return accessError(error) === 'missing' ? 'absent' : 'unknown';
  }
}

export async function verifiedExecutable(signal: AbortSignal): Promise<{ path: string; version: string }> {
  const directories = (process.env.PATH ?? process.env.Path ?? '').split(delimiter).map(entry => entry.replace(/^"|"$/g, ''));
  directories.push(join(homedir(), '.local', 'bin'));
  if (process.env.APPDATA) directories.push(join(process.env.APPDATA, 'npm'));
  const path = directories.filter(isAbsolute).join(delimiter);
  const candidate = await resolveClaude({ ...process.env, PATH: path });
  if (!candidate) throw new ChatLaunchError('Claude Code was not found. Install the native Windows Claude Code executable to use chat.');
  let executable: string;
  let output: string;
  try {
    executable = await realpath(candidate);
    if (signal.aborted) throw new Error(unavailable);
    const { stdout } = await runFile(executable, ['--version'], {
      signal, windowsHide: true, shell: false, timeout: 5_000, maxBuffer: 4096, encoding: 'utf8',
    });
    output = stdout.trim();
  } catch {
    throw new ChatLaunchError(signal.aborted ? unavailable : 'The installed Claude Code version could not be verified.');
  }
  const version = /^(\S+) \(Claude Code\)$/.exec(output)?.[1];
  if (!version || !supportsClaudeCodeVersion(version)) {
    throw new ChatLaunchError(`Agent Lens chat requires Claude Code ${minimumClaudeCodeVersion} or newer.`);
  }
  return { path: executable, version };
}

/** The Shift+Tab cycle. `bypassPermissions` and `dontAsk` are never part of it. */
export const permissionCycle = ['default', 'acceptEdits', 'plan', 'auto'] as const;

export function nextPermissionMode(current: string | undefined): string {
  const index = permissionCycle.indexOf(current as typeof permissionCycle[number]);
  return permissionCycle[index < 0 ? 0 : (index + 1) % permissionCycle.length]!;
}

export function permissionModeFrame(id: string, mode: string): string | undefined {
  if (!isClaudeSessionId(id) || !permissionCycle.includes(mode as typeof permissionCycle[number])) return undefined;
  return JSON.stringify({ type: 'control_request', request_id: id, request: { subtype: 'set_permission_mode', mode } }) + '\n';
}

export function modelControlFrame(id: string, model: string): string | undefined {
  const value = normalizeModelChoice(model);
  if (!isClaudeSessionId(id) || !value || value === 'default') return undefined;
  return JSON.stringify({ type: 'control_request', request_id: id, request: { subtype: 'set_model', model: value } }) + '\n';
}

export function officialResumeText(executable: string, id: string): string | undefined {
  if (!isAbsolute(executable) || /[\r\n\0]/u.test(executable) || !isClaudeSessionId(id)) return undefined;
  return "& '" + executable.replace(/'/g, "''") + "' --resume '" + id + "'";
}

export function startupSettings(launch: ChatLaunch): string[] {
  const { model, effort } = launch.settings ?? {};
  const argv: string[] = [];
  if (model) {
    if (normalizeModelChoice(model) !== model || model === 'default') throw new ChatLaunchError('Invalid requested model.');
    argv.push('--model', model);
  }
  if (effort) {
    if (normalizeEffortChoice(effort) !== effort || effort === 'default') throw new ChatLaunchError('Invalid requested effort.');
    argv.push('--effort', effort);
  }
  return argv;
}

function openWorker(executable: { path: string; version: string }, launch: ChatLaunch, emit: (event: ChatEvent) => void, signal: AbortSignal): Promise<ChatConnection> {
  const { identity, resume } = launch;
  const overrides = startupSettings(launch);
  if (overrides.length && !supportsClaudeCodeVersion(executable.version)) {
    throw new ChatLaunchError(`Startup model and effort overrides require Claude Code ${minimumClaudeCodeVersion} or newer.`);
  }
  const child = spawn(executable.path, [...args, '--permission-mode', permissionMode, ...overrides,
    resume ? '--resume' : '--session-id', identity.nativeId], {
    cwd: identity.cwd, env: profileEnv(identity.home), shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const closed = deferred<void>();
  const opened = deferred<ChatConnection>();
  let closing = false;
  let exited = false;
  let closedReason: string | undefined;
  let diagnostics: string | undefined;
  let stderrTail = '';
  let shutdownTimer: NodeJS.Timeout | undefined;
  let drainTimer: NodeJS.Timeout | undefined;
  let initializationTimer: NodeJS.Timeout | undefined;
  let interruptTimer: NodeJS.Timeout | undefined;
  let waitingForInterrupt: Promise<void> | undefined;
  let releaseInterrupt: (() => void) | undefined;
  let pendingWrite: { finish: (error?: Error) => void; promise: Promise<void> } | undefined;
  let finishModelChange: ((model?: string) => void) | undefined;
  let finishModeChange: ((value: { mode?: string; error?: string }) => void) | undefined;

  const stream = new ClaudeChatStream(launch, event => {
    if (event.kind === 'ready') clearTimeout(initializationTimer);
    emit(event);
  }, close, executable.version);

  function abort(): void { close(); }

  function close(reason?: string): void {
    if (closing || exited) return;
    closing = true;
    closedReason = reason;
    clearTimeout(initializationTimer);
    clearTimeout(interruptTimer);
    releaseInterrupt?.();
    finishModelChange?.();
    finishModeChange?.({ error: 'The chat closed before the mode change was confirmed.' });
    if (pendingWrite) {
      pendingWrite.finish(new Error(reason ?? unavailable));
      child.stdin.destroy();
    } else if (!child.stdin.destroyed) {
      child.stdin.end();
    }
    shutdownTimer = setTimeout(() => child.kill('SIGKILL'), 4000);
    shutdownTimer.unref();
  }

  function write(line: string): Promise<void> {
    if (closing || exited || !child.stdin.writable || pendingWrite) return Promise.reject(new Error(unavailable));
    // The callback completes only once libuv accepts the bounded write. Delivery is confirmed separately.
    const result = deferred<void>();
    const timer = setTimeout(() => close(lostInput), 15_000);
    timer.unref();
    function finish(error?: Error): void {
      if (pendingWrite?.finish !== finish) return;
      pendingWrite = undefined;
      clearTimeout(timer);
      if (error) result.reject(error);
      else result.resolve();
    }
    pendingWrite = { finish, promise: result.promise };
    try {
      child.stdin.write(line, error => {
        if (error) close(lostInput);
        else finish();
      });
    } catch {
      close(lostInput);
    }
    return result.promise;
  }

  const connection: ChatConnection = {
    async send(message) {
      if (waitingForInterrupt) await waitingForInterrupt;
      if (closing || exited || pendingWrite || finishModelChange || finishModeChange || !child.stdin.writable) throw new Error(unavailable);
      if (stream.active) throw new Error('Claude Code is still processing the previous message.');
      if (!stream.permits(message.command)) throw new Error('The command is unavailable on the current Claude Code channel.');
      if (!isClaudeSessionId(message.id) || typeof message.text !== 'string' || !message.text.trim()
          || message.text.length > maxInputBytes) throw new Error('The Claude Code message is empty or too large.');
      const line = JSON.stringify({ type: 'user', uuid: message.id,
        session_id: resume || stream.initialized ? identity.nativeId : '', parent_tool_use_id: null,
        message: { role: 'user', content: message.text },
      }) + '\n';
      if (Buffer.byteLength(line) > maxInputBytes) throw new Error('The Claude Code message is too large.');
      stream.begin(message.id, message.command, message.text);
      if (!stream.initialized) {
        initializationTimer = setTimeout(() => close('Claude Code did not initialize the selected conversation.'), 30_000);
        initializationTimer.unref();
      }
      await write(line);
    },
    async interrupt() {
      if (pendingWrite) await pendingWrite.promise;
      if (closing || exited || !child.stdin.writable) throw new Error(unavailable);
      const requestId = randomUUID();
      const receipt = deferred<void>();
      if (!stream.beginInterrupt(requestId, () => {
        clearTimeout(interruptTimer);
        releaseInterrupt = undefined;
        waitingForInterrupt = undefined;
        receipt.resolve();
      })) throw new Error('Claude Code cannot interrupt the current turn.');
      releaseInterrupt = receipt.resolve;
      waitingForInterrupt = receipt.promise;
      interruptTimer = setTimeout(() => close('Claude Code did not acknowledge the interrupt request.'), 10_000);
      interruptTimer.unref();
      await write(JSON.stringify({ type: 'control_request', request_id: requestId, request: { subtype: 'interrupt' } }) + '\n');
      return requestId;
    },
    async setModel(model) {
      if (closing || exited || pendingWrite || finishModelChange || !child.stdin.writable) return undefined;
      const id = randomUUID();
      const frame = modelControlFrame(id, model);
      if (!frame) return undefined;
      const result = deferred<string | undefined>();
      const finish = (resolved?: string) => {
        if (finishModelChange !== finish) return;
        finishModelChange = undefined;
        clearTimeout(timer);
        result.resolve(resolved);
      };
      if (!stream.beginModelChange(id, finish)) return undefined;
      const timer = setTimeout(() => close('The model change was not confirmed. Check the conversation before retrying.'), 10_000);
      timer.unref();
      finishModelChange = finish;
      await write(frame);
      return result.promise;
    },
    async setPermissionMode(mode) {
      if (closing || exited || pendingWrite || finishModeChange || !child.stdin.writable) return { error: 'Claude Code is not ready for a mode change.' };
      const id = randomUUID();
      const frame = permissionModeFrame(id, mode);
      if (!frame) return { error: 'That permission mode cannot be selected here.' };
      const result = deferred<{ mode?: string; error?: string }>();
      const finish = (value: { mode?: string; error?: string }) => {
        if (finishModeChange !== finish) return;
        finishModeChange = undefined;
        clearTimeout(timer);
        result.resolve(value);
      };
      if (!stream.beginModeChange(id, finish)) return { error: 'Claude Code cannot change the mode right now.' };
      const timer = setTimeout(() => close('The mode change was not confirmed. Check the conversation before retrying.'), 10_000);
      timer.unref();
      finishModeChange = finish;
      await write(frame);
      return result.promise;
    },
    close() {
      close();
      return closed.promise;
    },
  };

  readClaudeFrames(child.stdout, line => {
    if (!closing) stream.read(line);
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    // Search a bounded overlap for known diagnostics, including a line split across chunks.
    diagnostics ??= claudeDiagnostic(stderrTail + chunk.slice(0, 2048));
    stderrTail = (stderrTail + chunk.slice(-2048)).slice(-2048);
  });
  child.stdout.on('error', () => close('Claude Code stopped sending chat output.'));
  child.stdout.on('end', () => close(stream.active ? stream.failure ?? diagnostics ?? 'Claude Code stopped sending chat output.' : undefined));
  child.stderr.on('error', () => { stderrTail = ''; });
  child.stdin.on('error', () => close(lostInput));
  child.on('error', () => {
    if (child.pid === undefined) opened.reject(new ChatLaunchError(startFailed));
    else close(startFailed);
  });
  child.once('spawn', () => {
    if (signal.aborted) {
      close();
      void closed.promise.then(() => opened.reject(new ChatLaunchError(unavailable)));
    } else opened.resolve(connection);
  });
  child.once('exit', () => {
    exited = true;
    // Descendants can inherit a pipe. Drain the worker's final output, then detach our own handles.
    clearTimeout(shutdownTimer);
    child.stdin.destroy();
    drainTimer = setTimeout(() => {
      child.stdout.destroy();
      child.stderr.destroy();
    }, 1000);
    drainTimer.unref();
  });
  child.once('close', (code, exitSignal) => {
    exited = true;
    signal.removeEventListener('abort', abort);
    clearTimeout(shutdownTimer);
    clearTimeout(drainTimer);
    clearTimeout(initializationTimer);
    clearTimeout(interruptTimer);
    pendingWrite?.finish(new Error(unavailable));
    releaseInterrupt?.();
    finishModelChange?.();
    const reason = closedReason ?? (closing ? undefined : stream.failure ?? diagnostics ?? (
      stream.active || ((code !== 0 || exitSignal) && !(code === 1 && stream.lastOutcome === 'interrupted'))
        ? 'Claude Code exited before it could finish the chat.' : undefined
    ));
    stderrTail = '';
    closed.resolve();
    emit({ ...launch, kind: 'exit', ...(reason ? { reason } : {}) });
  });
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  return opened.promise;
}

export const claudeChatAdapter: ChatAdapter = {
  checkWriter,
  async open(launch, emit, signal) {
    if (process.platform !== 'win32') throw new ChatLaunchError('Agent Lens chat currently requires the Windows Claude Code executable.');
    if (launch.identity.provider !== 'claude-code' || !isClaudeSessionId(launch.identity.nativeId)) {
      throw new ChatLaunchError('Claude Code requires an exact session ID to open chat.');
    }
    if (signal.aborted) throw new ChatLaunchError(unavailable);
    const executable = await verifiedExecutable(signal);
    const { cwd, home } = launch.identity;
    if (localPath(cwd) !== cwd || localPath(home) !== home) throw new ChatLaunchError('The Claude Code profile or project folder is unavailable.');
    try {
      await Promise.all([inspectLocal(cwd, 'directory'), inspectLocal(home, 'directory')]);
    } catch {
      throw new ChatLaunchError('The Claude Code profile or project folder is unavailable.');
    }
    if (launch.resume) {
      const writer = await checkWriter(launch.identity);
      if (writer === 'present') throw new ChatLaunchError('This Claude Code conversation is open in another process. Close that conversation before continuing here.');
      if (writer === 'unknown') throw new ChatLaunchError('Agent Lens could not verify the current writer for this Claude Code conversation.');
    }
    if (signal.aborted) throw new ChatLaunchError(unavailable);
    return openWorker(executable, launch, emit, signal);
  },
};
