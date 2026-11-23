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

export type ContextLevel = "Normal" | "High" | "Critical";

export type ContextSample = {
  input?: number;
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
  movePath?: string;
  range?: { start: number; count?: number };
};

export type TimelineRow = {
  id: string;
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
};

export type Turn = {
  id: string;
  state: State;
  startedAt?: number;
  endedAt?: number;
  durationMs?: number;
  model?: string;
  effort?: string;
  cwd?: string;
  rootId?: string;
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
  parentReason?: string;
  context?: ContextSample;
  usage?: TokenCounts;
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
  branch?: string;
  title: string;
  model?: string;
  effort?: string;
  status: State;
  updatedAt?: number;
  lanes: Lane[];
  context?: ContextSample;
  usage?: TokenCounts;
  parents: ParentTarget[];
  parentReason?: string;
  children: ParentTarget[];
  files: FileAction[];
  signals: Signal[];
  background: BackgroundTask[];
  usageObservations: UsageObservation[];
  coverage: "recorded" | "partial";
};
