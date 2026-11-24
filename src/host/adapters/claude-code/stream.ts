import { TextDecoder } from 'node:util';
import type { Readable } from 'node:stream';
import type { ChatEvent, ChatLaunch, ChatSend, CompactMeasurement } from '../../chat/types';
import { localPath, pathKey } from '../../discovery/local-path';
import { count, identifier, record, safeText } from '../../privacy/projection';
import { rateLimitWindows } from '../../limits/claude-probe';
import type { Tokens } from '../types';
import { minimumClaudeCodeVersion, supportsClaudeCodeVersion } from './version';

const maxFrame = 1024 * 1024;
const maxBlockText = 32 * 1024;
const maxTurnText = 192 * 1024;
const maxBlocks = 256;
const maxCalls = 256;
const maxRememberedRecords = 16_384;
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const decoder = new TextDecoder('utf-8', { fatal: true });
const signInReason = 'Claude Code could not authenticate. Sign in to Claude Code for this profile, then try again.';
const versionReason = `This Claude Code executable does not support the chat options. Chat requires Claude Code ${minimumClaudeCodeVersion} or newer.`;
const turnFailure = 'Claude Code did not complete this turn.';

type Row = Record<string, unknown>;
type ToolOutcome = Extract<ChatEvent, { kind: 'toolResult' }>['outcome'];
type Update<T = ChatEvent> = T extends ChatLaunch ? Omit<T, keyof ChatLaunch> : never;

export function isClaudeSessionId(value: unknown): value is string {
  return typeof value === 'string' && uuid.test(value);
}

/** Frame complete byte lines before decoding so split UTF-8 sequences and CRLF are handled together. */
export function readClaudeFrames(stream: Readable, read: (line: string) => void): void {
  let parts: Buffer[] = [];
  let size = 0;
  let dropping = false;

  function append(bytes: Buffer): void {
    if (dropping || !bytes.length) return;
    size += bytes.length;
    if (size > maxFrame) {
      dropping = true;
      parts = [];
      return;
    }
    parts.push(bytes);
  }

  function line(): void {
    let text: string | undefined;
    if (!dropping && size) {
      try {
        text = decoder.decode(Buffer.concat(parts, size));
      } catch {
        // Invalid UTF-8 cannot provide session or delivery evidence.
      }
    }
    parts = [];
    size = 0;
    dropping = false;
    if (text) read(text);
  }

  stream.on('data', (chunk: Buffer) => {
    let offset = 0;
    for (let end = chunk.indexOf(10); end >= 0; end = chunk.indexOf(10, offset)) {
      append(chunk.subarray(offset, end));
      line();
      offset = end + 1;
    }
    append(chunk.subarray(offset));
  });
  stream.on('end', line);
}

/** Known provider diagnostic classes only. Keep all diagnostic strings at the adapter boundary. */
export function claudeDiagnostic(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.slice(0, 2048);
  if (/^\s*(?:authentication_failed|authentication_error|unauthorized|invalid_api_key)\s*$/i.test(text)
    || /(?:^|\n)[ \t]*(?:Error:[ \t]*)?(?:Not logged in\b|Please run \/login\b|Invalid API key\b|No API key found\b|Missing authentication credentials\b|OAuth token has expired\b|API Error: (?:401\b|Request failed with status code 401\b))/i.test(text)) return signInReason;
  if (/(?:^|\n)\s*(?:Error:\s*)?(?:unknown|unrecognized) (?:option|argument)\b/i.test(text)) return versionReason;
  return undefined;
}

function resultUsage(value: unknown): Tokens | undefined {
  const row = record(value);
  if (!row) return undefined;
  const usage: Tokens = {};
  const input = count(row.input_tokens);
  const output = count(row.output_tokens);
  const cacheRead = count(row.cache_read_input_tokens);
  const cacheWrite = count(row.cache_creation_input_tokens);
  const reasoning = count(record(row.output_tokens_details)?.thinking_tokens);
  if (input !== undefined) usage.input = input;
  if (output !== undefined) usage.output = output;
  if (cacheRead !== undefined) usage.cacheRead = cacheRead;
  if (cacheWrite !== undefined) usage.cacheWrite = cacheWrite;
  if (reasoning !== undefined) usage.reasoning = reasoning;
  return Object.keys(usage).length ? usage : undefined;
}

function names(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.slice(0, 256).map(identifier).filter((item): item is string => item !== undefined))];
}

/** `undefined` means this frame carries no explicit turn correlation. */
function correlates(row: Row, turnId: string): boolean | undefined {
  const scalar = row.user_message_uuid;
  const list = row.user_message_uuids;
  if (scalar !== undefined && scalar !== turnId) return false;
  if (list !== undefined && (!Array.isArray(list) || list.length !== 1 || list[0] !== turnId)) return false;
  return scalar === undefined && list === undefined ? undefined : true;
}

interface TextBlock {
  messageId: string;
  source: string;
  shown: string;
  complete: boolean;
  lastUpdate: number;
  heldLimit?: boolean;
}

interface Turn {
  id: string;
  acknowledged: boolean;
  interrupted: boolean;
  interruptRequested?: boolean;
  failure?: string;
  records: Set<string>;
  blocks: Map<string, TextBlock>;
  tools: Map<string, ToolOutcome | undefined>;
  textBytes: number;
  messageId?: string;
  blockIndex?: number;
  command?: ChatSend['command'];
  effort?: string;
  initialized?: boolean;
  started?: boolean;
  lifecycleCompleted?: boolean;
  terminal?: { row: Row; id: string };
  compacting?: boolean;
  compactSucceeded?: boolean;
  compact?: CompactMeasurement;
  commandReplay?: boolean;
}

interface Interrupt {
  id: string;
  turnId: string;
  received: (id: string) => void;
}

/** Project one owned Claude CLI stream. No provider frame or tool arguments leave this object. */
export class ClaudeChatStream {
  private turn?: Turn;
  private control?: Interrupt;
  private ready = false;
  private interruptSupported = false;
  private latestOutcome?: Extract<ChatEvent, { kind: 'result' }>['outcome'];
  private diagnostic?: string;
  private model?: string;
  private nativeCommands = false;
  private fastCheck = false;
  private modeControl?: { id: string; received: (value: { mode?: string; error?: string }) => void };
  private modelControl?: { id: string; received: (model?: string) => void };
  private lastResultId?: string;

  constructor(
    private readonly launch: ChatLaunch,
    private readonly emit: (event: ChatEvent) => void,
    private readonly close: (reason: string) => void,
    private readonly version?: string,
    private readonly approvals?: { receive(row: Record<string, unknown>): boolean; turnEnded(): void },
  ) {}

  get initialized(): boolean { return this.ready; }
  get active(): boolean { return this.turn !== undefined; }
  get turnId(): string | undefined { return this.turn?.id; }
  get lastOutcome() { return this.latestOutcome; }
  get failure(): string | undefined { return this.diagnostic; }

  permits(command: ChatSend['command']): boolean {
    return command === undefined || this.nativeCommands && (command !== 'fast' || this.fastCheck);
  }

  begin(id: string, command?: ChatSend['command'], input?: string): void {
    this.diagnostic = undefined;
    this.latestOutcome = undefined;
    this.turn = {
      id, acknowledged: false, interrupted: false,
      records: new Set(), blocks: new Map(), tools: new Map(), textBytes: 0,
      command, effort: command === 'effort' ? input?.slice('/effort '.length) : undefined,
    };
  }

  beginInterrupt(id: string, received: Interrupt['received']): boolean {
    if (!this.turn || !this.interruptSupported || this.control) return false;
    this.turn.interruptRequested = true;
    this.control = { id, turnId: this.turn.id, received };
    return true;
  }

  beginModeChange(id: string, received: (value: { mode?: string; error?: string }) => void): boolean {
    if (!this.ready || !this.nativeCommands || this.turn || this.control || this.modelControl || this.modeControl
      || !isClaudeSessionId(id)) return false;
    this.modeControl = { id, received };
    return true;
  }

  beginModelChange(id: string, received: (model?: string) => void): boolean {
    if (!this.ready || !this.nativeCommands || this.turn || this.control || this.modelControl || !isClaudeSessionId(id)) return false;
    this.modelControl = { id, received };
    return true;
  }

  private publish(event: Update): void {
    this.emit({ ...this.launch, ...event });
  }

  read(line: string): void {
    let row: Row | undefined;
    try {
      row = record(JSON.parse(line));
    } catch {
      this.diagnostic ??= claudeDiagnostic(line);
      return;
    }
    if (!row) return;
    if (row.type === 'control_response') {
      this.receipt(record(row.response));
      return;
    }
    if (row.type === 'control_request') {
      if (record(row.request)?.subtype === 'can_use_tool') {
        if (!this.approvals) this.close('Claude Code requested approval outside the available permission channel.');
        else this.approvals.receive(row);
      }
      return;
    }
    if (row.type === 'rate_limit_event' && this.ready && !row.parent_tool_use_id) {
      const windows = rateLimitWindows(row);
      if (windows) this.publish({ kind: 'limits', windows });
      return;
    }
    if (row.type === 'system' && row.subtype === 'status' && this.ready && !row.parent_tool_use_id) {
      const mode = identifier(row.permissionMode);
      if (mode) this.publish({ kind: 'mode', mode });
    }
    const turn = this.turn;
    if (!turn || row.parent_tool_use_id) return;
    if (row.type === 'command_lifecycle') {
      if (row.session_id === undefined || row.session_id === this.launch.identity.nativeId) this.lifecycle(turn, row);
      return;
    }
    const isInit = row.type === 'system' && row.subtype === 'init';
    if (row.session_id !== this.launch.identity.nativeId) {
      if (isInit) this.close('Claude Code opened a different session. Verify the selected conversation before retrying.');
      else if (!this.ready && row.type === 'result' && row.is_error === true) {
        const reason = this.resultError(row);
        if (reason) this.close(reason);
      }
      return;
    }
    const match = correlates(row, turn.id);
    if (match === false) return;
    if (isInit) {
      this.initialize(turn, row);
      return;
    }
    if (!this.ready) {
      if (row.type === 'result' && row.is_error === true) this.close(this.resultError(row) ?? turnFailure);
      return;
    }
    if (this.nativeCommands && turn.initialized && row.type === 'system' && (turn.started || turn.acknowledged)) {
      this.compactFrame(turn, row);
      return;
    }
    if (row.type === 'user' && row.isReplay === true && row.uuid === turn.id) {
      this.user(turn, row);
      return;
    }
    if (this.nativeCommands && turn.initialized && row.type === 'result') {
      const id = isClaudeSessionId(row.uuid) ? row.uuid : turn.id;
      if (id === this.lastResultId || !(match || turn.started || turn.acknowledged || limitReason(row.result))) return;
      if (match || turn.lifecycleCompleted) this.result(turn, row, id);
      else turn.terminal ??= { row, id };
      return;
    }
    const frameId = isClaudeSessionId(row.uuid) ? row.uuid : undefined;
    if (!frameId || turn.records.has(frameId)) return;
    if (turn.records.size === maxRememberedRecords) turn.records.delete(turn.records.values().next().value!);
    turn.records.add(frameId);

    switch (row.type) {
      case 'user': this.user(turn, row); break;
      case 'stream_event':
        if (turn.acknowledged || match) this.partial(turn, row);
        break;
      case 'assistant':
        if (turn.acknowledged || match) this.assistant(turn, row);
        break;
      case 'result':
        if (match || (row.is_error === true && !turn.acknowledged)) this.result(turn, row, frameId);
        break;
    }
  }

  private initialize(turn: Turn, row: Row): void {
    const cwd = localPath(row.original_cwd ?? row.cwd);
    const effective = localPath(row.cwd);
    if (!cwd || !effective || pathKey(cwd) !== pathKey(this.launch.identity.cwd) || pathKey(effective) !== pathKey(cwd)) {
      this.close('Claude Code opened a different project folder. Verify the selected workspace before retrying.');
      return;
    }
    const capabilities = Array.isArray(row.capabilities) ? row.capabilities.slice(0, 256) : [];
    const interrupt = capabilities.includes('interrupt_receipt_v1');
    const supportedExecutable = supportsClaudeCodeVersion(this.version);
    const verified = supportedExecutable && supportsClaudeCodeVersion(row.claude_code_version)
      && capabilities.includes('msg_lifecycle_v1') && Array.isArray(row.terminal_slash_commands);
    this.nativeCommands = verified;
    this.fastCheck = verified && row.fast_mode_state === 'off' && row.fast_mode_disabled_reason === 'extra_usage_disabled';
    turn.initialized = true;
    this.ready = true;
    this.interruptSupported = interrupt;
    const model = identifier(row.model);
    this.model = model;
    this.publish({ kind: 'ready', nativeId: this.launch.identity.nativeId,
      capabilities: { send: true, interrupt, ...(this.approvals ? { approvals: true } : {}), commands: names(row.slash_commands), skills: names(row.skills),
        version: this.version, literalText: supportedExecutable, nativeCommands: verified,
        terminalCommands: verified ? names(row.terminal_slash_commands) : undefined,
        permissionMode: identifier(row.permissionMode),
        effortActive: verified && row.per_turn_effort_active === true,
        ultrathinkAvailable: verified && row.ultrathink_available === true,
        fastMode: verified ? identifier(row.fast_mode_state) : undefined,
        fastDisabledReason: verified ? identifier(row.fast_mode_disabled_reason) : undefined },
      ...(model ? { model } : {}),
    });
    if (verified && turn.started) this.acknowledge(turn);
  }

  private receipt(response: Row | undefined): void {
    const modeChange = this.modeControl;
    if (modeChange && response?.request_id === modeChange.id && (response.subtype === 'success' || response.subtype === 'error')) {
      this.modeControl = undefined;
      const mode = identifier(record(response.response)?.mode);
      if (response.subtype === 'success' && mode) {
        this.publish({ kind: 'mode', mode });
        modeChange.received({ mode });
      } else {
        modeChange.received({ error: safeText(typeof response.error === 'string' ? response.error : undefined, 160)
          ?? 'Claude Code did not accept the permission mode.' });
      }
      return;
    }
    const model = this.modelControl;
    if (model && response?.request_id === model.id && (response.subtype === 'success' || response.subtype === 'error')) {
      this.modelControl = undefined;
      model.received(response.subtype === 'success' ? identifier(record(response.response)?.model) : undefined);
      return;
    }
    const control = this.control;
    if (!control || response?.request_id !== control.id || (response.subtype !== 'success' && response.subtype !== 'error')) return;
    this.control = undefined;
    control.received(control.id);
    this.publish({ kind: 'interruptReceipt', turnId: control.turnId, requestId: control.id, accepted: response.subtype === 'success' });
  }

  private acknowledge(turn: Turn): void {
    if (turn.acknowledged) return;
    turn.acknowledged = true;
    this.publish({ kind: 'ack', turnId: turn.id, messageId: turn.id });
  }

  private lifecycle(turn: Turn, row: Row): void {
    if (!supportsClaudeCodeVersion(this.version) || row.command_uuid !== turn.id) return;
    if (row.state === 'started') {
      turn.started = true;
      if (turn.initialized && this.nativeCommands) this.acknowledge(turn);
    } else if (row.state === 'completed') {
      turn.lifecycleCompleted = true;
      if (turn.initialized && this.nativeCommands && turn.terminal && turn.acknowledged) {
        this.result(turn, turn.terminal.row, turn.terminal.id);
      }
    }
  }

  private compactFrame(turn: Turn, row: Row): void {
    if (turn.command !== 'compact') return;
    if (row.subtype === 'status') {
      if (row.status === 'compacting') turn.compacting = true;
      if (turn.compacting && row.status === null && row.compact_result === 'success') turn.compactSucceeded = true;
    } else if (row.subtype === 'compact_boundary' && turn.compactSucceeded) {
      const metadata = record(row.compact_metadata);
      const preTokens = count(metadata?.pre_tokens);
      const postTokens = count(metadata?.post_tokens);
      if (metadata?.trigger === 'manual' && preTokens !== undefined && postTokens !== undefined) {
        turn.compact = { preTokens, postTokens, at: Date.now() };
      }
    }
  }

  private user(turn: Turn, row: Row): void {
    const message = record(row.message);
    if (message?.role !== 'user') return;
    if (row.isReplay === true) {
      if (row.uuid !== turn.id) return;
      if (turn.effort && typeof message.content === 'string'
        && message.content.includes('<command-name>/effort</command-name>')
        && message.content.includes('<command-args>' + turn.effort + '</command-args>')) turn.commandReplay = true;
      this.acknowledge(turn);
      return;
    }
    if (!Array.isArray(message.content)) return;
    // The observed interruption marker is a native, non-replay user record unrelated to the draft UUID.
    const marker = message.content.length === 1 && record(message.content[0]);
    if (turn.interruptRequested && marker && marker.type === 'text' && row.uuid !== turn.id
        && (marker.text === '[Request interrupted by user]' || marker.text === '[Request interrupted by user for tool use]')) {
      turn.interrupted = true;
      return;
    }
    if (!turn.acknowledged) return;
    const metadata = Array.isArray(row.tool_result_meta) ? row.tool_result_meta.slice(0, maxCalls).map(record) : [];
    for (const item of message.content.slice(0, maxCalls)) {
      const block = record(item);
      const id = identifier(block?.tool_use_id);
      if (block?.type !== 'tool_result' || !id) continue;
      const details = metadata.find(detail => detail?.id === id);
      const decision = record(details?.permission_decision);
      const needsApproval = details?.non_execution_kind === 'permission-prompt'
        || (decision?.decision === 'reject' && decision.reason_type === 'permission_prompt_disabled');
      const rejected = decision?.decision === 'reject' || details?.non_execution_kind === 'permission-rule';
      const outcome = needsApproval ? 'needs-approval' : rejected || block.is_error === true ? 'failed' : 'completed';
      this.toolResult(turn, id, outcome);
    }
  }

  private partial(turn: Turn, row: Row): void {
    const event = record(row.event);
    if (!event) return;
    if (event.type === 'message_start') {
      const message = record(event.message);
      turn.messageId = message?.role === 'assistant' ? identifier(message.id) : undefined;
      turn.blockIndex = undefined;
      return;
    }
    const messageId = turn.messageId;
    if (!messageId || (row.api_message_id !== undefined && row.api_message_id !== messageId)) return;
    if (event.type === 'message_stop') {
      turn.messageId = undefined;
      turn.blockIndex = undefined;
      return;
    }
    const index = count(event.index);
    if (index === undefined || index >= maxBlocks) return;
    if (event.type === 'content_block_start') {
      turn.blockIndex = index;
      const block = record(event.content_block);
      if (block?.type === 'text') this.text(turn, messageId, index, block.text, false);
      else if (block?.type === 'tool_use') this.tool(turn, block);
    } else if (event.type === 'content_block_delta' && turn.blockIndex === index) {
      const delta = record(event.delta);
      if (delta?.type === 'text_delta') this.text(turn, messageId, index, delta.text, false);
    } else if (event.type === 'content_block_stop' && turn.blockIndex === index) {
      this.flushText(turn, messageId, index);
      turn.blockIndex = undefined;
    }
  }

  private assistant(turn: Turn, row: Row): void {
    if (row.error !== undefined && row.error !== null) {
      turn.failure = this.resultError(row) ?? turnFailure;
      return;
    }
    const message = record(row.message);
    const messageId = identifier(message?.id);
    if (!messageId || message?.role !== 'assistant' || !Array.isArray(message.content)) return;
    const model = identifier(message.model);
    if (model && model !== this.model) {
      this.model = model;
      this.publish({ kind: 'model', turnId: turn.id, model });
    }
    // Claude sends a complete assistant record per block while streaming, including later block indices.
    const firstIndex = message.content.length === 1 && turn.messageId === messageId ? turn.blockIndex ?? 0 : 0;
    for (const [offset, item] of message.content.slice(0, maxBlocks).entries()) {
      const block = record(item);
      if (block?.type === 'text') this.text(turn, messageId, firstIndex + offset, block.text, true);
      else if (block?.type === 'tool_use') this.tool(turn, block);
    }
  }

  private text(turn: Turn, messageId: string, index: number, value: unknown, complete: boolean): void {
    if (typeof value !== 'string') return;
    const key = `${messageId}:${index}`;
    let block = turn.blocks.get(key);
    if (block?.complete) return;
    if (!block) {
      if (turn.blocks.size >= maxBlocks) return;
      block = { messageId, source: '', shown: '', complete: false, lastUpdate: 0 };
      turn.blocks.set(key, block);
    }
    const source = complete ? value : block.source + value;
    const available = Math.min(maxBlockText, maxTurnText - turn.textBytes + block.source.length);
    const next = source.slice(0, available);
    turn.textBytes += next.length - block.source.length;
    block.source = next;
    block.complete = complete;
    const now = Date.now();
    if (!complete && now - block.lastUpdate < 60) return;
    this.showText(turn, messageId, key, block, now);
  }

  private flushText(turn: Turn, messageId: string, index: number): void {
    const key = `${messageId}:${index}`;
    const block = turn.blocks.get(key);
    if (block) this.showText(turn, messageId, key, block, Date.now());
  }

  private showText(turn: Turn, messageId: string, blockId: string, block: TextBlock, at: number, releaseLimit = false): void {
    const text = safeText(block.source.replace(/[\uD800-\uDBFF]$/, ''), maxBlockText) ?? '';
    block.lastUpdate = at;
    if (!releaseLimit && text && (limitReason(text) || (!block.complete
      && ("You've hit your 5-hour limit".startsWith(text) || 'You’ve hit your 5-hour limit'.startsWith(text))))) {
      block.heldLimit = true;
      return;
    }
    block.heldLimit = false;
    if (text === block.shown) return;
    const append = text.startsWith(block.shown);
    const update = append ? text.slice(block.shown.length) : text;
    block.shown = text;
    if (turn.command && turn.command !== 'native') return;
    this.publish({ kind: 'text', turnId: turn.id, messageId, blockId, mode: append ? 'append' : 'replace', text: update });
  }

  private tool(turn: Turn, block: Row): void {
    const callId = identifier(block.id);
    const name = identifier(block.name);
    if (!callId || !name || turn.tools.has(callId) || turn.tools.size >= maxCalls) return;
    turn.tools.set(callId, undefined);
    this.publish({ kind: 'tool', turnId: turn.id, callId, name });
  }

  private toolResult(turn: Turn, callId: string, outcome: ToolOutcome): void {
    if (!turn.tools.has(callId) || turn.tools.get(callId)) return;
    turn.tools.set(callId, outcome);
    this.publish({ kind: 'toolResult', turnId: turn.id, callId, outcome });
  }

  private resultError(row: Row): string | undefined {
    const limited = limitReason(row.result);
    if (limited) return limited;
    const errors = Array.isArray(row.errors) ? row.errors.slice(0, 16) : [];
    for (const value of [row.error, row.result, ...errors]) {
      const error = record(value);
      const inner = record(error?.error);
      const reason = claudeDiagnostic(value) ?? claudeDiagnostic(error?.type) ?? claudeDiagnostic(error?.code)
        ?? claudeDiagnostic(error?.message) ?? claudeDiagnostic(inner?.type) ?? claudeDiagnostic(inner?.message);
      if (reason) return reason;
    }
    return undefined;
  }

  private result(turn: Turn, row: Row, frameId: string): void {
    if (Array.isArray(row.permission_denials)) {
      for (const item of row.permission_denials.slice(0, maxCalls)) {
        const id = identifier(record(item)?.tool_use_id);
        if (id) this.toolResult(turn, id, 'failed');
      }
    }
    if (turn.messageId && turn.blockIndex !== undefined) this.flushText(turn, turn.messageId, turn.blockIndex);
    if (turn.command && turn.command !== 'native' && ![...turn.blocks.values()].some(block => block.shown)) {
      this.text(turn, frameId, 0, row.result, true);
    }
    const compact = turn.command === 'compact' ? turn.compact : undefined;
    const completed = row.subtype === 'success' && row.is_error !== true && (turn.command !== 'compact' || Boolean(compact));
    if (completed) {
      for (const [key, block] of turn.blocks) {
        if (block.heldLimit) this.showText(turn, block.messageId, key, block, Date.now(), true);
      }
    }
    const reason = completed ? undefined : this.resultError(row) ?? turn.failure ?? this.diagnostic;
    const outcome = completed ? 'completed' : turn.interrupted ? 'interrupted' : 'failed';
    const usage = resultUsage(row.usage);
    const commandText = turn.command && turn.command !== 'native'
      ? safeText([...turn.blocks.values()].map(block => block.shown).filter(Boolean).join('\n'), 1000) : undefined;
    const effortAcknowledged = completed && turn.commandReplay && row.num_turns === 0 && turn.effort
      && commandText?.startsWith('Set effort level to ' + turn.effort + ' (this session only)');
    // Some successful native commands return only a result string and no assistant blocks.
    if (completed && ![...turn.blocks.values()].some(block => block.shown)) this.text(turn, frameId, 0, row.result, true);
    this.latestOutcome = outcome;
    this.lastResultId = frameId;
    this.turn = undefined;
    this.approvals?.turnEnded();
    this.publish({ kind: 'result', turnId: turn.id, outcome, usage, commandText, effortAcknowledged: Boolean(effortAcknowledged),
      compact: completed ? compact : undefined, errorKind: row.is_error === true && limitReason(row.result) ? 'limit' : undefined,
      ...(outcome === 'failed' ? { reason: reason ?? (turn.command === 'compact'
        ? 'Compaction did not report a verified context measurement.' : turnFailure) } : {}),
    });
  }
}

function limitReason(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^You['’]ve hit your 5-hour limit\b/u.test(value)) return undefined;
  return safeText(value, 220);
}
