import type { Provider, Tokens } from '../adapters/types';

/** Paths have been canonicalized by the host. Profile ids are scoped to their provider. */
export interface ChatScope {
  provider: Provider;
  profile: string;
  home: string;
  cwd: string;
}

export interface ChatIdentity extends ChatScope {
  nativeId: string;
}

export interface ChatLaunch {
  identity: ChatIdentity;
  /** Unique for each owned connection, including a later resume of the same conversation. */
  owner: string;
  resume: boolean;
  settings?: ChatSettings;
}

export interface ChatSettings {
  model?: string;
  effort?: string;
}

export interface CompactMeasurement {
  preTokens: number;
  postTokens: number;
  at: number;
}

export interface ChatCapabilities {
  send: boolean;
  interrupt: boolean;
  commands: readonly string[];
  skills: readonly string[];
  /** Observed executable version, bound to this owner and its immutable scope. */
  version?: string;
  literalText?: boolean;
  nativeCommands?: boolean;
  terminalCommands?: readonly string[];
  permissionMode?: string;
  /** The channel answers permission requests through the host bridge. */
  approvals?: boolean;
  effortActive?: boolean;
  ultrathinkAvailable?: boolean;
  fastMode?: string;
  fastDisabledReason?: string;
}

export interface ChatSend {
  /** Local UUID placed on the provider envelope and returned in replay. */
  id: string;
  text: string;
  command?: 'native' | 'compact' | 'effort' | 'fast';
}

export type ChatOutcome = 'completed' | 'interrupted' | 'failed';

type ChatUpdate =
  | { kind: 'ready'; nativeId: string; capabilities: ChatCapabilities; model?: string }
  | { kind: 'ack'; turnId: string; messageId: string }
  | { kind: 'model'; turnId: string; model: string }
  | { kind: 'text'; turnId: string; messageId: string; blockId: string; mode: 'append' | 'replace'; text: string }
  | { kind: 'tool'; turnId: string; callId: string; name: string }
  | { kind: 'toolResult'; turnId: string; callId: string; outcome: 'completed' | 'failed' | 'needs-approval' }
  | { kind: 'approval'; turnId: string; requestId: string; toolUseId: string; toolName: string; description?: string;
    preview: string; deadline: number }
  | { kind: 'approvalEnd'; turnId: string; requestId: string; toolUseId: string;
    state: 'allowed' | 'denied' | 'expired' | 'closed' | 'interrupted'; message?: string }
  | { kind: 'interruptReceipt'; turnId: string; requestId: string; accepted: boolean }
  | { kind: 'result'; turnId: string; outcome: ChatOutcome; usage?: Tokens; reason?: string;
    compact?: CompactMeasurement; commandText?: string; effortAcknowledged?: boolean; errorKind?: 'limit' }
  /** Account-wide limit windows from a per-turn `rate_limit_event`, not tied to a turn. */
  | { kind: 'limits'; windows: import('../limits/claude-probe').ProbeWindows }
  /** Permission mode the CLI reported in a `system/status` frame. */
  | { kind: 'mode'; mode: string }
  | { kind: 'exit'; reason?: string };

export type ChatEvent = ChatLaunch & ChatUpdate;

export interface ChatConnection {
  /** A successful write leaves delivery pending until acknowledged. */
  send(message: ChatSend): Promise<void>;
  interrupt(): Promise<string>;
  setModel?(model: string): Promise<string | undefined>;
  /** Typed `set_permission_mode` control request. Resolves with the mode the CLI reported, or its error. */
  setPermissionMode?(mode: string): Promise<{ mode?: string; error?: string }>;
  /** Close only this worker and resolve when it has exited. */
  close(): Promise<void>;
  /** Answer one live permission request. The adapter rechecks owner, turn and deadline and replays the original input. */
  decideApproval?(requestId: string, decision: 'allow' | 'deny', context: { epoch: string; turnId: string | undefined }):
    { ok: true } | { ok: false; reason: string };
}

export interface ChatAdapter {
  open(launch: ChatLaunch, emit: (event: ChatEvent) => void, signal: AbortSignal): Promise<ChatConnection>;
  checkWriter?(identity: ChatIdentity): Promise<'present' | 'absent' | 'unknown'>;
}

/** An adapter supplies only reviewed, user-facing launch messages through this error. */
export class ChatLaunchError extends Error {}

/** Minimal recovery metadata. Never persist prompt text or provider output. */
export interface ChatAttempt {
  identity: ChatIdentity;
  id: string;
  acknowledged: boolean;
  conversation?: string;
}
