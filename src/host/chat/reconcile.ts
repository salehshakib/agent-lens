import type { Tokens } from '../adapters/types';
import { identityKey, sourceSessionId } from '../sessions/evidence';
import type { Source } from '../adapters/types';
import type { ChatIdentity } from './types';

export type { Tokens };

/** A row from the recorded session. `keys` are exact provider identity hashes. */
export interface RecordedRow {
  id: string;
  keys?: readonly string[];
}

/** A provisional row from the live stream with the exact provider identity it was observed under. */
export interface ProvisionalRow {
  id: string;
  /** Local prompt uuid, API response id or tool call id. Absent when the stream did not report one. */
  identity?: { kind: 'user' | 'response' | 'call'; id: string };
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
  return sourceSessionId({ provider: identity.provider, home: identity.home } as Source, identity.nativeId);
}

/**
 * Match provisional stream rows against recorded rows by exact provider identity. Rows without a match stay.
 * Nothing merges unless the recorded session is the one this conversation's verified scope derives.
 */
export function reconcileRows<P extends ProvisionalRow>(
  recorded: readonly RecordedRow[], provisional: readonly P[], scopeVerified: boolean,
): Reconciled<P> {
  const byKey = new Map<string, string>();
  if (scopeVerified) for (const row of recorded) for (const key of row.keys ?? []) if (!byKey.has(key)) byKey.set(key, row.id);
  const live: P[] = [];
  const unresolved: P[] = [];
  const resolved = new Map<string, string>();
  for (const row of provisional) {
    const match = scopeVerified && row.identity ? byKey.get(identityKey(row.identity.kind, row.identity.id)) : undefined;
    if (match) resolved.set(row.id, match);
    else {
      live.push(row);
      if (!row.identity || !scopeVerified) unresolved.push(row);
    }
  }
  return { live, resolved, unresolved };
}

/** An observed turn's usage. `id` is the exact response or turn identity the usage belongs to. */
export interface UsageObservation {
  id: string;
  tokens: Tokens;
}

/** Live usage that recorded evidence has not counted yet. Each observed id counts once. */
export function reconcileUsage(recordedIds: ReadonlySet<string>, live: readonly UsageObservation[]): UsageObservation[] {
  const seen = new Set(recordedIds);
  const out: UsageObservation[] = [];
  for (const item of live) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}
