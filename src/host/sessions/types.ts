import type { Source } from "../adapters/types";

export type State = "Recorded" | "Live" | "Waiting" | "Writer present" | "Completed" | "Failed" |
  "Interrupted" | "Aborted" | "Stopped" | "Outcome unknown" | "Unavailable";

export type TokenCounts = {
  input?: number;
  cacheRead?: number;
  cacheWrite?: number;
  output?: number;
  reasoning?: number;
  total?: number;
};

export type ModelSource = "transcript" | "turn-context" | "thread-settings";

export type ContextLevel = "Normal" | "High" | "Critical";

export type ContextSample = {
  input?: number;
  inputComponents?: Pick<TokenCounts, 'input' | 'cacheRead' | 'cacheWrite'>;
  capacity?: number;
  percent?: number;
  approximate: boolean;
  at?: number;
  level?: ContextLevel;
};

export type UsageObservation = {
  id: string;
  laneId: string;
  turnId?: string;
  at?: number;
  model?: string;
  scope: "response" | "turn" | "thread" | "reported" | "last";
  counts: TokenCounts;
};

export type ParentTarget = {
  sessionId: string;
  laneId: string;
  rowId: string;
  turnId?: string;
  at?: number;
  relation: "agent" | "child" | "launch";
};

/** A pointer at one timeline row, possibly in another session of the same delegation tree. */
export type RowRef = {
  sessionId: string;
  laneId: string;
  rowId: string;
};

export type Signal = {
  id: string;
  laneId: string;
  turnId?: string;
  kind: "loop" | "check" | "context";
  state: "live" | "historical";
  rowIds: string[];
  label: string;
  detail?: string;
  count?: number;
  level?: ContextLevel;
  /** Done without checks outcome. */
  outcome?: "no-checks" | "check-failed" | "check-unknown";
  /** Last confirmed edit and last check of a turn tree, for the end-of-turn marker links. */
  edit?: RowRef;
  check?: RowRef;
};

export type FileAction = {
  id: string;
  laneId: string;
  turnId?: string;
  rowId: string;
  path: string;
  label: string;
  cwd?: string;
  kind: "read" | "edit" | "add" | "delete" | "move" | "mention" | "checkpoint";
  status: "requested" | "read" | "applied" | "failed" | "inferred" | "recorded";
  at?: number;
  diff?: string;
  diffKind?: 'hunks' | 'partial' | 'complete';
  projectRoot?: string;
  diffUnavailable?: string;
  provider?: Source['provider'];
  project?: string;
  movePath?: string;
  range?: { start: number; count?: number };
};

export type TimelineRow = {
  id: string;
  /** Opaque hashes of exact provider identities (prompt uuid, response id, call id) for live reconciliation. */
  nativeKeys?: string[];
  laneId: string;
  turnId?: string;
  at?: number;
  kind: "user" | "assistant" | "final" | "reasoning" | "tool" | "result" | "compact" | "agent" | "task" | "system";
  label: string;
  text?: string;
  output?: string;
  status?: string;
  command?: string;
  exitCode?: number;
  file?: string;
  durationMs?: number;
  responseId?: string;
  parentRecordId?: string;
  currentBranch?: boolean;
  ambiguous?: boolean;
};

export type Turn = {
  id: string;
  nativeId?: string;
  state: State;
  startedAt?: number;
  endedAt?: number;
  durationMs?: number;
  model?: string;
  effort?: string;
  /** Which recorded evidence supplied the model and effort. Never a requested selection. */
  modelSource?: ModelSource;
  cwd?: string;
  rootId?: string;
  usage?: TokenCounts;
  usageScope?: UsageObservation['scope'];
};

export type Lane = {
  id: string;
  nativeId: string;
  title: string;
  model?: string;
  effort?: string;
  status: State;
  rows: TimelineRow[];
  turns: Turn[];
  parent?: ParentTarget;
  parentSessionId?: string;
  parentReason?: string;
  branchLeaf?: string;
  pending?: boolean;
  transcriptAvailable?: boolean;
  latestActivity?: TimelineRow;
  context?: ContextSample;
  usage?: TokenCounts;
  usageScope?: UsageObservation['scope'];
  signals: Signal[];
  startedAt?: number;
  updatedAt?: number;
};

export type BackgroundTask = {
  id: string;
  laneId: string;
  title: string;
  status: State;
  rowId: string;
  turnId?: string;
  at?: number;
};

export type Session = {
  id: string;
  provider: Source["provider"];
  profile?: string;
  nativeId: string;
  cwd?: string;
  project?: string;
  projectRoot?: string;
  branch?: string;
  title: string;
  origin?: string;
  model?: string;
  effort?: string;
  status: State;
  updatedAt?: number;
  lanes: Lane[];
  context?: ContextSample;
  usage?: TokenCounts;
  usageScope?: UsageObservation['scope'];
  usagePartial?: boolean;
  launches?: import('./delegation').DelegationLink[];
  parents: ParentTarget[];
  parentReason?: string;
  children: ParentTarget[];
  files: FileAction[];
  signals: Signal[];
  background: BackgroundTask[];
  usageObservations: UsageObservation[];
  coverage: "recorded" | "partial";
};
