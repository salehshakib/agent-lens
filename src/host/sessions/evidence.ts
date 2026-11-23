import { createHash } from 'node:crypto';
import type { Event, Outcome, Source } from '../adapters/types';
import type { State } from './types';

export type Kind<K extends Event['kind']> = Extract<Event, { kind: K }>;

export interface SourceEvidence {
  source: Source;
  events: Iterable<Event>;
  partial: boolean;
}

export interface Positioned<E extends Event = Event> {
  event: E;
  source: Source;
  order: number;
  laneId: string;
  turnId?: string;
  cwd?: string;
  currentBranch?: boolean;
  ambiguous?: boolean;
  rowKey?: string;
}

export function isKind<K extends Event['kind']>(item: Positioned, kind: K): item is Positioned<Kind<K>> {
  return item.event.kind === kind;
}

export function key(...parts: (string | undefined)[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32);
}

export function sourceSessionId(source: Source, nativeId = source.sessionId): string {
  return key(source.provider, sourceIdentityHome(source), nativeId.toLowerCase());
}

function sourceIdentityHome(source: Source): string {
  return /^[a-z]:[\\/]/i.test(source.home) ? source.home.replace(/\\/g, '/').toLowerCase() : source.home;
}

export const stateByOutcome: Record<Outcome, State> = {
  running: 'Live',
  completed: 'Completed',
  failed: 'Failed',
  interrupted: 'Interrupted',
  aborted: 'Aborted',
};

export function fresh(at: number | undefined, now: number): boolean {
  return at !== undefined && at <= now && now - at <= 30_000;
}

export function latestTime(first?: number, second?: number): number | undefined {
  if (first === undefined) return second;
  return second === undefined ? first : Math.max(first, second);
}

export function firstTitle(text?: string): string | undefined {
  const lines = text?.split('\n').map(line => line.trim()).filter(Boolean) ?? [];
  const line = lines.find(value => /^#{1,6}\s+\S/.test(value)) ?? lines[0];
  return line?.replace(/^#{1,6}\s+/, '').slice(0, 160);
}
