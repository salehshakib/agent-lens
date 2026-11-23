import { safeText } from '../privacy/projection';
import type { Lane, ModelSource, Session } from '../sessions/types';
import type { ObservedModelRow } from '../../shared/protocol';

const sourceLabels: Record<ModelSource, string> = {
  transcript: 'Transcript record',
  'turn-context': 'Turn context',
  'thread-settings': 'Thread settings',
};

export const notRecorded = 'Not recorded';

function sourceText(sources: ReadonlySet<ModelSource | undefined>): string {
  const labels = [...sources].map(source => source ? sourceLabels[source] : notRecorded);
  return [...new Set(labels)].join(', ');
}

function laneRows(lane: Lane): ObservedModelRow[] {
  const name = safeText(lane.title, 60) ?? 'Agent';
  const groups = new Map<string, { model?: string; effort?: string; turns: number; sources: Set<ModelSource | undefined> }>();
  for (const turn of lane.turns) {
    if (!turn.model && !turn.effort) continue;
    const key = (turn.model ?? '') + '\n' + (turn.effort ?? '');
    const group = groups.get(key) ?? { model: turn.model, effort: turn.effort, turns: 0, sources: new Set() };
    groups.set(key, group);
    group.turns++;
    group.sources.add(turn.modelSource);
  }
  const rows: ObservedModelRow[] = [...groups.values()].map(group => ({
    lane: name, model: safeText(group.model, 80), effort: safeText(group.effort, 40), turns: group.turns,
    source: sourceText(group.sources), current: group.model === lane.model && group.effort === lane.effort,
  }));
  // An agent with no turn-level record can still carry a lane-level model, for example from child metadata.
  if (!rows.length && (lane.model || lane.effort)) {
    return [{ lane: name, model: safeText(lane.model, 80), effort: safeText(lane.effort, 40), source: 'Agent metadata', current: true }];
  }
  if (!rows.length) return [{ lane: name, source: notRecorded, current: false }];
  // When no pair matches the lane value exactly, the last one is the most recent record.
  if (!rows.some(row => row.current)) rows[rows.length - 1]!.current = true;
  return rows;
}

/**
 * The model and reasoning effort recorded for each agent in a session, grouped by pair in the order
 * first seen. These are observed values, never the requested selection. A missing value stays
 * missing, because settings and fallbacks can decide what actually ran.
 */
export function observedModels(session: Pick<Session, 'lanes'>): ObservedModelRow[] {
  return session.lanes.flatMap(laneRows);
}
