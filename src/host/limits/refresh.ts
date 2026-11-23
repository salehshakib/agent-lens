/**
 * Explicit "Refresh limits" gate (plan section 6). The structured /usage candidate has not been verified
 * with a signed-in probe in a disposable profile, so the action stays disabled. No parser for the
 * unverified report shape exists here by design: nothing may guess at it.
 */
export interface RefreshGate {
  enabled: boolean;
  reason: string;
}

export interface Verification {
  /** Set only after the documented single-command probe has been verified by a person in a disposable profile. */
  usageReportVerified: boolean;
}

export const unverified: Verification = { usageReportVerified: false };

export function refreshGate(verification: Verification = unverified): RefreshGate {
  if (!verification.usageReportVerified) {
    return {
      enabled: false,
      reason: 'Refresh limits is waiting for a verified signed-in probe of the Claude /usage report. '
        + 'Use the status-line relay or the official /usage command in Claude Code for now.',
    };
  }
  return { enabled: true, reason: 'Refresh the Claude limits for this profile.' };
}
