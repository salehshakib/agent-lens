import type { Provider } from '../adapters/types';
import { timestamp } from '../privacy/projection';
import type { AccountState } from '../../shared/protocol';

/**
 * Read-only account status (§12). Only an official, verified status probe may produce Signed in,
 * Signed out or External configuration. Agent Lens keeps just the allowlisted state, mode and check
 * time. It never keeps email, plan, organization or any credential field, and it never reads
 * credential files.
 */
export interface AccountStatus {
  state: AccountState;
  reason: string;
  mode?: string;
  checkedAt?: number;
}

/**
 * Providers whose official status command has a recorded, verified output shape. The plan names
 * `claude auth status --json` and `codex login status`, but their output was never collected on a
 * disposable signed-in profile, so no probe is verified and no command is run.
 */
export const verifiedProbes: ReadonlySet<Provider> = new Set<Provider>();

const reasons: Record<Provider, string> = {
  'claude-code': 'Sign-in state is not checked. The official status command has no verified output shape yet, so Agent Lens does not run it.',
  codex: 'Sign-in state is not checked. The official status command has no verified output shape yet, so Agent Lens does not run it.',
};

const states: ReadonlySet<string> = new Set<AccountState>(['Signed in', 'Signed out', 'External configuration', 'Unknown']);

export function unknownStatus(provider: Provider, reason?: string): AccountStatus {
  return { state: 'Unknown', reason: reason ?? reasons[provider] };
}

/**
 * Validate a result handed over by a verified probe. Anything that is not a plain object with a
 * known state becomes Unknown, and every other field is dropped.
 */
export function accountStatus(
  provider: Provider,
  result: unknown,
  verified: ReadonlySet<Provider> = verifiedProbes,
): AccountStatus {
  if (!verified.has(provider)) return unknownStatus(provider);
  if (typeof result !== 'object' || result === null || Array.isArray(result)) {
    return unknownStatus(provider, 'The status probe returned an unrecognized result.');
  }
  const value = result as { state?: unknown; mode?: unknown; checkedAt?: unknown };
  if (typeof value.state !== 'string' || !states.has(value.state)) {
    return unknownStatus(provider, 'The status probe returned an unrecognized result.');
  }
  const state = value.state as AccountState;
  // A mode is a short label such as Subscription or API key. Anything with other characters, for
  // example an address, is dropped.
  const mode = typeof value.mode === 'string' && /^[A-Za-z][A-Za-z0-9 ./-]{0,39}$/.test(value.mode) ? value.mode : undefined;
  const checkedAt = timestamp(value.checkedAt);
  if (state === 'Unknown') return { state, reason: reasons[provider], checkedAt };
  return {
    state, mode, checkedAt,
    reason: state === 'External configuration'
      ? 'Authentication comes from outside this profile, so profile-scoped actions stay unavailable.'
      : 'Reported by the official status command.',
  };
}
