import { spawn } from 'node:child_process';
import { mkdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { record } from '../privacy/projection';
import type { LimitSample } from './model';

/**
 * Read Claude's 5-hour and weekly limits with one tiny headless call (`claude -p`). Claude Code prints a
 * `rate_limit_event` in its stream-json output for every request, so one short Haiku turn is enough.
 * The call runs in an empty folder with only project settings, no MCP servers and no tools, so the user's
 * hooks, plugins and memory are not triggered. Only the window numbers are kept.
 */

export interface ProbeWindows {
  fiveHour?: { usedPercent: number; resetsAt: number };
  sevenDay?: { usedPercent: number; resetsAt: number };
}

export type ProbeResult =
  | { ok: true; windows: ProbeWindows; at: number }
  | { ok: false; message: string };

export const probeArgs = [
  '-p', 'Reply with OK',
  '--output-format', 'stream-json', '--verbose',
  '--model', 'haiku', '--max-turns', '1',
  '--no-session-persistence',
  '--setting-sources', 'project',
  '--strict-mcp-config',
  '--tools', '',
] as const;

const timeoutMs = 60_000;
const maxLineChars = 64 * 1024;

function window(value: unknown): { usedPercent: number; resetsAt: number } | undefined {
  const row = record(value);
  const utilization = row?.utilization;
  const resets = row?.resetsAt;
  if (typeof utilization !== 'number' || !Number.isFinite(utilization) || utilization < 0 || utilization > 1) return undefined;
  if (typeof resets !== 'number' || !Number.isFinite(resets) || resets <= 0) return undefined;
  const resetsAt = resets < 10_000_000_000 ? resets * 1000 : resets;
  return { usedPercent: Math.round(utilization * 1000) / 10, resetsAt: Math.round(resetsAt) };
}

/** Parse one stream-json line. Returns the windows when the line is a `rate_limit_event` with unified windows. */
export function parseRateLimitLine(line: string): ProbeWindows | undefined {
  if (line.length > maxLineChars || !line.includes('rate_limit_event')) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  const event = record(parsed);
  if (event?.type !== 'rate_limit_event') return undefined;
  const windows = record(record(event.rate_limit_info)?.unifiedWindows);
  if (!windows) return undefined;
  const result: ProbeWindows = { fiveHour: window(windows.five_hour), sevenDay: window(windows.seven_day) };
  return result.fiveHour || result.sevenDay ? result : undefined;
}

export function probeSamples(result: Extract<ProbeResult, { ok: true }>, profile: string): LimitSample[] {
  const samples: LimitSample[] = [];
  for (const [minutes, value] of [[300, result.windows.fiveHour], [10080, result.windows.sevenDay]] as const) {
    if (value) samples.push({ provider: 'claude-code', profile, minutes, usedPercent: value.usedPercent, resetsAt: value.resetsAt, at: result.at });
  }
  return samples;
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * Find the native Claude executable. On Windows the npm `claude.cmd` shim cannot be spawned without a shell,
 * so resolve the `claude.exe` it points to.
 */
export async function resolveClaude(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): Promise<string | undefined> {
  const directories = (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean);
  if (platform !== 'win32') {
    for (const directory of directories) if (await isFile(join(directory, 'claude'))) return join(directory, 'claude');
    return undefined;
  }
  for (const directory of directories) {
    if (await isFile(join(directory, 'claude.exe'))) return join(directory, 'claude.exe');
    if (await isFile(join(directory, 'claude.cmd'))) {
      const native = join(directory, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
      if (await isFile(native)) return native;
    }
  }
  return undefined;
}

function sameFolder(a: string, b: string): boolean {
  const normalize = (value: string) => process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value);
  return normalize(a) === normalize(b);
}

/** Environment for a profile. The default home keeps Claude's own lookup, because setting the variable moves `.claude.json`. */
export function profileEnv(home: string, env: NodeJS.ProcessEnv = process.env, userHome: string = homedir()): NodeJS.ProcessEnv {
  const next = { ...env };
  for (const key of Object.keys(next)) {
    if ((process.platform === 'win32' ? key.toUpperCase() : key) === 'CLAUDE_CONFIG_DIR') delete next[key];
  }
  if (!sameFolder(home, join(userHome, '.claude'))) next.CLAUDE_CONFIG_DIR = home;
  return next;
}

/** Run the probe once for a profile home. `workdir` must be an Agent Lens-owned folder. */
export async function probeClaudeLimits(home: string, workdir: string, now: () => number = Date.now): Promise<ProbeResult> {
  const executable = await resolveClaude();
  if (!executable) return { ok: false, message: 'Claude Code was not found on PATH.' };
  await mkdir(workdir, { recursive: true });
  return new Promise<ProbeResult>(done => {
    let timedOut = false;
    let startFailed = false;
    let windows: ProbeWindows | undefined;
    let buffer = '';
    const child = spawn(executable, [...probeArgs], { cwd: workdir, env: profileEnv(home), windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        windows = parseRateLimitLine(buffer.slice(0, index).trim()) ?? windows;
        buffer = buffer.slice(index + 1);
      }
      if (buffer.length > maxLineChars) buffer = '';
    });
    let settled = false;
    const finish = (result: ProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done(result);
    };
    // A failed spawn may emit 'error' without 'close', so settle here as well.
    child.on('error', () => {
      startFailed = true;
      if (child.pid === undefined) finish({ ok: false, message: 'Claude Code could not be started.' });
    });
    child.on('close', code => {
      windows = parseRateLimitLine(buffer.trim()) ?? windows;
      if (windows) finish({ ok: true, windows, at: now() });
      else if (timedOut) finish({ ok: false, message: 'Claude did not answer within 60 seconds.' });
      else if (startFailed) finish({ ok: false, message: 'Claude Code could not be started.' });
      else if (code === 0) finish({ ok: false, message: 'Claude answered without limit data. This account may not report subscription limits.' });
      else finish({ ok: false, message: 'Claude exited with code ' + code + '. Check that this profile is signed in.' });
    });
  });
}
