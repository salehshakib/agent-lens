import { reconcileRows, scopeSessionId } from './reconcile';
import type { ProvisionalRow } from './reconcile';
import { randomUUID } from 'node:crypto';
import { maxChatDraft } from '../../shared/protocol';
import type { ChatRow, ChatView } from '../../shared/protocol';
import type { Provider } from '../adapters/types';
import { safeText } from '../privacy/projection';
import { parseChatInput, slashCatalog } from './commands';
import { canCheckFast, isVerifiedClaudeChat, normalizeEffortChoice, normalizeModelChoice } from '../adapters/claude-code/chat-settings';
import { chatWriterKey, ChatOwnership, sameChatIdentity } from './ownership';
import { ChatLaunchError } from './types';
import type { ChatAdapter, ChatAttempt, ChatCapabilities, ChatConnection, ChatEvent, ChatIdentity, ChatLaunch, ChatScope,
  ChatSend, ChatSettings, CompactMeasurement } from './types';

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
  history?: readonly (ChatRow & { keys?: readonly string[] })[];
  /** Recorded session id the history came from. Live rows merge into it only when the conversation's verified scope derives it. */
  sessionId?: string;
}

export type ChatRequest =
  | { type: 'chatDraft' | 'chatSend'; revision: number; text: string }
  | { type: 'chatContinue' | 'chatInterrupt' | 'chatRetry' };

interface LiveRow extends ChatRow {
  truncated?: boolean;
  toolName?: string;
  projected?: string;
  local?: LocalChatRow;
  identity?: ProvisionalRow['identity'];
}

export interface LocalChatRow {
  name: string;
  argument: string;
  reason?: string;
  canSendAsText?: boolean;
  allProjects?: boolean;
  codexMode?: 'start' | 'follow';
  revision: number;
  scopeStamp?: string;
  fileKind?: 'all' | 'changed' | 'read' | 'mentioned';
  diffId?: string;
  resumeLimit?: number;
  resumeFolder?: { cwd: string; project: string; label: string };
  contextLane?: string;
  actionIssue?: string;
  terminalName?: string;
  result?: { state: 'pending' | 'completed' | 'failed'; message?: string; compact?: CompactMeasurement };
}

interface Turn {
  record: ChatAttempt;
  rowId: string;
  revision?: number;
  written: boolean;
  delivery: 'pending' | 'acknowledged' | 'uncertain';
  journal?: Promise<void>;
  command?: ChatSend['command'];
  effort?: string;
  textRows?: Set<string>;
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
  submitted?: number;
  parkedDraft?: { text: string; revision: number };
  cleared?: boolean;
  armed: boolean;
  rows: Map<string, LiveRow>;
  retryRow?: string;
  history: readonly string[];
  frozenHistory?: ReadonlySet<string>;
  worker?: Worker;
  turn?: Turn;
  checking: boolean;
  reason?: string;
  model?: string;
  resolvedModel?: string;
  settings?: ChatSettings;
  compact?: CompactMeasurement;
  observedCapabilities?: ChatCapabilities;
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
    const pending = this.conversations.get(keyHint);
    const conversation = pending && !pending.scope && !pending.armed ? pending
      : makeConversation(pending ? randomUUID() : keyHint, identity, false);
    conversation.scope = identity;
    conversation.identity = identity;
    this.conversations.set(conversation.key, conversation);
    this.index(conversation, identity);
    this.attachRecoveries(conversation, identity);
    return conversation.key;
  }

  keyFor(identity: ChatIdentity): string | undefined {
    return this.canonical.get(chatWriterKey(identity))?.key;
  }

  inspect(key: string): void {
    if (!this.conversations.has(key)) this.conversations.set(key, makeConversation(key, undefined, false));
  }

  localRows(key: string): readonly { id: string; command: LocalChatRow }[] {
    return [...(this.conversations.get(key)?.rows.values() ?? [])]
      .flatMap(row => row.local ? [{ id: row.id, command: row.local }] : []);
  }

  commandState(key: string) {
    const conversation = this.conversations.get(key);
    const activeCapabilities = conversation?.worker?.closing ? undefined : conversation?.worker?.capabilities;
    const last = conversation?.observedCapabilities;
    return {
      capabilities: activeCapabilities ?? (last ? { ...last, send: false, nativeCommands: false, literalText: false } : undefined),
      owner: conversation?.worker?.launch.owner,
      turn: conversation?.turn?.record.id,
      busy: conversation ? this.busy(conversation) : false,
      model: conversation?.model,
      resolvedModel: conversation?.resolvedModel,
      settings: conversation?.settings,
      compact: conversation?.compact,
      revision: conversation?.revision,
    };
  }

  async applySetting(key: string, row: string, kind: 'model' | 'effort' | 'fast', selection: string): Promise<void> {
    const conversation = this.conversations.get(key);
    if (!conversation || conversation.scope?.provider !== 'claude-code' || conversation.conflict || this.disposed) return;
    const worker = conversation.worker;
    const value = kind === 'model' ? normalizeModelChoice(selection) : kind === 'effort' ? normalizeEffortChoice(selection) : selection;
    const setResult = (state: 'pending' | 'completed' | 'failed', message?: string) =>
      this.updateLocal(key, row, { result: { state, message }, actionIssue: undefined });
    if (this.busy(conversation) || value === undefined || (kind === 'fast' && value !== '')) {
      setResult('failed', 'The setting needs a valid selection at an idle boundary.');
      return;
    }
    if (!worker && kind !== 'fast') {
      conversation.settings = { ...conversation.settings, [kind]: value === 'default' ? undefined : value };
      if (kind === 'model') conversation.resolvedModel = undefined;
      setResult('completed', 'Saved for the next chat start or exact resume.');
      return;
    }
    if (!worker?.connection || !isVerifiedClaudeChat(worker.capabilities) || value === 'default'
      || (kind === 'fast' && !canCheckFast(worker.capabilities))
      || (kind === 'effort' && !worker.capabilities?.effortActive)) {
      setResult('failed', 'This setting is unavailable on the current chat channel.');
      return;
    }
    if (kind === 'effort' || kind === 'fast') {
      setResult('pending');
      await this.send(conversation, { row, command: kind, text: kind === 'fast' ? '/fast' : '/effort ' + value,
        effort: kind === 'effort' ? value : undefined });
      return;
    }
    conversation.checking = true;
    setResult('pending', 'Waiting for the provider to acknowledge the requested model.');
    try {
      const reason = await this.check(worker.launch, true);
      if (reason || conversation.worker !== worker || worker.closing) {
        setResult('failed', reason ?? 'The chat owner changed.');
        return;
      }
      const resolved = await worker.connection.setModel?.(value);
      if (!resolved || conversation.worker !== worker || worker.closing) {
        setResult('failed', 'The provider did not confirm the model change.');
        return;
      }
      conversation.settings = { ...conversation.settings, model: value };
      conversation.resolvedModel = resolved;
      setResult('completed', 'The provider acknowledged the request. The next turn will report the effective model.');
    } catch {
      setResult('failed', 'The model change could not be confirmed.');
    } finally {
      conversation.checking = false;
      this.changed(conversation);
    }
  }

  async releaseForTerminal(key: string): Promise<string | undefined> {
    const conversation = this.conversations.get(key);
    if (!conversation?.identity || !conversation.worker || this.busy(conversation) || conversation.conflict) {
      return 'The current chat owner cannot be released while work is active or the session is uncertain.';
    }
    const close = this.close(conversation, conversation.worker);
    this.changed(conversation);
    if (!await close) return 'Could not verify that Agent Lens released this conversation.';
    conversation.armed = false;
    this.changed(conversation);
    return undefined;
  }

  async prepareTerminal(key: string, open: (launch: ChatLaunch) => Promise<string | undefined>): Promise<string | undefined> {
    const conversation = this.conversations.get(key);
    const identity = conversation?.identity;
    if (!conversation || !identity || conversation.worker || this.busy(conversation) || conversation.conflict || this.disposed) {
      return 'Release the idle chat owner before opening the official terminal.';
    }
    const launch = { identity, owner: randomUUID(), resume: true };
    if (!this.ownership.claim(launch)) return writerPresent;
    conversation.checking = true;
    this.changed(conversation);
    let release: (() => Promise<void>) | undefined;
    try {
      if (this.deps.claim && !(release = await this.deps.claim(launch))) return writerPresent;
      const reason = await this.check(launch);
      if (reason || this.disposed) return reason ?? 'The chat was closed.';
      const failure = await open(launch);
      if (!failure) conversation.armed = false;
      return failure;
    } finally {
      try { await release?.(); }
      finally {
        this.ownership.release(launch);
        conversation.checking = false;
        this.changed(conversation);
      }
    }
  }

  commandScopeStamp(key: string, sessionId?: string): string {
    const scope = this.scope(key);
    return scope ? JSON.stringify([scope.provider, scope.profile, scope.home, scope.cwd]) : sessionId ?? '';
  }

  parked(exclude: string): readonly { key: string; scope?: ChatScope }[] {
    return [...this.conversations.values()].flatMap(item =>
      item.key !== exclude && !item.identity && item.armed && (item.cleared || item.draft.trim() || item.worker)
        ? [{ key: item.key, scope: item.scope }] : []);
  }

  local(key: string, revision: number, text: string, command: Omit<LocalChatRow, 'revision'>, preserveDraft = false): boolean {
    const conversation = this.conversations.get(key);
    if (!conversation || this.disposed || !this.submitDraft(conversation, revision, text)) {
      if (conversation) this.changed(conversation);
      return false;
    }
    if (!command.reason && !preserveDraft) {
      conversation.draft = conversation.parkedDraft?.text ?? '';
      conversation.parkedDraft = undefined;
    }
    if (command.name === 'clear' && !command.reason) conversation.cleared = true;
    const id = randomUUID();
    this.addLocalRow(conversation, id, { ...command, revision });
    this.changed(conversation);
    return true;
  }

  updateLocal(key: string, id: string, change: Partial<LocalChatRow>): void {
    const conversation = this.conversations.get(key);
    const row = conversation?.rows.get(id);
    if (!conversation || !row?.local) return;
    row.local = { ...row.local, ...change };
    this.changed(conversation);
  }

  async sendAsText(key: string, revision: number): Promise<void> {
    const conversation = this.conversations.get(key);
    if (!conversation || revision !== conversation.revision || this.busy(conversation)) return;
    const escaped = conversation.draft.replace(/^(\s*)\//u, '$1\\/');
    if (escaped.length > maxChatDraft || parseChatInput(escaped, this.commandState(key).capabilities).kind !== 'literal') return;
    // The explicit action changes the draft in place, so the composer uses the same revision sequence.
    conversation.draft = escaped;
    await this.send(conversation);
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
    if (!conversation?.armed || conversation.identity || this.busy(conversation) || conversation.worker) return;
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
    const recorded = frozen ? history.filter(row => frozen.has(row.id)) : history;
    const verified = Boolean(identity && presentation.sessionId && presentation.sessionId === scopeSessionId(identity));
    const live = reconcileRows(recorded, [...conversation.rows.values()].filter(row => !presentation.privateMode || !row.local), verified).live;
    const rows = recorded.map(({ keys: _keys, ...row }) => row as ChatRow)
      .concat(live.map(row => displayRow(row, presentation.privateMode)));
    return {
      key, title: presentation.title, project: presentation.project, provider: presentation.provider,
      profile: presentation.profile, state, reason, rows,
      draft: presentation.privateMode ? '' : conversation.draft, revision: conversation.revision,
      canSend: Boolean(!presentation.privateMode && scope && conversation.armed && !busy && !blockingReason && (!worker || ready)),
      canContinue: Boolean(!presentation.privateMode && identity && !conversation.armed && !busy && !blockingReason),
      canInterrupt: Boolean(turn?.written && worker?.capabilities?.interrupt && !worker.closing && !worker.interrupt),
      canRetry: Boolean(!presentation.privateMode && turn?.delivery === 'uncertain' && !conversation.checking && !worker),
      canChooseScope: conversation.armed && !identity && !busy && !worker,
      privateMode: presentation.privateMode,
      commands: slashCatalog(this.commandState(key).capabilities, busy),
      commandScope: [presentation.project, presentation.provider, presentation.profile].filter(Boolean).join(' · '),
      literalText: !worker?.closing && worker?.capabilities?.literalText,
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
        if (this.submitDraft(conversation, request.revision, request.text)) await this.send(conversation);
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
    const leadingSlash = text.trimStart().startsWith('/');
    if (leadingSlash && !conversation.draft.trimStart().startsWith('/') && conversation.draft.trim()) {
      conversation.parkedDraft = { text: conversation.draft, revision: conversation.revision };
    } else if (!leadingSlash) {
      conversation.parkedDraft = undefined;
    }
    conversation.revision = revision;
    conversation.draft = text;
    return true;
  }

  private submitDraft(conversation: Conversation, revision: number, text: string): boolean {
    if (conversation.submitted !== undefined && revision <= conversation.submitted) return false;
    if (!this.updateDraft(conversation, revision, text)) return false;
    conversation.submitted = revision;
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

  private async send(conversation: Conversation, setting?: { row: string; command: 'effort' | 'fast'; text: string; effort?: string }): Promise<void> {
    const { scope, identity } = conversation;
    if (!scope || !conversation.armed || conversation.conflict || this.busy(conversation) || this.disposed) {
      if (setting) this.updateLocal(conversation.key, setting.row, { result: { state: 'failed', message: 'The chat is unavailable.' } });
      this.changed(conversation);
      return;
    }
    const parsed = parseChatInput(conversation.draft, conversation.worker?.capabilities);
    const native = parsed.kind === 'native' && parsed.route === 'Native' && !parsed.reason ? parsed : undefined;
    const command: ChatSend['command'] = setting?.command ?? (native ? native.name === 'compact' ? 'compact' : 'native' : undefined);
    const text = setting?.text ?? (parsed.kind === 'text' || parsed.kind === 'literal' ? parsed.text : native?.text);
    const launch = conversation.worker?.launch ?? {
      identity: identity ?? { ...scope, nativeId: randomUUID() }, owner: randomUUID(), resume: !!identity,
      settings: conversation.settings,
    };
    const adapter = this.deps.adapter(scope.provider);
    if (!text?.trim() || !adapter) {
      conversation.reason = 'reason' in parsed && parsed.reason ? parsed.reason
        : !adapter ? 'Chat is unavailable for this provider.' : 'Enter a message.';
      this.changed(conversation);
      return;
    }
    const id = randomUUID();
    const rowId = setting?.row ?? (conversation.retryRow && conversation.rows.get(conversation.retryRow)?.text === text ? conversation.retryRow : id);
    const turn: Turn = {
      record: { identity: launch.identity, id, acknowledged: false, conversation: conversation.key },
      rowId, revision: setting ? undefined : conversation.revision, written: false, delivery: 'pending', command, effort: setting?.effort,
    };
    conversation.retryRow = undefined;
    conversation.turn = turn;
    conversation.reason = undefined;
    if (command === 'compact') {
      this.addLocalRow(conversation, rowId, {
        name: 'compact', argument: '', revision: conversation.revision, scopeStamp: this.commandScopeStamp(conversation.key),
        result: { state: 'pending' },
      });
    } else if (!setting) this.addRow(conversation, { id: rowId, role: 'user', text, state: 'pending', identity: { kind: 'user', id } });
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
      await worker.connection.send({ id, text, command });
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
      conversation.observedCapabilities = event.capabilities;
      conversation.model = event.model;
      conversation.identity = worker.launch.identity;
      this.changed(conversation);
      return;
    }
    const turn = conversation.turn;
    if (!worker.capabilities || !turn?.written || event.turnId !== turn.record.id) return;
    switch (event.kind) {
      case 'model':
        conversation.model = event.model;
        this.changed(conversation);
        break;
      case 'ack':
        if (event.messageId === turn.record.id) this.acknowledge(conversation, turn);
        break;
      case 'text':
        this.text(conversation, event, turn);
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
        if (turn.command === 'compact' || turn.command === 'effort' || turn.command === 'fast') {
          if (event.compact) conversation.compact = event.compact;
          if (turn.effort && event.effortAcknowledged) conversation.settings = { ...conversation.settings, effort: turn.effort };
          const completed = event.outcome === 'completed' && (turn.command !== 'effort' || event.effortAcknowledged);
          this.updateLocal(conversation.key, turn.rowId, { result: { state: completed ? 'completed' : 'failed',
            compact: event.compact, message: event.reason ?? event.commandText
              ?? (completed ? undefined : 'The provider did not confirm the command.') } });
        } else if (event.outcome !== 'completed') {
          if (event.errorKind === 'limit') for (const id of turn.textRows ?? []) conversation.rows.delete(id);
          const text = safeText(event.reason, 220)
            ?? (event.outcome === 'interrupted' ? 'Turn interrupted.' : 'The provider reported a failed turn.');
          this.addRow(conversation, { id: randomUUID(), role: event.errorKind === 'limit' ? 'error' : 'notice', text });
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
    if (conversation.revision === turn.revision) {
      conversation.draft = conversation.parkedDraft?.revision !== turn.revision ? conversation.parkedDraft?.text ?? '' : '';
      conversation.parkedDraft = undefined;
    } else if (conversation.parkedDraft?.revision === turn.revision) {
      conversation.parkedDraft = undefined;
    }
    this.changed(conversation);
  }

  private text(conversation: Conversation, event: Extract<ChatEvent, { kind: 'text' }>, turn: Turn): void {
    const id = JSON.stringify([event.turnId, event.messageId, event.blockId]);
    const previous = conversation.rows.get(id);
    if (event.mode === 'append' && previous?.truncated) return;
    const base = event.mode === 'append' ? previous?.text ?? '' : '';
    const text = base + event.text.slice(0, maxBlock - base.length);
    this.addRow(conversation, { id, role: 'assistant', text, truncated: base.length + event.text.length > maxBlock,
      identity: { kind: 'response', id: event.messageId } });
    (turn.textRows ??= new Set()).add(id);
    this.changed(conversation);
  }

  private tool(conversation: Conversation, event: Extract<ChatEvent, { kind: 'tool' | 'toolResult' }>): void {
    const id = JSON.stringify([event.turnId, event.callId, 'tool']);
    const previous = conversation.rows.get(id);
    const toolName = event.kind === 'tool' ? safeText(event.name, 80) ?? 'Tool' : previous?.toolName ?? 'Tool';
    const text = event.kind === 'tool' ? toolName
      : toolName + ' · ' + (event.outcome === 'needs-approval' ? approvalsLater : event.outcome === 'completed' ? 'Completed' : 'Failed');
    this.addRow(conversation, { id, role: 'tool', text, toolName, identity: { kind: 'call', id: event.callId } });
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

  private addLocalRow(conversation: Conversation, id: string, command: LocalChatRow): void {
    this.addRow(conversation, { id, role: 'notice', text: '', local: command });
    const rows = this.localRows(conversation.key);
    if (rows.length <= 12) return;
    const oldest = rows.find(row => row.id !== conversation.turn?.rowId);
    if (oldest) conversation.rows.delete(oldest.id);
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
      if (row?.local?.result?.state === 'pending') {
        this.updateLocal(conversation.key, turn.rowId, { result: { state: 'failed', message: deliveryUncertain } });
      }
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
    if (reason && conversation.rows.get(turn.rowId)?.local?.result?.state === 'pending') {
      this.updateLocal(conversation.key, turn.rowId, { result: { state: 'failed', message: reason } });
    }
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
