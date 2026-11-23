/** Refresh needs Claude Code on PATH and at least one Claude profile. */
export interface RefreshGate {
  enabled: boolean;
  reason: string;
}

export interface RefreshState {
  claudeFound: boolean;
  profiles: number;
  running: boolean;
  /** Last failure message, shown until the next successful refresh. */
  error?: string;
}

export function refreshGate(state: RefreshState): RefreshGate {
  if (state.profiles === 0) return { enabled: false, reason: 'No Claude profile is configured.' };
  if (state.running) return { enabled: false, reason: 'Refreshing Claude limits…' };
  if (!state.claudeFound) return { enabled: false, reason: 'Claude Code was not found on PATH, so limits cannot be refreshed.' };
  if (state.error) return { enabled: true, reason: 'Last refresh failed: ' + state.error };
  return { enabled: true, reason: 'Reads the current 5-hour and weekly limits using Claude Code’s /usage command.' };
}
