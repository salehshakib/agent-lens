import { randomBytes } from 'node:crypto';
import { safeText } from '../privacy/projection';

/** How long a live permission request waits for a person. No plan value exists, so this is the default. */
export const approvalDeadlineMs = 10 * 60_000;
const maxPreview = 6000;
const maxValue = 4000;
const maxEntries = 12;
const maxSettled = 64;

export type ApprovalDecision = 'allow' | 'deny';
export type ApprovalRefusal = 'unknown' | 'duplicate' | 'panel' | 'owner' | 'turn';

function preview(value: unknown, depth: number): string {
  if (typeof value === 'string') return JSON.stringify(safeText(value, maxValue) ?? '');
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return String(value);
  if (depth > 2) return '…';
  if (Array.isArray(value)) {
    return '[' + value.slice(0, maxEntries).map(item => preview(item, depth + 1)).join(', ') + (value.length > maxEntries ? ', …' : '') + ']';
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value as object).sort();
    const parts = keys.slice(0, maxEntries).map(key => (safeText(key, 60) ?? '?') + ': ' + preview((value as Record<string, unknown>)[key], depth + 1));
    return '{' + parts.join(', ') + (keys.length > maxEntries ? ', …' : '') + '}';
  }
  return '…';
}

/** A bounded, redacted, display-only summary. The original input never leaves the adapter. */
export function previewInput(input: unknown): string {
  const text = preview(input, 0);
  return text.length > maxPreview ? text.slice(0, maxPreview) + '…' : text;
}

export interface LedgerEntry {
  /** Opaque host-issued id shown to the webview. */
  id: string;
  /** The provider's native request id. */
  requestId: string;
  toolUseId: string;
  /** Conversation key of the only panel allowed to decide. */
  key: string;
  /** Connection owner token that was current when the request arrived. */
  owner: string;
  turnId: string;
}

/** Host-side record of live requests. Every decision is rechecked here before the adapter sees it. */
export class ApprovalLedger {
  private readonly live = new Map<string, LedgerEntry>();
  private readonly settled = new Set<string>();

  add(entry: Omit<LedgerEntry, 'id'>): LedgerEntry {
    const created = { ...entry, id: randomBytes(32).toString('hex') };
    this.live.set(created.id, created);
    return created;
  }

  find(id: string): LedgerEntry | undefined { return this.live.get(id); }

  findByRequest(requestId: string): LedgerEntry | undefined {
    for (const entry of this.live.values()) if (entry.requestId === requestId) return entry;
    return undefined;
  }

  /** Consume the entry once. A second claim is a duplicate. Any mismatch leaves the request pending. */
  claim(id: string, context: { key: string; owner: string | undefined; turnId: string | undefined }):
    { entry: LedgerEntry } | { refused: ApprovalRefusal } {
    const entry = this.live.get(id);
    if (!entry) return { refused: this.settled.has(id) ? 'duplicate' : 'unknown' };
    if (entry.key !== context.key) return { refused: 'panel' };
    if (!context.owner || entry.owner !== context.owner) return { refused: 'owner' };
    if (!context.turnId || entry.turnId !== context.turnId) return { refused: 'turn' };
    this.settle(id);
    return { entry };
  }

  /** Forget a request without a decision (timeout, close, interrupt). */
  settle(id: string): LedgerEntry | undefined {
    const entry = this.live.get(id);
    if (!entry) return undefined;
    this.live.delete(id);
    this.settled.add(id);
    if (this.settled.size > maxSettled) this.settled.delete(this.settled.values().next().value!);
    return entry;
  }

  settleAll(key: string): readonly LedgerEntry[] {
    const gone: LedgerEntry[] = [];
    for (const entry of [...this.live.values()]) if (entry.key === key) gone.push(this.settle(entry.id)!);
    return gone;
  }
}
