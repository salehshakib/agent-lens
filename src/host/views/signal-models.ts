import { safeText } from '../privacy/projection';
import { contextLevel, defaultSignalSettings } from '../sessions/signals';
import type { SignalSettings } from '../sessions/signals';
import type { Lane, ParentTarget, Session, Signal } from '../sessions/types';
import type { Crumb, ParentChoice, ParentInfo, RowTarget, SignalView, StatusTone } from '../../shared/protocol';

/** Display names supplied by the model builders, so these helpers stay free of title and privacy rules. */
export interface Names {
  session(session: Session): string;
  project(session: Session): string;
}

export type Thresholds = Pick<SignalSettings, 'warnPercent' | 'criticalPercent'>;

export const defaultThresholds: Thresholds = {
  warnPercent: defaultSignalSettings.warnPercent, criticalPercent: defaultSignalSettings.criticalPercent,
};

export interface LaneContext {
  level?: 'High' | 'Critical';
  percent?: number;
  approximate: boolean;
}

/**
 * The context level of one lane. A level exists only where a percentage exists: the Claude status-line percentage
 * for the main session, or the Codex approximate last-request fill. Claude subagents and unknown capacity have none.
 */
export function laneContext(session: Session, lane: Lane, relay: number | undefined, thresholds: Thresholds = defaultThresholds): LaneContext {
  if (session.provider === 'claude-code') {
    if (lane !== session.lanes[0] || relay === undefined) return { approximate: false };
    const level = contextLevel(relay, thresholds);
    return { level: level === 'Normal' ? undefined : level, percent: relay, approximate: false };
  }
  const context = lane.context;
  if (!context) return { approximate: false };
  const level = context.level === 'High' || context.level === 'Critical' ? context.level : undefined;
  return { level, percent: context.percent, approximate: context.approximate };
}

export function contextView(context: LaneContext): SignalView | undefined {
  if (!context.level) return undefined;
  return {
    kind: 'context', state: 'live', label: 'Context ' + context.level + (context.approximate ? ' (approximate)' : ''),
    detail: context.percent === undefined ? undefined : Math.round(context.percent) + '% of context window',
    tone: context.level === 'Critical' ? 'fail' : 'warn',
  };
}

function outcomeTone(signal: Signal): StatusTone {
  if (signal.state === 'historical') return 'neutral';
  return signal.outcome === 'check-failed' ? 'fail' : 'warn';
}

/** A loop or check signal as a label. Context signals are built from the lane context instead. */
export function signalView(signal: Signal, privateMode: boolean): SignalView | undefined {
  if (signal.kind === 'loop') {
    const live = signal.state === 'live';
    return { kind: 'loop', state: signal.state, label: live ? 'Possible loop' : 'Earlier loop',
      detail: privateMode ? undefined : safeText(signal.detail, 120), tone: live ? 'warn' : 'neutral' };
  }
  if (signal.kind === 'check') {
    // The detail can hold the check command, which private mode never shows.
    const detail = privateMode
      ? (signal.outcome === 'no-checks' ? safeText(signal.detail, 120) : undefined)
      : safeText(signal.detail, 200);
    return { kind: 'check', state: signal.state, label: signal.label,
      detail: signal.state === 'historical' ? [detail, 'a later turn passed a check'].filter(Boolean).join(' · ') : detail,
      tone: outcomeTone(signal) };
  }
  return undefined;
}

/** Live signals for one lane card: live loops, the lane's live check outcome and a High or Critical context level. */
export function laneSignals(lane: Lane, context: LaneContext, privateMode: boolean): SignalView[] {
  const views = lane.signals.filter(signal => signal.state === 'live')
    .map(signal => signalView(signal, privateMode)).filter((view): view is SignalView => !!view);
  const level = contextView(context);
  return level ? [...views, level] : views;
}

export interface SessionSignals {
  liveLoops: number;
  loops: SignalView[];
  outcome?: SignalView;
  context?: SignalView;
}

/** Session-level summary: live streak count, latest live turn outcome and the main lane's context level. */
export function sessionSignals(session: Session, context: LaneContext, privateMode: boolean): SessionSignals {
  const loops = session.signals.filter(signal => signal.kind === 'loop' && signal.state === 'live');
  const checks = session.signals.filter(signal => signal.kind === 'check' && signal.state === 'live');
  const latest = checks.at(-1);
  return {
    liveLoops: loops.length,
    loops: loops.map(signal => signalView(signal, privateMode)).filter((view): view is SignalView => !!view),
    outcome: latest ? signalView(latest, privateMode) : undefined,
    context: contextView(context),
  };
}

/** Short warning labels for a sidebar row. Empty when the session has nothing to warn about. */
export function warningLabels(summary: SessionSignals): SignalView[] {
  const labels: SignalView[] = [];
  const first = summary.loops[0];
  if (first) {
    labels.push(summary.loops.length === 1 ? first
      : { ...first, detail: summary.loops.length + ' repeated calls' });
  }
  if (summary.outcome) labels.push(summary.outcome);
  if (summary.context) labels.push(summary.context);
  return labels;
}

function laneLabel(session: Session, lane: Lane | undefined): string {
  if (!lane) return 'Agent';
  if (lane === session.lanes[0]) return (session.provider === 'claude-code' ? 'Claude' : 'Codex') + ' main';
  return safeText(lane.title, 60) ?? 'Agent';
}

function newestFirst(targets: readonly ParentTarget[]): ParentTarget[] {
  return [...targets].sort((a, b) => (b.at ?? -Infinity) - (a.at ?? -Infinity));
}

function choice(target: ParentTarget, byId: ReadonlyMap<string, Session>, names: Names): ParentChoice {
  const parent = byId.get(target.sessionId);
  const lane = parent?.lanes.find(item => item.id === target.laneId);
  const label = parent ? names.session(parent) + ' · ' + laneLabel(parent, lane) : 'Session unavailable';
  return { sessionId: target.sessionId, laneId: target.laneId, rowId: target.rowId, label, at: target.at };
}

/** Resolved parent targets of one lane. Root sessions have none and Open parent stays hidden. */
export function parentInfo(session: Session, lane: Lane, byId: ReadonlyMap<string, Session>, names: Names): ParentInfo {
  if (lane !== session.lanes[0]) {
    if (lane.parent) return { state: 'resolved', targets: [choice(lane.parent, byId, names)] };
    return { state: 'unresolved', reason: lane.parentReason ?? 'Parent not resolved yet', targets: [] };
  }
  const edges = session.parents.filter(edge => edge.relation === 'child' || edge.relation === 'launch');
  if (lane.parent && lane.parent.relation !== 'agent' && !edges.some(edge => edge.rowId === lane.parent!.rowId
    && edge.sessionId === lane.parent!.sessionId)) edges.push(lane.parent);
  if (edges.length) return { state: 'resolved', targets: newestFirst(edges).map(edge => choice(edge, byId, names)) };
  const reason = lane.parentReason ?? session.parentReason;
  if (reason || lane.parentSessionId) return { state: 'unresolved', reason: reason ?? 'Parent not resolved yet', targets: [] };
  return { state: 'root', targets: [] };
}

const maxChain = 8;

/**
 * The delegation chain from the root to this session, for example
 * "dashboard / Fix export flow > Claude main > Bash > Codex validator". Each ancestor segment opens that ancestor.
 */
export function breadcrumb(session: Session, byId: ReadonlyMap<string, Session>, names: Names): Crumb[] {
  const hops: { parent: Session; target: ParentTarget }[] = [];
  const visited = new Set([session.id]);
  let cursor: Session = session;
  for (let depth = 0; depth < maxChain; depth++) {
    const main = cursor.lanes[0];
    if (!main) break;
    const first = parentInfo(cursor, main, byId, names).targets[0];
    const target = first && newestFirst(cursor.parents.filter(edge => edge.relation !== 'agent')
      .concat(main.parent && main.parent.relation !== 'agent' ? [main.parent] : []))[0];
    const parent = target && byId.get(target.sessionId);
    if (!target || !parent || visited.has(parent.id)) break;
    visited.add(parent.id);
    hops.unshift({ parent, target });
    cursor = parent;
  }
  const crumbs: Crumb[] = [{ label: names.project(cursor) }];
  for (const [index, hop] of hops.entries()) {
    const { parent, target } = hop;
    const lane = parent.lanes.find(item => item.id === target.laneId);
    const row = lane?.rows.find(item => item.id === target.rowId);
    const at: RowTarget = { sessionId: parent.id, laneId: target.laneId, rowId: target.rowId };
    if (index === 0) crumbs.push({ label: names.session(parent), target: { sessionId: parent.id, laneId: '', rowId: '' } });
    crumbs.push({ label: laneLabel(parent, lane), target: { sessionId: parent.id, laneId: target.laneId, rowId: '' } });
    crumbs.push({ label: safeText(row?.label, 60) ?? 'Spawn', target: at });
    const next = hops[index + 1]?.parent ?? session;
    if (next !== session) crumbs.push({ label: names.session(next), target: { sessionId: next.id, laneId: '', rowId: '' } });
  }
  crumbs.push({ label: names.session(session) });
  return crumbs;
}
