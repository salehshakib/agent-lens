import { stopAgentUnavailable, stopSessionUnavailable } from '../../../shared/stop-reasons';

/**
 * Stop routes proven by docs/plan/m2-compatibility.md or live evidence for Claude Code 2.1.330.
 * Only the `interrupt` control request is verified (interrupt_receipt_v1). Task-stop and session-stop
 * subtypes have no evidence, so they stay disabled with a reason instead of being guessed.
 */
export const verifiedStopRoutes = { turn: true, agent: false, session: false } as const;

export const unavailableReasons = { agent: stopAgentUnavailable, session: stopSessionUnavailable } as const;
