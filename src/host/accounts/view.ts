import type { Provider } from '../adapters/types';
import type { Session, TokenCounts } from '../sessions/types';
import type { UsageTotal } from '../usage/ledger';
import { providerLabels } from '../views/models';
import type { AccountProfileView, AccountsView, FilterOption } from '../../shared/protocol';
import { profileKey, shortHome } from './profiles';
import { accountStatus } from './status';
import type { AccountStatus } from './status';

export interface AccountProfile {
  provider: Provider;
  id: string;
  label: string;
  home: string;
}

export interface AccountsInput {
  profiles: readonly AccountProfile[];
  sessions: readonly Session[];
  totals: readonly UsageTotal[];
  userHome: string;
  /** Results from verified probes by profile key. Empty in M1, so every profile is Unknown. */
  statuses?: ReadonlyMap<string, AccountStatus>;
}

const providerOrder: readonly Provider[] = ['claude-code', 'codex'];

function tokensOf(counts: TokenCounts): number {
  if (counts.total !== undefined) return counts.total;
  return [counts.input, counts.cacheRead, counts.cacheWrite, counts.output]
    .reduce<number>((sum, value) => sum + (value ?? 0), 0);
}

/**
 * Profile scopes and read-only account status. Counts come from the sessions each profile's home
 * produced. A session never inherits the selected profile, and one without a recorded profile stays
 * unassigned.
 */
export function buildAccounts(input: AccountsInput): AccountsView {
  const counts = new Map<string, { sessions: number; live: number }>();
  for (const session of input.sessions) {
    const key = profileKey(session.provider, session.profile);
    const entry = counts.get(key) ?? { sessions: 0, live: 0 };
    counts.set(key, entry);
    entry.sessions++;
    if (session.status === 'Live') entry.live++;
  }
  const tokens = new Map<string, number>();
  for (const row of input.totals) {
    const key = profileKey(row.provider, row.profile);
    tokens.set(key, (tokens.get(key) ?? 0) + tokensOf(row.counts));
  }
  const ordered = [...input.profiles].sort((a, b) =>
    providerOrder.indexOf(a.provider) - providerOrder.indexOf(b.provider)
    || Number(b.id === 'default') - Number(a.id === 'default') || a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
  const profiles: AccountProfileView[] = ordered.map(profile => {
    const key = profileKey(profile.provider, profile.id);
    const status = accountStatus(profile.provider, input.statuses?.get(key));
    const own = counts.get(key);
    return {
      key, provider: providerLabels[profile.provider], label: profile.label,
      role: profile.id === 'default' ? 'Default' : 'Saved',
      // Switching saved profiles arrives with chat. Until then the default home is the one the official CLIs use.
      active: profile.id === 'default',
      home: shortHome(profile.home, input.userHome),
      state: status.state, reason: status.reason, mode: status.mode, checkedAt: status.checkedAt,
      sessions: own?.sessions ?? 0, live: own?.live ?? 0, tokens: tokens.get(key),
    };
  });
  const unassigned = providerOrder.map(provider => ({
    provider: providerLabels[provider], sessions: counts.get(profileKey(provider))?.sessions ?? 0,
  })).filter(item => item.sessions > 0);
  return { profiles, unassigned };
}

/** Profile filter options: every configured profile, plus an Unassigned entry where such sessions exist. */
export function profileOptions(profiles: readonly AccountProfile[], sessions: readonly Session[]): FilterOption[] {
  const options: FilterOption[] = profiles
    .map(profile => ({ id: profileKey(profile.provider, profile.id), label: providerLabels[profile.provider] + ' · ' + profile.label,
      order: providerOrder.indexOf(profile.provider), first: profile.id === 'default' }))
    .sort((a, b) => a.order - b.order || Number(b.first) - Number(a.first) || a.label.localeCompare(b.label))
    .map(({ id, label }) => ({ id, label }));
  for (const provider of providerOrder) {
    if (sessions.some(session => session.provider === provider && session.profile === undefined)) {
      options.push({ id: profileKey(provider), label: providerLabels[provider] + ' · Unassigned' });
    }
  }
  return options;
}
