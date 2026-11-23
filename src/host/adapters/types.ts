import type { ChatAdapter } from '../chat/types';

export type Provider = 'claude-code' | 'codex';

export interface Profile {
  id: string;
  provider: Provider;
  label: string;
  home: string;
  root?: string;
  active?: boolean;
}

export interface Source {
  key: string;
  provider: Provider;
  home: string;
  profileId?: string;
  path: string;
  root: string;
  sessionId: string;
  laneId: string;
  kind: 'transcript' | 'agent-metadata' | 'index' | 'presence';
  updatedAt: number;
  writerPresent?: boolean;
}

export type RecordKind = 'known' | 'unknown' | 'malformed';

export interface FileEvidence {
  path: string;
  kind: 'read' | 'edit' | 'add' | 'delete' | 'move' | 'mention' | 'checkpoint';
  destination?: string;
  patch?: string;
  before?: string;
  after?: string;
  range?: { offset?: number; limit?: number };
  status?: 'pending' | 'applied' | 'failed' | 'inferred' | 'unknown';
}

export interface Tokens {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
  total?: number;
}

export interface EventBase {
  id: string;
  nativeId?: string;
  recordId?: string;
  responseId?: string;
  variant?: 'structured' | 'provisional' | 'fallback';
  at?: number;
  turnId?: string;
  rootTurnId?: string;
  parentId?: string;
  cwd?: string;
}

export type Outcome = 'running' | 'completed' | 'failed' | 'interrupted' | 'aborted';
export type ResultStatus = 'success' | 'failed' | 'unknown' | 'scheduled';
export type LauncherEvidence =
  | { evidence: 'marker' | 'thread-started' | 'native-header'; threadId: string; cwd?: string }
  | { evidence: 'conflicting' };

export type Event = EventBase & (
  | { kind: 'metadata'; title?: string; titleSource?: 'index' | 'generated' | 'fallback'; model?: string; effort?: string; version?: string; branch?: string; origin?: string; threadId?: string; parentThreadId?: string; parentConflict?: boolean; spawnCallId?: string; description?: string; agentType?: string; outcome?: Outcome; stoppedByUser?: boolean; leafId?: string; stopReason?: string; spawnDepth?: number; historyStartOrdinal?: number; modelSource?: 'turn-context' | 'thread-settings'; presence?: { pid?: number; procStart?: number; pidDomain?: string; status?: string; statusUpdatedAt?: number } }
  | { kind: 'turn'; state: Outcome; model?: string; effort?: string; durationMs?: number; capacity?: number; startedAt?: number; implicit?: boolean }
  | { kind: 'message'; role: 'user' | 'assistant' | 'final' | 'reasoning' | 'agent' | 'attachment' | 'error' | 'plan'; text: string; durationMs?: number }
  | { kind: 'call'; name: string; callId: string; text?: string; command?: string; argv?: string[]; argumentKey?: string; polling?: boolean; spawn?: boolean; background?: boolean; restricted?: boolean; files?: FileEvidence[] }
  | { kind: 'result'; callId: string; callRowId?: string; sourceAssistantId?: string; status: ResultStatus; text?: string; exitCode?: number; durationMs?: number; files?: FileEvidence[]; agentId?: string; backgroundTaskId?: string; backgroundCwd?: string; taskOutputPath?: string; launcher?: LauncherEvidence; childOutcome?: Outcome; interrupted?: boolean; toolEndsTurn?: boolean }
  | { kind: 'file'; files: FileEvidence[] }
  | { kind: 'task'; taskId: string; state: Outcome; description?: string; taskOutputPath?: string; sourceCallId?: string }
  | { kind: 'spawn'; childThreadId: string; state?: Outcome; model?: string; effort?: string }
  | { kind: 'usage'; scope: 'response' | 'turn' | 'thread' | 'reported' | 'last-response'; responseId?: string; tokens: Tokens; model?: string }
  | { kind: 'context'; percent?: number; input?: number; capacity?: number; approximate?: boolean }
  | { kind: 'compaction' }
  | { kind: 'limits'; bucket?: string; windows: LimitWindow[] }
);

export interface LimitWindow {
  minutes: number;
  usedPercent: number;
  resetsAt: number;
}

export interface Adapter {
  id: Provider;
  label: string;
  homeOverride: 'CLAUDE_CONFIG_DIR' | 'CODEX_HOME';
  defaultHome: string;
  historyDirectory: string;
  capabilities: { watch: true; usage: true; limits: readonly number[]; auth: { status: boolean }; chat: boolean; modelSelect: false };
  chat?: ChatAdapter;
  classifyRecord: (record: unknown, source: Source) => RecordKind;
  parseRecords: (record: unknown, source: Source, offset: number) => Event[];
}
