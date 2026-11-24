import { spawn } from 'node:child_process';
import { mkdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { record } from '../privacy/projection';
import type { LimitSample } from './model';

export interface ProbeWindows {
  fiveHour?: { usedPercent: number; resetsAt: number };
  sevenDay?: { usedPercent: number; resetsAt: number };
}

export type ProbeResult =
  | { ok: true; windows: ProbeWindows; at: number }
  | { ok: false; message: string };

export const probeArgs = [
  '-p', '/usage',
  '--output-format', 'stream-json', '--verbose',
  '--model', 'haiku',
  '--tools', '',
  '--no-session-persistence',
  '--setting-sources', 'project',
  '--strict-mcp-config',
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
  return rateLimitWindows(event);
}

/** Validate `five_hour` and `seven_day` of one `rate_limit_event` independently. */
export function rateLimitWindows(event: Record<string, unknown>): ProbeWindows | undefined {
  const windows = record(record(event.rate_limit_info)?.unifiedWindows);
  if (!windows) return undefined;
  const result: ProbeWindows = { fiveHour: window(windows.five_hour), sevenDay: window(windows.seven_day) };
  return result.fiveHour || result.sevenDay ? result : undefined;
}

const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayMs = 86_400_000;

/** Represent a timestamp's local calendar fields as UTC so their difference gives the zone offset. */
function localTime(formatter: Intl.DateTimeFormat, timestamp: number): number {
  const parts = new Map(formatter.formatToParts(timestamp).map(({ type, value }) => [type, Number(value)]));
  return Date.UTC(parts.get('year')!, parts.get('month')! - 1, parts.get('day')!,
    parts.get('hour')!, parts.get('minute')!);
}

function parseReset(reset: string, at: number): number | undefined {
  const match = /^(?:([A-Z][a-z]{2}) (\d{1,2}), )?(\d{1,2})(?::(\d{2}))?(am|pm) \(([A-Za-z][A-Za-z0-9_+/-]*)\)$/.exec(reset);
  if (!match) return undefined;
  const [, monthName, day, hourText, minuteText, period, timeZone] = match;
  const hour = Number(hourText);
  const minute = Number(minuteText ?? 0);
  if (!timeZone || hour < 1 || hour > 12 || minute > 59) return undefined;

  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', hourCycle: 'h23',
    });
  } catch {
    return undefined;
  }
  const today = new Date(localTime(formatter, at));
  const month = monthName ? months.indexOf(monthName) : today.getUTCMonth();
  const date = day ? Number(day) : today.getUTCDate();
  if (month < 0 || date < 1 || date > 31) return undefined;
  const year = today.getUTCFullYear();
  for (const candidateYear of monthName ? [year, year + 1] : [year]) {
    const wallTime = Date.UTC(candidateYear, month, date, hour % 12 + (period === 'pm' ? 12 : 0), minute);
    if (new Date(wallTime).getUTCMonth() !== month) continue;
    // Sample both sides of nearby offset changes and check the round trip at each candidate.
    const candidates = [wallTime - dayMs, wallTime, wallTime + dayMs]
      .map(point => wallTime - (localTime(formatter, point) - point))
      .filter(point => point > at && point <= at + 8 * dayMs && localTime(formatter, point) === wallTime);
    if (candidates.length) return Math.min(...candidates);
  }
  return undefined;
}

/** Decode the structured `usage_report.rate_limits.limits` the CLI attaches to its local `/usage` record. */
export function parseUsageReport(value: unknown): ProbeWindows | undefined {
  const limits = record(record(value)?.rate_limits)?.limits;
  if (!Array.isArray(limits)) return undefined;
  const windows: ProbeWindows = {};
  for (const item of limits) {
    const row = record(item);
    const key = row?.kind === 'session' ? 'fiveHour' : row?.kind === 'weekly_all' ? 'sevenDay' : undefined;
    const percent = row?.percent;
    const reset = typeof row?.resets_at === 'string' ? Date.parse(row.resets_at) : NaN;
    if (!key || windows[key] || typeof percent !== 'number' || !Number.isFinite(percent) || percent < 0 || percent > 100 || !Number.isFinite(reset)) continue;
    windows[key] = { usedPercent: percent, resetsAt: reset };
  }
  return windows.fiveHour || windows.sevenDay ? windows : undefined;
}

function readUsageWindows(text: string, at: number): ProbeWindows | undefined {
  const windows: ProbeWindows = {};
  for (const line of text.split('\n')) {
    const match = /^(Current session|Current week \(all models\)): (\d{1,3})% used · resets (.+)$/.exec(line.trim());
    if (!match?.[3]) continue;
    const usedPercent = Number(match[2]);
    if (usedPercent > 100) continue;
    const resetsAt = parseReset(match[3], at);
    if (resetsAt === undefined) continue;
    const key = match[1] === 'Current session' ? 'fiveHour' : 'sevenDay';
    windows[key] = { usedPercent, resetsAt };
    if (windows.fiveHour && windows.sevenDay) return windows;
  }
  return undefined;
}

/** Read stream-json records, keeping only the parsed windows. */
export class UsageReport {
  private resultWindows?: ProbeWindows;
  private assistantWindows?: ProbeWindows;
  private structuredWindows?: ProbeWindows;

  read(line: string, at: number): void {
    if (this.structuredWindows || this.resultWindows || line.length > maxLineChars) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line.trim());
    } catch {
      return;
    }
    const event = record(parsed);
    if (event && 'usage_report' in event) this.structuredWindows ??= parseUsageReport(event.usage_report);
    if (this.structuredWindows) return;
    if (event?.type === 'result' && typeof event.result === 'string') {
      this.resultWindows = readUsageWindows(event.result, at);
    } else if (event?.type === 'assistant' && !this.assistantWindows) {
      const content = record(event.message)?.content;
      if (!Array.isArray(content)) return;
      const text = content.map(record)
        .map(block => block?.type === 'text' && typeof block.text === 'string' ? block.text : '').join('\n');
      this.assistantWindows = readUsageWindows(text, at);
    }
  }

  finish(at: number): ProbeResult {
    const windows = this.structuredWindows ?? this.resultWindows ?? this.assistantWindows;
    return windows
      ? { ok: true, windows, at }
      : { ok: false, message: 'Claude Code usage report format was not recognized.' };
  }
}

export function probeSamples(result: Extract<ProbeResult, { ok: true }>, profile: string): LimitSample[] {
  const samples: LimitSample[] = [];
  for (const [minutes, value] of [[300, result.windows.fiveHour], [10080, result.windows.sevenDay]] as const) {
    if (value) samples.push({ provider: 'claude-code', profile, minutes, usedPercent: value.usedPercent, resetsAt: value.resetsAt, at: result.at });
  }
  return samples;
}

/**
 * PATH entries plus the folders Claude Code's installers use. VS Code started from a launcher often lacks
 * `~/.local/bin` and the npm folder, which made Refresh limits report "not found" although chat could find Claude.
 */
export function claudeSearchDirectories(env: NodeJS.ProcessEnv, userHome: string): string[] {
  const fromPath = (env.PATH ?? env.Path ?? '').split(delimiter).map(entry => entry.replace(/^"|"$/g, '')).filter(Boolean);
  const extra = [join(userHome, '.local', 'bin')];
  if (env.APPDATA) extra.push(join(env.APPDATA, 'npm'));
  return [...new Set([...fromPath, ...extra])];
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
export async function resolveClaude(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, userHome: string = homedir()): Promise<string | undefined> {
  const directories = claudeSearchDirectories(env, userHome);
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

/** Run Claude Code's local usage command once. `workdir` must be an Agent Lens-owned folder. */
export async function probeClaudeLimits(home: string, workdir: string, now: () => number = Date.now): Promise<ProbeResult> {
  const executable = await resolveClaude();
  if (!executable) return { ok: false, message: 'Claude Code was not found on PATH.' };
  await mkdir(workdir, { recursive: true });
  return new Promise<ProbeResult>(done => {
    let timedOut = false;
    let startFailed = false;
    const report = new UsageReport();
    let buffer = '';
    let discardingLine = false;
    const child = spawn(executable, [...probeArgs], {
      cwd: workdir, env: profileEnv(home), shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        if (!discardingLine) report.read(buffer.slice(0, index), now());
        discardingLine = false;
        buffer = buffer.slice(index + 1);
      }
      if (buffer.length > maxLineChars) {
        discardingLine = true;
        buffer = '';
      }
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
    child.on('close', () => {
      const at = now();
      if (!discardingLine && buffer) report.read(buffer, at);
      if (timedOut) finish({ ok: false, message: 'Claude did not answer within 60 seconds.' });
      else if (startFailed) finish({ ok: false, message: 'Claude Code could not be started.' });
      else finish(report.finish(at));
    });
  });
}
