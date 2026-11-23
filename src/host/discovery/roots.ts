import { join } from 'node:path';
import type { Adapter, Profile } from '../adapters/types';
import { identifier, record, safeText } from '../privacy/projection';
import { localPath, pathKey, within } from './local-path';

export interface ApprovedRoot {
  key: string;
  adapter: Adapter;
  boundary: string;
  history: string;
  profile?: Profile;
}

export interface RootConfiguration {
  roots: ApprovedRoot[];
  disabled: boolean;
  rejected: number;
}

export function configureRoots(
  adapters: readonly Adapter[],
  settings: unknown,
  userHome: string,
  env: Readonly<Record<string, string | undefined>>,
): Map<Adapter['id'], RootConfiguration> {
  const config = record(settings);
  const result = new Map<Adapter['id'], RootConfiguration>();
  const claimed: string[] = [];
  for (const adapter of adapters) {
    const configured = record(config?.[adapter.id]);
    const entry: RootConfiguration = { roots: [], disabled: configured?.enabled === false, rejected: 0 };
    result.set(adapter.id, entry);
    if (entry.disabled) continue;
    const profileIds = new Set<string>();
    function add(value: unknown, profile?: Pick<Profile, 'id' | 'label'>): void {
      const boundary = localPath(value);
      if (!boundary || claimed.some(path => within(path, boundary) || within(boundary, path))
          || (profile && profileIds.has(profile.id))) {
        entry.rejected++;
        return;
      }
      claimed.push(boundary);
      if (profile) profileIds.add(profile.id);
      entry.roots.push({
        key: JSON.stringify([adapter.id, pathKey(boundary)]),
        adapter,
        boundary,
        history: profile ? join(boundary, adapter.historyDirectory) : boundary,
        profile: profile && { ...profile, provider: adapter.id, home: boundary },
      });
    }
    add(env[adapter.homeOverride] || join(userHome, adapter.defaultHome), { id: 'default', label: 'Default' });
    if (Array.isArray(configured?.profiles)) {
      for (const item of configured.profiles) {
        const profile = record(item);
        const id = identifier(profile?.id);
        const label = safeText(profile?.label, 80);
        if (!id || !label) entry.rejected++;
        else add(profile?.home, { id, label });
      }
    } else if (configured?.profiles !== undefined) {
      entry.rejected++;
    }
    if (configured?.logRoot !== undefined) add(configured.logRoot);
  }
  return result;
}
