import { createHash } from 'node:crypto';
import { open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { record } from '../privacy/projection';
import type { LimitSample } from './model';

export const snapshotVersion = 1;
export const maxSnapshotBytes = 16 * 1024;
const maxSnapshots = 256;
const contextFreshMs = 10 * 60_000;

export interface RelayWindow {
  usedPercent: number;
  /** Epoch milliseconds. Claude reports epoch seconds. */
  resetsAt: number;
}

/** The allowlisted projection a relay publishes. Nothing else from the status-line payload is stored. */
export interface RelaySnapshot {
  v: typeof snapshotVersion;
  capturedAt: number;
  sessionId?: string;
  fiveHour?: RelayWindow;
  sevenDay?: RelayWindow;
  context?: { usedPercent?: number; windowSize?: number };
}

function percent(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 ? value : undefined;
}

function milliseconds(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  const ms = value < 10_000_000_000 ? value * 1000 : value;
  return ms <= 8_640_000_000_000_000 ? Math.round(ms) : undefined;
}

function window(value: unknown): RelayWindow | undefined {
  const row = record(value);
  const used = percent(row?.used_percentage ?? row?.usedPercent);
  const resets = milliseconds(row?.resets_at ?? row?.resetsAt);
  return used !== undefined && resets !== undefined ? { usedPercent: used, resetsAt: resets } : undefined;
}

function windowSize(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

export function sessionToken(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) ? value : undefined;
}

/** Project a raw Claude status-line payload into the allowlisted snapshot. */
export function projectStatusLine(payload: unknown, now: number): RelaySnapshot | undefined {
  const input = record(payload);
  if (!input) return undefined;
  const limits = record(input.rate_limits);
  const context = record(input.context_window);
  const snapshot: RelaySnapshot = {
    v: snapshotVersion,
    capturedAt: now,
    sessionId: sessionToken(input.session_id),
    fiveHour: window(limits?.five_hour),
    sevenDay: window(limits?.seven_day),
    context: { usedPercent: percent(context?.used_percentage), windowSize: windowSize(context?.context_window_size) },
  };
  if (snapshot.context?.usedPercent === undefined && snapshot.context?.windowSize === undefined) delete snapshot.context;
  return snapshot.fiveHour || snapshot.sevenDay || snapshot.context ? snapshot : undefined;
}

/** Validate an on-disk snapshot. Unknown fields are dropped. */
export function parseSnapshot(value: unknown): RelaySnapshot | undefined {
  const input = record(value);
  if (!input || input.v !== snapshotVersion) return undefined;
  const capturedAt = milliseconds(input.capturedAt);
  if (capturedAt === undefined) return undefined;
  const context = record(input.context);
  return {
    v: snapshotVersion,
    capturedAt,
    sessionId: sessionToken(input.sessionId),
    fiveHour: window(input.fiveHour),
    sevenDay: window(input.sevenDay),
    context: context ? { usedPercent: percent(context.usedPercent), windowSize: windowSize(context.windowSize) } : undefined,
  };
}

export function snapshotFileName(sessionId: string | undefined): string {
  return (sessionToken(sessionId) ?? 'unknown') + '.json';
}

/** Stable per-profile key for relay storage. */
export function profileKey(home: string): string {
  const normalized = /^[a-z]:[\\/]/i.test(home) ? home.replace(/\\/g, '/').toLowerCase() : home;
  return createHash('sha256').update(normalized).digest('hex').slice(0, 24);
}

/** Read every per-session snapshot in a profile directory. */
export async function readSnapshots(directory: string): Promise<RelaySnapshot[]> {
  let names: string[];
  try {
    names = (await readdir(directory)).filter(name => name.endsWith('.json')).slice(0, maxSnapshots);
  } catch {
    return [];
  }
  const snapshots: RelaySnapshot[] = [];
  for (const name of names) {
    let handle;
    try {
      handle = await open(join(directory, name), 'r');
      if ((await handle.stat()).size > maxSnapshotBytes) continue;
      const parsed = parseSnapshot(JSON.parse(await handle.readFile('utf8')));
      if (parsed) snapshots.push(parsed);
    } catch {
      // A partial or foreign file is ignored. The relay replaces files atomically.
    } finally {
      await handle?.close();
    }
  }
  return snapshots;
}

/** Newest valid sample per window across all session snapshots. */
export function limitSamples(snapshots: readonly RelaySnapshot[], profile: string): LimitSample[] {
  const samples: LimitSample[] = [];
  for (const snapshot of snapshots) {
    for (const [minutes, window] of [[300, snapshot.fiveHour], [10080, snapshot.sevenDay]] as const) {
      if (window) {
        samples.push({ provider: 'claude-code', profile, minutes, usedPercent: window.usedPercent,
          resetsAt: window.resetsAt, at: snapshot.capturedAt });
      }
    }
  }
  return samples;
}

export interface RelayContext {
  percent: number;
  windowSize?: number;
  at: number;
}

/** Context fill reported by the relay for the main session it names. A stale or future value is dropped. */
export function relayContext(snapshots: readonly RelaySnapshot[], nativeSessionId: string, now: number): RelayContext | undefined {
  let best: RelayContext | undefined;
  for (const snapshot of snapshots) {
    if (snapshot.sessionId !== nativeSessionId || snapshot.context?.usedPercent === undefined) continue;
    if (now - snapshot.capturedAt > contextFreshMs || snapshot.capturedAt > now + 60_000) continue;
    if (!best || snapshot.capturedAt > best.at) {
      best = { percent: snapshot.context.usedPercent, windowSize: snapshot.context.windowSize, at: snapshot.capturedAt };
    }
  }
  return best;
}
