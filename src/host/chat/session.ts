import { randomUUID } from 'node:crypto';
import { maxChatDraft } from '../../shared/protocol';
import type { ChatRow, ChatView } from '../../shared/protocol';
import type { Provider } from '../adapters/types';
import { safeText } from '../privacy/projection';
import { chatWriterKey, ChatOwnership, sameChatIdentity } from './ownership';
import { ChatLaunchError } from './types';
import type { ChatAdapter, ChatAttempt, ChatCapabilities, ChatConnection, ChatEvent, ChatIdentity, ChatLaunch, ChatScope } from './types';

export interface ChatSessionDeps {
  adapter(provider: Provider): ChatAdapter | undefined;
  validate(launch: ChatLaunch, ownWorker?: boolean): Promise<string | undefined>;
  changed(key: string): void;
  persist(attempt: ChatAttempt, remove: boolean): Promise<void>;
  recoveries?: readonly ChatAttempt[];
  checkDelivery(attempt: ChatAttempt): Promise<'confirmed' | 'absent' | 'unknown'>;
  claim?(launch: ChatLaunch): Promise<(() => Promise<void>) | undefined>;
}

export interface ChatPresentation {
  title: string;
  project?: string;
  provider?: string;
  profile?: string;
  privateMode: boolean;
  reason?: string;
  history?: readonly ChatRow[];
}

export type ChatRequest =
  | { type: 'chatDraft' | 'chatSend'; revision: number; text: string }
  | { type: 'chatContinue' | 'chatInterrupt' | 'chatRetry' };

interface LiveRow extends ChatRow {
  truncated?: boolean;
  toolName?: string;
  projected?: string;
}

interface Turn {
  record: ChatAttempt;
  rowId: string;
  revision?: number;
  written: boolean;
  delivery: 'pending' | 'acknowledged' | 'uncertain';
  journal?: Promise<void>;
}

interface Interrupt {
  requestId?: string;
  receipts: Map<string, boolean>;
}

interface Worker {
  launch: ChatLaunch;
  abort: AbortController;
  capabilities?: ChatCapabilities;
  claim?: Promise<(() => Promise<void>) | undefined>;
  opening?: Promise<ChatConnection>;
  connection?: ChatConnection;
  closing?: Promise<boolean>;
  exited: boolean;
  interrupt?: Interrupt;
}

interface Conversation {
  key: string;
  scope?: ChatScope;
  identity?: ChatIdentity;
  indexed?: string;
  draft: string;
  revision: number;
  armed: boolean;
  rows: Map<string, LiveRow>;
  retryRow?: string;
  history: readonly string[];
  frozenHistory?: ReadonlySet<string>;
  worker?: Worker;
  turn?: Turn;
  checking: boolean;
  reason?: string;
  conflict?: string;
  recoveryQueue: ChatAttempt[];
}

const maxLiveRows = 400;
const maxBlock = 16_000;
const maxInterruptReceipts = 8;
const readOnly = 'Continue this conversation to send a message.';
const scopeRequired = 'Choose a trusted project and profile.';
const writerPresent = 'Another Agent Lens window owns this conversation.';
const identityConflict = 'The recorded project or profile conflicts with the current conversation.';
const deliveryUncertain = 'Delivery could not be confirmed. Check history before retrying.';
const launchFailed = 'Could not start the provider chat worker.';
const approvalsLater = 'Needs approval. In-chat approval is planned for a later update.';

function makeConversation(key: string, scope: ChatScope | undefined, armed: boolean): Conversation {
  return {
    key, scope, armed, draft: '', revision: 0, rows: new Map(), history: [], checking: false, recoveryQueue: [],
  };
}

function messageForDraft(draft: string): string | undefined {
  if (!draft.trim()) return 'Enter a message.';
  if (/^[!/]/.test(draft.trimStart())) {
    return 'Slash commands and leading ! are not available in chat yet. Use \\/ for a literal leading slash.';
  }
  if (draft.includes('\0')) return 'Remove the null character from the draft before sending.';
  return undefined;
}

function displayRow(row: LiveRow, privateMode: boolean): ChatRow {
  const hidden = privateMode && (row.role === 'user' || row.role === 'assistant');
  const text = hidden ? 'Hidden in private mode.'
    : (row.projected ??= (safeText(row.text.replace(/[\uD800-\uDBFF]$/, ''), maxBlock) ?? '') + (row.truncated ? '…' : ''));
  return { id: row.id, role: row.role, text, state: row.state };
}

/** Owns conversations across editor lifetimes. Each worker gets a fresh owner token. */
export class ChatSessions {
  private readonly ownership = new ChatOwnership();
  private readonly conversations = new Map<string, Conversation>();
  private readonly canonical = new Map<string, Conversation>();
  private readonly saved: ChatAttempt[];
  private disposed = false;
  private shutdown?: Promise<void>;

  constructor(private readonly deps: ChatSessionDeps) {
    this.saved = [...(deps.recoveries ?? [])];
  }

  create(scope?: ChatScope): string {
    const conversation = makeConversation(randomUUID(), scope, true);
    this.conversations.set(conversation.key, conversation);
    return conversation.key;
  }

  observe(identity: ChatIdentity, keyHint: string): string {
    const writerKey = chatWriterKey(identity);
    const existing = this.canonical.get(writerKey);
    if (existing) {
      const expected = existing.identity ?? existing.worker?.launch.identity ?? existing.turn?.record.identity;
      if (expected && !sameChatIdentity(expected, identity)) {
        existing.conflict = identityConflict;
      } else {
        existing.identity = identity;
      }
      return existing.key;
    }
    const conversation = makeConversation(this.conversations.has(keyHint) ? randomUUID() : keyHint, identity, false);
    conversation.identity = identity;
    this.conversations.set(conversation.key, conversation);
    this.index(conversation, identity);
    this.attachRecoveries(conversation, identity);
    return conversation.key;
  }

  keyFor(identity: ChatIdentity): string | undefined {
    return this.canonical.get(chatWriterKey(identity))?.key;
  }

  scope(key: string): ChatScope | undefined {
    return this.conversations.get(key)?.scope;
  }

  identity(key: string): ChatIdentity | undefined {
    return this.conversations.get(key)?.identity;
  }

  recoveries(): readonly ChatAttempt[] {
    return this.saved;
  }

  recover(key: string): string | undefined {
    if (this.conversations.has(key)) return key;
    const saved = this.saved.find(attempt => attempt.conversation === key);
    if (!saved) return undefined;
    const existing = this.keyFor(saved.identity);
    if (existing) return existing;
    const conversation = makeConversation(key, saved.identity, false);
    this.conversations.set(key, conversation);
    this.index(conversation, saved.identity);
    this.attachRecoveries(conversation, saved.identity);
    return key;
  }

  setScope(key: string, scope: ChatScope): void {
    const conversation = this.conversations.get(key);
    if (!conversation || conversation.identity || this.busy(conversation)) return;
    conversation.scope = scope;
    conversation.armed = true;
    conversation.reason = undefined;
    this.changed(conversation);
  }

  view(key: string, presentation: ChatPresentation): ChatView | undefined {
    const conversation = this.conversations.get(key);
    if (!conversation) return undefined;
    const { identity, scope, worker, turn } = conversation;
    const ready = worker?.capabilities?.send;
    const busy = this.busy(conversation);
    const blockingReason = conversation.conflict ?? presentation.reason;
    const reason = conversation.reason ?? blockingReason ?? (identity && !conversation.armed ? readOnly : undefined)
      ?? (!scope ? scopeRequired : undefined);
    const state = this.state(conversation, Boolean(blockingReason));
    const history = presentation.history ?? [];
    const frozen = conversation.frozenHistory;
    if (!frozen) conversation.history = history.map(row => row.id);
    const rows = [...(frozen ? history.filter(row => frozen.has(row.id)) : history)]
      .concat([...conversation.rows.values()].map(row => displayRow(row, presentation.privateMode)));
    return {
      key, title: presentation.title, project: presentation.project, provider: presentation.provider,
      profile: presentation.profile, state, reason, rows,
      draft: presentation.privateMode ? '' : conversation.draft, revision: conversation.revision,
      canSend: Boolean(!presentation.privateMode && scope && conversation.armed && !busy && !blockingReason && (!worker || ready)),
      canContinue: Boolean(!presentation.privateMode && identity && !conversation.armed && !busy && !blockingReason),
      canInterrupt: Boolean(turn?.written && worker?.capabilities?.interrupt && !worker.closing && !worker.interrupt),
      canRetry: Boolean(!presentation.privateMode && turn?.delivery === 'uncertain' && !conversation.checking && !worker),
      canChooseScope: !identity && !busy && !worker,
      privateMode: presentation.privateMode,
    };
  }

  async handle(key: string, request: ChatRequest): Promise<void> {
    const conversation = this.conversations.get(key);
    if (!conversation || this.disposed) return;
    switch (request.type) {
      case 'chatDraft':
        this.updateDraft(conversation, request.revision, request.text);
        break;
      case 'chatSend':
        if (this.updateDraft(conversation, request.revision, request.text)) await this.send(conversation);
        else this.changed(conversation);
        break;
      case 'chatContinue':
        await this.continue(conversation);
        break;
      case 'chatRetry':
        await this.recheck(conversation, true);
        break;
      case 'chatInterrupt':
        await this.interrupt(conversation);
        break;
    }
  }

  invalidate(reason = 'Chat eligibility changed. Check the current project and profile before sending.'): void {
    for (const conversation of this.conversations.values()) {
      if (conversation.worker) void this.disconnect(conversation, conversation.worker, reason);
    }
  }

  dispose(): Promise<void> {
    if (this.shutdown) return this.shutdown;
    this.disposed = true;
    this.shutdown = Promise.all([...this.conversations.values()].flatMap(conversation => {
      const { turn, worker } = conversation;
      const close = worker ? this.close(conversation, worker) : undefined;
      const journal = turn?.written ? turn.journal?.catch(() => undefined) : turn && this.removeRecovery(turn);
      return [close, journal];
    })).then(() => undefined);
    return this.shutdown;
  }

  private busy(conversation: Conversation): boolean {
    return Boolean(conversation.checking || conversation.turn || conversation.worker?.closing);
  }

  private state(conversation: Conversation, blocked: boolean): ChatView['state'] {
    const { worker, turn, checking } = conversation;
    if (worker?.closing || turn?.delivery === 'uncertain') return 'blocked';
    if (worker?.interrupt) return 'interrupting';
    if (turn) return turn.written && worker?.capabilities ? 'working' : 'starting';
    if (checking) return 'starting';
    if (blocked || conversation.reason) return 'blocked';
    if (!conversation.armed) return 'view-only';
    return conversation.identity ? 'idle' : 'draft';
  }

  private changed(conversation: Conversation): void {
    if (!this.disposed) this.deps.changed(conversation.key);
  }

  private index(conversation: Conversation, identity: ChatIdentity): void {
    this.unindex(conversation);
    const key = chatWriterKey(identity);
    conversation.indexed = key;
    this.canonical.set(key, conversation);
  }

  private unindex(conversation: Conversation): void {
    if (conversation.indexed && this.canonical.get(conversation.indexed) === conversation) {
      this.canonical.delete(conversation.indexed);
      conversation.indexed = undefined;
    }
  }

  private updateDraft(conversation: Conversation, revision: number, text: string): boolean {
    if (!Number.isSafeInteger(revision) || revision < conversation.revision || text.length > maxChatDraft) return false;
    if (revision === conversation.revision) return text === conversation.draft;
    conversation.revision = revision;
    conversation.draft = text;
    return true;
  }

  private async check(launch: ChatLaunch, ownWorker?: boolean): Promise<string | undefined> {
    try {
      return await this.deps.validate(launch, ownWorker);
    } catch {
      return 'Could not verify the current project, profile and writer.';
    }
  }

  private async continue(conversation: Conversation): Promise<void> {
    const identity = conversation.identity;
    if (!identity || conversation.armed || conversation.conflict || this.busy(conversation)) return;
    conversation.checking = true;
    conversation.reason = undefined;
    this.changed(conversation);
    const launch = { identity, owner: randomUUID(), resume: true };
    const reason = !this.deps.adapter(identity.provider) ? 'Chat is unavailable for this provider.'
      : !this.ownership.available(identity) ? writerPresent
      : await this.check(launch);
    conversation.checking = false;
    conversation.reason = reason;
    conversation.armed = !reason;
    this.changed(conversation);
  }

  private async send(conversation: Conversation): Promise<void> {
    const { scope, identity } = conversation;
    if (!scope || !conversation.armed || conversation.conflict || this.busy(conversation) || this.disposed) {
      this.changed(conversation);
      return;
    }
    const text = conversation.draft;
    const launch = conversation.worker?.launch ?? {
      identity: identity ?? { ...scope, nativeId: randomUUID() }, owner: randomUUID(), resume: !!identity,
    };
    const adapter = this.deps.adapter(scope.provider);
    const reason = messageForDraft(text) ?? (!adapter ? 'Chat is unavailable for this provider.' : undefined);
    if (reason || !adapter) {
      conversation.reason = reason;
      this.changed(conversation);
      return;
    }
    const id = randomUUID();
    const rowId = conversation.retryRow && conversation.rows.get(conversation.retryRow)?.text === text ? conversation.retryRow : id;
    const turn: Turn = {
      record: { identity: launch.identity, id, acknowledged: false, conversation: conversation.key },
      rowId, revision: conversation.revision, written: false, delivery: 'pending',
    };
    conversation.retryRow = undefined;
    conversation.turn = turn;
    conversation.reason = undefined;
    this.addRow(conversation, { id: rowId, role: 'user', text, state: 'pending' });
    this.changed(conversation);

    let worker = conversation.worker;
    if (worker) {
      if (!worker.capabilities?.send || !worker.connection) {
        this.fail(conversation, turn, 'The current worker cannot send chat messages.');
        return;
      }
      const reason = await this.check(launch, true);
      if (!this.current(conversation, worker, turn)) return;
      if (reason) {
        await this.disconnect(conversation, worker, reason);
        return;
      }
    } else {
      if (!this.ownership.claim(launch)) {
        this.fail(conversation, turn, writerPresent);
        return;
      }
      worker = { launch, abort: new AbortController(), exited: false };
      conversation.worker = worker;
      if (!identity) this.index(conversation, launch.identity);
      if (!await this.open(conversation, worker, turn, adapter)) return;
    }
    if (!this.current(conversation, worker, turn) || !worker.connection) return;
    turn.journal = Promise.resolve().then(() => this.deps.persist(turn.record, false));
    try {
      await turn.journal;
    } catch {
      await this.disconnect(conversation, worker, 'Could not save delivery recovery information. The draft is still here.');
      return;
    }
    if (!this.current(conversation, worker, turn)) return;
    conversation.frozenHistory ??= new Set(conversation.history);
    conversation.history = [];
    turn.written = true;
    try {
      await worker.connection.send({ id, text });
    } catch {
      if (this.current(conversation, worker, turn)) {
        await this.disconnect(conversation, worker, 'The chat connection stopped while submitting the message.');
      }
    }
  }

  private async open(conversation: Conversation, worker: Worker, turn: Turn, adapter: ChatAdapter): Promise<boolean> {
    const launch = worker.launch;
    try {
      if (this.deps.claim) {
        worker.claim = this.deps.claim(launch);
        const release = await worker.claim;
        if (!this.current(conversation, worker, turn)) return false;
        if (!release) {
          await this.disconnect(conversation, worker, writerPresent);
          return false;
        }
      }
      const reason = await this.check(launch);
      if (!this.current(conversation, worker, turn)) return false;
      if (reason) {
        await this.disconnect(conversation, worker, reason);
        return false;
      }
      // Stream initialization may follow the first input. Exact identity is required before accepting output.
      worker.opening = Promise.resolve().then(() =>
        adapter.open(launch, event => this.receive(conversation, worker, event), worker.abort.signal));
      worker.connection = await worker.opening;
      return this.current(conversation, worker, turn);
    } catch (error) {
      const reason = error instanceof ChatLaunchError ? safeText(error.message, 220) : undefined;
      await this.disconnect(conversation, worker, reason ?? launchFailed);
      return false;
    }
  }

  private current(conversation: Conversation, worker: Worker, turn: Turn): boolean {
    return !this.disposed && conversation.worker === worker && !worker.closing && conversation.turn === turn;
  }

  private receive(conversation: Conversation, worker: Worker, event: ChatEvent): void {
    if (event.owner !== worker.launch.owner || event.resume !== worker.launch.resume
      || !sameChatIdentity(event.identity, worker.launch.identity) || conversation.worker !== worker) return;
    if (event.kind === 'exit') {
      worker.exited = true;
      if (!this.disposed) void this.disconnect(conversation, worker, event.reason);
      return;
    }
    if (this.disposed || worker.closing) return;
    if (event.kind === 'ready') {
      if (event.nativeId !== worker.launch.identity.nativeId || !event.capabilities.send) {
        void this.disconnect(conversation, worker, 'The chat worker did not confirm the requested session and send capability.');
        return;
      }
      worker.capabilities = event.capabilities;
      conversation.identity = worker.launch.identity;
      this.changed(conversation);
      return;
    }
    const turn = conversation.turn;
    if (!worker.capabilities || !turn?.written || event.turnId !== turn.record.id) return;
    switch (event.kind) {
      case 'ack':
        if (event.messageId === turn.record.id) this.acknowledge(conversation, turn);
        break;
      case 'text':
        this.text(conversation, event);
        break;
      case 'tool':
      case 'toolResult':
        this.tool(conversation, event);
        break;
      case 'interruptReceipt':
        this.receipt(conversation, worker, event.requestId, event.accepted);
        break;
      case 'result':
        worker.interrupt = undefined;
        if (turn.delivery !== 'acknowledged') {
          void this.disconnect(conversation, worker, 'The turn ended before message delivery was confirmed.');
          return;
        }
        if (event.outcome !== 'completed') {
          const text = safeText(event.reason, 220)
            ?? (event.outcome === 'interrupted' ? 'Turn interrupted.' : 'The provider reported a failed turn.');
          this.addRow(conversation, { id: randomUUID(), role: 'notice', text });
        }
        this.finish(conversation, turn);
        break;
    }
  }

  private acknowledge(conversation: Conversation, turn: Turn): void {
    if (turn.delivery === 'acknowledged') return;
    turn.delivery = 'acknowledged';
    turn.record = { ...turn.record, acknowledged: true };
    const previous = turn.journal;
    turn.journal = Promise.resolve(previous).catch(() => undefined).then(() => this.deps.persist(turn.record, false));
    void turn.journal.catch(() => undefined);
    const row = conversation.rows.get(turn.rowId);
    if (row) row.state = undefined;
    if (conversation.revision === turn.revision) conversation.draft = '';
    this.changed(conversation);
  }

  private text(conversation: Conversation, event: Extract<ChatEvent, { kind: 'text' }>): void {
    const id = JSON.stringify([event.turnId, event.messageId, event.blockId]);
    const previous = conversation.rows.get(id);
    if (event.mode === 'append' && previous?.truncated) return;
    const base = event.mode === 'append' ? previous?.text ?? '' : '';
    const text = base + event.text.slice(0, maxBlock - base.length);
    this.addRow(conversation, { id, role: 'assistant', text, truncated: base.length + event.text.length > maxBlock });
    this.changed(conversation);
  }

  private tool(conversation: Conversation, event: Extract<ChatEvent, { kind: 'tool' | 'toolResult' }>): void {
    const id = JSON.stringify([event.turnId, event.callId, 'tool']);
    const previous = conversation.rows.get(id);
    const toolName = event.kind === 'tool' ? safeText(event.name, 80) ?? 'Tool' : previous?.toolName ?? 'Tool';
    const text = event.kind === 'tool' ? toolName
      : toolName + ' · ' + (event.outcome === 'needs-approval' ? approvalsLater : event.outcome === 'completed' ? 'Completed' : 'Failed');
    this.addRow(conversation, { id, role: 'tool', text, toolName });
    this.changed(conversation);
  }

  private addRow(conversation: Conversation, row: LiveRow): void {
    conversation.rows.set(row.id, row);
    if (conversation.rows.size <= maxLiveRows) return;
    for (const id of conversation.rows.keys()) {
      if (id !== conversation.turn?.rowId) {
        conversation.rows.delete(id);
        return;
      }
    }
  }

  private async interrupt(conversation: Conversation): Promise<void> {
    const { worker, turn } = conversation;
    if (!worker?.connection || !worker.capabilities?.interrupt || !turn?.written || worker.interrupt || worker.closing) return;
    const interrupt: Interrupt = { receipts: new Map() };
    worker.interrupt = interrupt;
    this.changed(conversation);
    try {
      interrupt.requestId = await worker.connection.interrupt();
      if (this.current(conversation, worker, turn) && worker.interrupt === interrupt) {
        const accepted = interrupt.receipts.get(interrupt.requestId);
        interrupt.receipts.clear();
        if (accepted !== undefined) this.receipt(conversation, worker, interrupt.requestId, accepted);
      }
    } catch {
      if (this.current(conversation, worker, turn) && worker.interrupt === interrupt) {
        worker.interrupt = undefined;
        conversation.reason = 'The interrupt could not be sent. The turn is still running.';
        this.changed(conversation);
      }
    }
  }

  private receipt(conversation: Conversation, worker: Worker, requestId: string, accepted: boolean): void {
    const interrupt = worker.interrupt;
    if (!interrupt) return;
    if (!interrupt.requestId) {
      if (interrupt.receipts.size < maxInterruptReceipts) interrupt.receipts.set(requestId, accepted);
      return;
    }
    if (interrupt.requestId !== requestId || accepted) return;
    worker.interrupt = undefined;
    conversation.reason = 'The provider did not accept the interrupt. The turn is still running.';
    this.changed(conversation);
  }

  private async disconnect(conversation: Conversation, worker: Worker, reason?: string): Promise<void> {
    if (worker.closing || conversation.worker !== worker) return;
    const closed = this.close(conversation, worker);
    const turn = conversation.turn;
    conversation.reason = safeText(reason, 220);
    if (!turn) {
      this.changed(conversation);
    } else if (turn.delivery === 'acknowledged') {
      this.finish(conversation, turn, conversation.reason ?? 'The chat worker exited before the turn completed.');
    } else if (turn.written) {
      turn.delivery = 'uncertain';
      const row = conversation.rows.get(turn.rowId);
      if (row) row.state = 'uncertain';
      conversation.reason = conversation.reason ? conversation.reason + ' ' + deliveryUncertain : deliveryUncertain;
      this.changed(conversation);
    } else {
      this.fail(conversation, turn, conversation.reason ?? 'The chat worker stopped before sending.');
    }
    if (await closed) {
      if (!conversation.identity && !turn?.written) this.unindex(conversation);
      if (turn?.delivery === 'uncertain') await this.recheck(conversation, false);
      this.changed(conversation);
    } else {
      conversation.reason = 'The worker release could not be verified. New sends are paused.';
      this.changed(conversation);
    }
  }

  private close(conversation: Conversation, worker: Worker): Promise<boolean> {
    worker.closing ??= Promise.resolve().then(async () => {
      worker.abort.abort();
      const connection = worker.connection ?? await worker.opening?.catch(() => undefined);
      try {
        await connection?.close();
      } catch {
        if (!worker.exited) return false;
      }
      try {
        const release = await worker.claim?.catch(() => undefined);
        await release?.();
      } catch {
        return false;
      }
      this.ownership.release(worker.launch);
      if (conversation.worker === worker) conversation.worker = undefined;
      return true;
    });
    return worker.closing;
  }

  private finish(conversation: Conversation, turn: Turn, reason?: string): void {
    conversation.turn = undefined;
    conversation.reason = reason;
    void this.removeRecovery(turn);
    if (!this.nextRecovery(conversation)) this.changed(conversation);
  }

  private fail(conversation: Conversation, turn: Turn, reason: string): void {
    const row = conversation.rows.get(turn.rowId);
    if (row) {
      row.state = 'failed';
      conversation.retryRow = row.id;
    }
    this.finish(conversation, turn, reason);
  }

  private async removeRecovery(turn: Turn): Promise<void> {
    if (!turn.journal) return;
    await turn.journal.catch(() => undefined);
    await this.deps.persist(turn.record, true).catch(() => undefined);
  }

  private attachRecoveries(conversation: Conversation, identity: ChatIdentity): void {
    const writerKey = chatWriterKey(identity);
    conversation.recoveryQueue = this.saved.filter(attempt => chatWriterKey(attempt.identity) === writerKey);
    for (let index = this.saved.length - 1; index >= 0; index--) {
      const attempt = this.saved[index];
      if (attempt && chatWriterKey(attempt.identity) === writerKey) this.saved.splice(index, 1);
    }
    this.nextRecovery(conversation);
  }

  private nextRecovery(conversation: Conversation): boolean {
    const record = conversation.recoveryQueue.shift();
    if (!record) return false;
    if (conversation.identity && !sameChatIdentity(conversation.identity, record.identity)) conversation.conflict = identityConflict;
    const turn: Turn = {
      record, rowId: record.id, written: true, delivery: record.acknowledged ? 'acknowledged' : 'uncertain',
      journal: Promise.resolve(),
    };
    if (record.acknowledged) {
      conversation.identity ??= record.identity;
      void this.removeRecovery(turn);
      return this.nextRecovery(conversation);
    }
    conversation.turn = turn;
    conversation.reason = deliveryUncertain;
    this.addRow(conversation, { id: turn.rowId, role: 'notice', text: 'A previous send lost its delivery confirmation.', state: 'uncertain' });
    this.changed(conversation);
    void this.recheck(conversation, false);
    return true;
  }

  private async recheck(conversation: Conversation, retry: boolean): Promise<void> {
    const turn = conversation.turn;
    if (turn?.delivery !== 'uncertain' || conversation.checking || conversation.worker || this.disposed) return;
    conversation.checking = true;
    this.changed(conversation);
    const evidence = await this.deps.checkDelivery(turn.record).catch(() => 'unknown' as const);
    conversation.checking = false;
    if (this.disposed || conversation.turn !== turn) return;
    if (evidence === 'unknown') {
      this.changed(conversation);
      return;
    }
    const row = conversation.rows.get(turn.rowId);
    if (evidence === 'confirmed') {
      conversation.identity ??= turn.record.identity;
      if (row?.role === 'notice') {
        this.addRow(conversation, { id: row.id, role: 'notice', text: 'Recorded history confirmed delivery of the previous message.' });
      }
      this.acknowledge(conversation, turn);
      this.finish(conversation, turn);
      return;
    }
    if (!conversation.identity) {
      this.unindex(conversation);
      conversation.armed = true;
    }
    if (row?.role === 'notice') this.addRow(conversation, { id: row.id, role: 'notice',
      text: 'Recorded history shows the previous message was not delivered. Re-enter it to send.' });
    this.fail(conversation, turn, 'The previous message was not delivered.');
    if (retry && row?.role === 'user' && row.text === conversation.draft) await this.send(conversation);
  }
}
