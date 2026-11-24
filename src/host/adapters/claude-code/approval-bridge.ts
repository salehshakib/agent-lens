import { previewInput, approvalDeadlineMs } from '../../chat/approvals';
import type { ApprovalDecision } from '../../chat/approvals';
import { safeText } from '../../privacy/projection';
import { supportsClaudeCodeVersion } from './version';

/** Live evidence: Claude Code 2.1.330 `--permission-prompt-tool stdio` (docs/plan/m2-compatibility.md, Phase F). */
export function permissionPromptArgs(version: string | undefined): readonly string[] {
  return supportsClaudeCodeVersion(version) ? ['--permission-prompt-tool', 'stdio'] : ['--permission-prompts', 'none'];
}

export interface ApprovalRequest {
  requestId: string;
  toolUseId: string;
  toolName: string;
  description?: string;
  /** The exact input the CLI asked about. It is replayed unchanged on allow and never shown raw. */
  input: Record<string, unknown>;
}

const id = /^[A-Za-z0-9_.:-]{1,200}$/;

function plain(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** Native request id of a `can_use_tool` frame, even when the rest is unusable, so it can still be denied. */
export function approvalRequestId(row: Record<string, unknown>): string | undefined {
  const value = row.request_id;
  return typeof value === 'string' && id.test(value) ? value : undefined;
}

/** Strictly validate a `control_request` / `can_use_tool` frame. Anything missing or off-shape is rejected. */
export function parseApprovalRequest(row: Record<string, unknown>): ApprovalRequest | undefined {
  if (row.type !== 'control_request') return undefined;
  const request = plain(row.request);
  const requestId = approvalRequestId(row);
  if (!request || request.subtype !== 'can_use_tool' || !requestId) return undefined;
  const { tool_name: toolName, tool_use_id: toolUseId, input, description } = request;
  if (typeof toolName !== 'string' || !toolName || toolName.length > 120) return undefined;
  if (typeof toolUseId !== 'string' || !id.test(toolUseId)) return undefined;
  const original = plain(input);
  if (!original) return undefined;
  if (description !== undefined && typeof description !== 'string') return undefined;
  return { requestId, toolUseId, toolName, input: original, ...(description ? { description } : {}) };
}

export function allowFrame(requestId: string, originalInput: Record<string, unknown>): string {
  return JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: requestId,
    response: { behavior: 'allow', updatedInput: originalInput } } }) + '\n';
}

export function denyFrame(requestId: string, message: string): string {
  return JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: requestId,
    response: { behavior: 'deny', message } } }) + '\n';
}

export type ApprovalEnd = 'allowed' | 'denied' | 'expired' | 'closed' | 'interrupted';

export type BridgeEvent =
  | { kind: 'approval'; turnId: string; requestId: string; toolUseId: string; toolName: string; description?: string;
    preview: string; deadline: number }
  | { kind: 'approvalEnd'; turnId: string; requestId: string; toolUseId: string; state: ApprovalEnd; message?: string };

export type DecisionResult = { ok: true } | { ok: false; reason: 'closed' | 'unknown' | 'duplicate' | 'owner' | 'turn' | 'interrupted' | 'expired' | 'write' };

interface Pending {
  request: ApprovalRequest;
  turnId: string;
  epoch: string;
  deadline: number;
  timer: unknown;
}

export interface BridgeOptions {
  /** Connection epoch (the owner token of this channel). */
  epoch: string;
  /** Write one frame to the channel now. False when it is not writable. */
  write(line: string): boolean;
  /** The active turn id, if any. */
  turn(): string | undefined;
  emit(event: BridgeEvent): void;
  now?(): number;
  setTimer?(run: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
  deadlineMs?: number;
}

const messages = {
  expired: 'Agent Lens denied this request because no decision arrived in time.',
  closed: 'Agent Lens denied this request because the chat channel closed.',
  interrupted: 'Agent Lens denied this request because the turn was interrupted.',
  unreadable: 'Agent Lens denied this request because it could not be read safely.',
  idle: 'Agent Lens denied this request because no turn was waiting for it.',
  denied: 'Denied in Agent Lens.',
  limit: 'Agent Lens denied this request because too many were waiting.',
} as const;
const maxPending = 16;
const maxSettled = 128;

/** Owns every live permission request of one channel. Safe outcome is always deny. */
export class ApprovalBridge {
  private readonly pending = new Map<string, Pending>();
  private readonly settled = new Set<string>();
  private shut = false;
  private interruptedTurn: string | undefined;

  constructor(private readonly options: BridgeOptions) {}

  get size(): number { return this.pending.size; }

  private now(): number { return (this.options.now ?? Date.now)(); }

  private remember(requestId: string): void {
    this.settled.add(requestId);
    if (this.settled.size > maxSettled) this.settled.delete(this.settled.values().next().value!);
  }

  /** Register a `can_use_tool` frame. Returns whether it is now waiting for a person. */
  receive(row: Record<string, unknown>): boolean {
    const requestId = approvalRequestId(row);
    if (!requestId) return false;
    const request = parseApprovalRequest(row);
    if (!request) return this.refuse(requestId, messages.unreadable);
    const turn = this.options.turn();
    if (this.shut || !turn) return this.refuse(requestId, this.shut ? messages.closed : messages.idle);
    if (this.interruptedTurn === turn) return this.refuse(requestId, messages.interrupted);
    if (this.pending.has(requestId) || this.settled.has(requestId)) return this.refuse(requestId, messages.unreadable);
    if (this.pending.size >= maxPending) return this.refuse(requestId, messages.limit);
    const ms = this.options.deadlineMs ?? approvalDeadlineMs;
    const deadline = this.now() + ms;
    const timer = (this.options.setTimer ?? ((run, wait) => { const handle = setTimeout(run, wait); handle.unref(); return handle; }))(
      () => this.retire(requestId, 'expired', messages.expired), ms);
    this.pending.set(requestId, { request, turnId: turn, epoch: this.options.epoch, deadline, timer });
    this.options.emit({ kind: 'approval', turnId: turn, requestId, toolUseId: request.toolUseId,
      toolName: safeText(request.toolName, 80) ?? 'Tool', description: safeText(request.description, 400),
      preview: previewInput(request.input), deadline });
    return true;
  }

  private refuse(requestId: string, message: string): boolean {
    this.options.write(denyFrame(requestId, message));
    return false;
  }

  /** Recheck owner, channel, turn, deadline and duplication at decision time. Never accepts new input. */
  decide(requestId: string, decision: ApprovalDecision, context: { epoch: string; turnId: string | undefined }): DecisionResult {
    if (this.shut) return { ok: false, reason: 'closed' };
    const entry = this.pending.get(requestId);
    if (!entry) return { ok: false, reason: this.settled.has(requestId) ? 'duplicate' : 'unknown' };
    if (entry.epoch !== context.epoch || context.epoch !== this.options.epoch) return { ok: false, reason: 'owner' };
    const turn = this.options.turn();
    if (!turn || entry.turnId !== turn || context.turnId !== turn) return { ok: false, reason: 'turn' };
    if (this.interruptedTurn === turn) return { ok: false, reason: 'interrupted' };
    if (this.now() >= entry.deadline) {
      this.retire(requestId, 'expired', messages.expired);
      return { ok: false, reason: 'expired' };
    }
    const line = decision === 'allow' ? allowFrame(requestId, entry.request.input) : denyFrame(requestId, messages.denied);
    if (!this.options.write(line)) {
      this.retire(requestId, 'closed', messages.closed, false);
      return { ok: false, reason: 'write' };
    }
    this.finish(requestId, decision === 'allow' ? 'allowed' : 'denied');
    return { ok: true };
  }

  private finish(requestId: string, state: ApprovalEnd, message?: string): void {
    const entry = this.pending.get(requestId);
    if (!entry) return;
    this.pending.delete(requestId);
    this.remember(requestId);
    (this.options.clearTimer ?? clearTimeout as (handle: unknown) => void)(entry.timer);
    this.options.emit({ kind: 'approvalEnd', turnId: entry.turnId, requestId, toolUseId: entry.request.toolUseId, state, message });
  }

  /** Answer deny when the channel still takes writes, then retire the card. Never sends allow. */
  private retire(requestId: string, state: ApprovalEnd, message: string, write = true): void {
    if (!this.pending.has(requestId)) return;
    if (write) this.options.write(denyFrame(requestId, message));
    this.finish(requestId, state, message);
  }

  /** The user interrupted this turn. Deny what waits and refuse later requests of the turn. */
  interrupted(): void {
    this.interruptedTurn = this.options.turn();
    for (const requestId of [...this.pending.keys()]) this.retire(requestId, 'interrupted', messages.interrupted);
  }

  /** The turn finished. The CLI no longer waits, so retire silently. */
  turnEnded(): void {
    this.interruptedTurn = undefined;
    for (const requestId of [...this.pending.keys()]) this.retire(requestId, 'closed', messages.closed, false);
  }

  /** The channel is closing (owner change, abort, exit). Deny while writable and refuse everything after. */
  close(writable = true): void {
    if (this.shut) return;
    this.shut = true;
    for (const requestId of [...this.pending.keys()]) this.retire(requestId, 'closed', messages.closed, writable);
  }
}
