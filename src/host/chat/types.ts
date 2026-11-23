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
}

export interface ChatCapabilities {
  send: boolean;
  interrupt: boolean;
  commands: readonly string[];
  skills: readonly string[];
}

export interface ChatSend {
  /** Local UUID placed on the provider envelope and returned in replay. */
  id: string;
  text: string;
}

export type ChatOutcome = 'completed' | 'interrupted' | 'failed';

type ChatUpdate =
  | { kind: 'ready'; nativeId: string; capabilities: ChatCapabilities; model?: string }
  | { kind: 'ack'; turnId: string; messageId: string }
  | { kind: 'text'; turnId: string; messageId: string; blockId: string; mode: 'append' | 'replace'; text: string }
  | { kind: 'tool'; turnId: string; callId: string; name: string }
  | { kind: 'toolResult'; turnId: string; callId: string; outcome: 'completed' | 'failed' | 'needs-approval' }
  | { kind: 'interruptReceipt'; turnId: string; requestId: string; accepted: boolean }
  | { kind: 'result'; turnId: string; outcome: ChatOutcome; usage?: Tokens; reason?: string }
  | { kind: 'exit'; reason?: string };

export type ChatEvent = ChatLaunch & ChatUpdate;

export interface ChatConnection {
  /** A successful write leaves delivery pending until acknowledged. */
  send(message: ChatSend): Promise<void>;
  interrupt(): Promise<string>;
  /** Close only this worker and resolve when it has exited. */
  close(): Promise<void>;
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
