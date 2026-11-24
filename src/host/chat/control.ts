import { verifiedStopRoutes, unavailableReasons } from '../adapters/claude-code/control';

export type StopTarget = 'turn' | 'agent' | 'session';

export interface StopInput {
  provider: string | undefined;
  /** The owned channel has a written turn in flight. */
  turnActive: boolean;
  /** The channel confirmed the interrupt capability and no interrupt is pending. */
  canInterrupt: boolean;
}

export interface StopResolution {
  target: StopTarget;
  label: string;
  available: boolean;
  /** The one action that will run. Present only when available. */
  action?: 'interrupt';
  /** Shown on the card; names exactly what the action does or why it cannot run. */
  message: string;
}

const labels: Record<StopTarget, string> = { turn: 'Interrupt turn', agent: 'Stop agent', session: 'Stop session' };

export function resolveStop(target: StopTarget, input: StopInput): StopResolution {
  const label = labels[target];
  if (target === 'turn') {
    if (input.provider !== 'claude-code' || !verifiedStopRoutes.turn) {
      return { target, label, available: false, message: 'Interrupt is verified only for Claude Code chats owned by Agent Lens.' };
    }
    if (!input.turnActive) return { target, label, available: false, message: 'No turn is running in this chat.' };
    if (!input.canInterrupt) {
      return { target, label, available: false, message: 'Interrupt is unavailable: this channel did not confirm it, or one is already pending.' };
    }
    return { target, label, available: true, action: 'interrupt',
      message: 'Interrupts the running main turn only. Sub-agents, background tasks and the session are not stopped separately.' };
  }
  return { target, label, available: verifiedStopRoutes[target], message: unavailableReasons[target] };
}

export function resolveAllStops(input: StopInput): readonly StopResolution[] {
  return (['turn', 'agent', 'session'] as const).map(target => resolveStop(target, input));
}

/** Parse the `/stop` argument. Empty means "show every target". */
export function parseStopTarget(argument: string): StopTarget | undefined | '' {
  return argument === '' ? '' : argument === 'turn' || argument === 'agent' || argument === 'session' ? argument : undefined;
}
