import { createHash } from 'node:crypto';
import type { Event, Outcome, Source } from '../adapters/types';
import type { ChatRowIdentity } from '../chat/types';
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

/** Response ids identify an API response, which can have several distinct blocks. */
export function identityKey(identity: ChatRowIdentity): string | undefined {
  const { kind, id } = identity;
  if (kind === 'response') {
    if (identity.block === undefined) return undefined;
    return key('identity', kind, id, identity.record,
      identity.recordIndex === undefined ? undefined : String(identity.recordIndex), String(identity.block));
  }
  return key('identity', kind, id, kind === 'task' ? identity.state : undefined);
}

export function sourceSessionId(source: Pick<Source, 'provider' | 'home' | 'sessionId'>, nativeId = source.sessionId): string {
  return key(source.provider, sourceIdentityHome(source), nativeId.toLowerCase());
}

function sourceIdentityHome(source: Pick<Source, 'home'>): string {
  return /^[a-z]:[\\/]/i.test(source.home) ? source.home.replace(/\\/g, '/').toLowerCase() : source.home;
}

/** Use the recorded parser's block coordinates, including its explicit API index where present. */
export function recordedChatKeys(item: Positioned, result?: Kind<'result'>): string[] | undefined {
  const { source, event } = item;
  if (source.provider !== 'claude-code' || item.ambiguous) return undefined;
  const identities: ChatRowIdentity[] = [];
  if (event.kind === 'message' && event.role === 'user' && event.recordId) {
    identities.push({ kind: 'user', id: event.recordId });
  } else if (event.kind === 'message' && event.responseId && ['assistant', 'final'].includes(event.role)) {
    const prefix = `${source.key}:record:${event.recordId}:`;
    const block = event.recordId && event.id.startsWith(prefix)
      ? /^(\d*):block:(\d+)$/.exec(event.id.slice(prefix.length)) : undefined;
    if (block && event.recordId) {
      identities.push({ kind: 'response', id: event.responseId, record: event.recordId,
        recordIndex: block[1] ? Number(block[1]) : undefined, block: Number(block[2]) });
      if (block[1] && block[2] === '0') {
        identities.push({ kind: 'response', id: event.responseId, block: Number(block[1]) });
      }
    }
  } else if (event.kind === 'call') {
    identities.push({ kind: 'call', id: event.callId });
    if (result) identities.push({ kind: 'result', id: result.callId });
  } else if (event.kind === 'result') {
    identities.push({ kind: 'result', id: event.callId });
  } else if (event.kind === 'task') {
    identities.push({ kind: 'task', id: event.taskId, state: event.state });
  }
  return identities.length ? identities.flatMap(identity => identityKey(identity) ?? []) : undefined;
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
