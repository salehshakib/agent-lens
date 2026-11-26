import { identityKey, key, sourceSessionId } from '../sessions/evidence';
import type { Turn } from '../sessions/types';
import type { ChatIdentity, ChatRowIdentity, ChatTurnUsage } from './types';

/** A row from the recorded session. `keys` are exact provider identity hashes. */
export interface RecordedRow {
  id: string;
  keys?: readonly string[];
}

/** A provisional row from the live stream with the exact provider identity it was observed under. */
export interface ProvisionalRow {
  id: string;
  identity?: ChatRowIdentity;
  aliases?: readonly ChatRowIdentity[];
}

export interface Reconciled<P extends ProvisionalRow> {
  /** Provisional rows that recorded evidence does not yet cover, in stream order. */
  live: P[];
  /** Provisional rows now represented by a recorded row, keyed by provisional id. */
  resolved: Map<string, string>;
  /** Provisional rows with no exact identity or no verified scope. They stay visible and explicit. */
  unresolved: P[];
}

/** The session id the recorded store derives for this conversation. Equality is the verified-scope check. */
export function scopeSessionId(identity: ChatIdentity): string {
  return sourceSessionId({ provider: identity.provider, home: identity.home, sessionId: identity.nativeId });
}

/**
 * Match provisional stream rows against recorded rows by exact provider identity. Rows without a match stay.
 * Nothing merges unless the recorded session is the one this conversation's verified scope derives.
 */
export function reconcileRows<P extends ProvisionalRow>(
  recorded: readonly RecordedRow[], provisional: readonly P[], scopeVerified: boolean,
): Reconciled<P> {
  const byKey = new Map<string, string | null>();
  if (scopeVerified) {
    for (const row of recorded) for (const nativeKey of row.keys ?? []) {
      const current = byKey.get(nativeKey);
      byKey.set(nativeKey, current === undefined || current === row.id ? row.id : null);
    }
  }
  const live: P[] = [];
  const unresolved: P[] = [];
  const resolved = new Map<string, string>();
  for (const row of provisional) {
    const identities = row.identity ? [row.identity, ...row.aliases ?? []] : row.aliases ?? [];
    const keys = identities.flatMap(identity => identityKey(identity) ?? []);
    const matches = new Set(keys.flatMap(nativeKey => {
      const match = byKey.get(nativeKey);
      return match === undefined ? [] : [match];
    }));
    const candidates = [...matches].filter(match => match !== null);
    if (candidates.length === 1) {
      resolved.set(row.id, candidates[0]!);
      continue;
    }
    live.push(row);
    if (!keys.length || !scopeVerified || matches.size > 0) unresolved.push(row);
  }
  return { live, resolved, unresolved };
}

/** Live usage that recorded evidence has not counted yet. Each observed id counts once. */
export function reconcileUsage(recordedIds: ReadonlySet<string>, live: readonly ChatTurnUsage[]): ChatTurnUsage[] {
  const seen = new Set(recordedIds);
  const out: ChatTurnUsage[] = [];
  for (const item of live) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

export function recordedTurnId(laneId: string, nativeId: string): string {
  return key(laneId, 'turn', nativeId);
}

const terminal = new Set<Turn['state']>(['Completed', 'Failed', 'Aborted', 'Interrupted', 'Stopped']);

/** A stdout result is a turn total. Never combine it with responses from that same turn. */
export function reconcileTurnUsage(turns: readonly Turn[], laneId: string, observed: readonly ChatTurnUsage[]): {
  live: ChatTurnUsage[]; replacedTurnIds: Set<string>;
} {
  const byId = new Map(turns.map(turn => [turn.id, turn]));
  const live: ChatTurnUsage[] = [];
  const replacedTurnIds = new Set<string>();
  for (const sample of reconcileUsage(new Set(), observed)) {
    const id = recordedTurnId(laneId, sample.id);
    const turn = byId.get(id);
    if (turn?.usage && terminal.has(turn.state)) continue;
    if (turn?.usage) replacedTurnIds.add(id);
    live.push(sample);
  }
  return { live, replacedTurnIds };
}
