/** One lane that currently has a High or Critical context level. */
export interface ContextCandidate {
  sessionId: string;
  laneId: string;
  /** Display text for the notification, already privacy-safe. */
  title: string;
  level: 'High' | 'Critical';
  percent?: number;
  approximate: boolean;
  /** When the sample was observed. Without a time the sample cannot be shown to be current. */
  at?: number;
  /** Number of compactions in the lane so far. A compaction starts a new epoch. */
  epoch: number;
}

/**
 * Decides which optional context alerts to show. An alert fires once per session, lane, level and compaction epoch.
 * A lane that jumps straight past both thresholds gets one Critical alert, never a High one as well. Samples observed
 * before the tracker started are historical and never alert.
 */
export class ContextAlerts {
  private readonly fired = new Set<string>();

  constructor(private since: number) {}

  /** Treat everything observed before this time as historical, for example when alerts are switched on. */
  reset(since: number): void {
    this.since = since;
  }

  next(candidates: readonly ContextCandidate[]): ContextCandidate[] {
    const alerts: ContextCandidate[] = [];
    const id = (candidate: ContextCandidate, level: string) =>
      [candidate.sessionId, candidate.laneId, level, candidate.epoch].join('|');
    for (const candidate of candidates) {
      if (candidate.at === undefined || candidate.at < this.since) continue;
      const own = id(candidate, candidate.level);
      if (this.fired.has(own)) continue;
      this.fired.add(own);
      // A Critical alert covers High for the same epoch.
      if (candidate.level === 'Critical') this.fired.add(id(candidate, 'High'));
      alerts.push(candidate);
    }
    return alerts;
  }
}

export function alertText(candidate: ContextCandidate): string {
  const percent = candidate.percent === undefined ? '' : ' at ' + Math.round(candidate.percent) + '%';
  return 'Context ' + candidate.level + (candidate.approximate ? ' (approximate)' : '') + percent + ' in ' + candidate.title + '.';
}
