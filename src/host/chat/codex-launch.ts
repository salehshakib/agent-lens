import type { ChatCardEntry } from '../../shared/protocol';
import { localPath } from '../discovery/local-path';
import { safeText } from '../privacy/projection';
import type { RowRef, Session } from '../sessions/types';
import { namesFor } from '../views/models';

export interface LinkedCodexRun extends ChatCardEntry {
  origin: RowRef;
  target?: RowRef;
  turn: string;
}

export const unverifiedCodexRun = 'Only Codex runs with exact startup and rollout evidence appear here. Other observed runs are available in All projects.';

/** M1 verifies observation of a launcher, independently of starting a run from this chat. */
export function codexStartReason(cwd: string | undefined, hasProfile: boolean, trusted: boolean): string {
  if (!trusted) return 'Trust the workspace to start a Codex run.';
  if (!cwd || localPath(cwd) !== cwd) return 'Choose an approved local project for the Codex run.';
  if (!hasProfile) return 'No approved Codex profile is available for this project.';
  return 'Connected Codex launch is unavailable. A scoped official launch or terminal handoff with exact startup and rollout binding has not been verified.';
}

/** Use only M1's resolved delegation links. Each launch keeps its own origin even for a reused thread. */
export function codexLinkedRuns(origin: Session | undefined, sessions: readonly Session[], filter: string, privateMode: boolean): LinkedCodexRun[] {
  if (!origin) return [];
  const names = namesFor(privateMode);
  const children = new Set(origin.children.filter(edge => edge.relation === 'launch').map(edge => edge.sessionId));
  const needle = filter.toLowerCase();
  const runs: (LinkedCodexRun & { at?: number })[] = [];
  for (const run of sessions) {
    if (run.provider !== 'codex' || !run.profile || !children.has(run.id)) continue;
    const title = names.session(run);
    const project = names.project(run);
    if (needle && ![title, project, run.status].some(value => value.toLowerCase().includes(needle))) continue;
    for (const link of run.launches ?? []) {
      if (link.parent.sessionId !== origin.id || link.sessionId !== run.id) continue;
      const lane = run.lanes.find(item => item.id === link.laneId);
      const turn = lane?.turns.find(item => item.id === link.turnId);
      const row = lane?.rows.find(item => item.turnId === link.turnId);
      const anchor = origin.lanes.find(item => item.id === link.parent.laneId)?.rows
        .find(item => item.id === link.parent.rowId);
      const detail = [project, safeText(run.profile, 80), turn?.state ?? run.status,
        ...(turn && row && anchor ? [] : ['Launch or transcript evidence is no longer available'])].filter(Boolean).join(' · ');
      runs.push({
        title, detail, at: link.parent.at,
        origin: { sessionId: origin.id, laneId: link.parent.laneId, rowId: link.parent.rowId },
        target: turn && row && anchor ? { sessionId: run.id, laneId: row.laneId, rowId: row.id } : undefined,
        turn: link.turnId,
      });
    }
  }
  return runs.sort((left, right) => (right.at ?? 0) - (left.at ?? 0)).slice(0, 50);
}
