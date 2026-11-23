import type { Provider } from '../adapters/types';

/** Key that scopes sessions and account rows. Sessions without a profile use an empty profile id. */
export function profileKey(provider: Provider, profile?: string): string {
  return provider + ':' + (profile ?? '');
}

/** Show a path with the user home folder as `~`, so the panel does not print the user name. */
export function shortHome(path: string, userHome: string): string {
  const trimmed = (value: string) => value.replace(/[\\/]+$/, '');
  // Compare with one separator and no case, because Windows paths mix both. The text after the prefix is kept as written.
  const folded = (value: string) => value.replace(/\\/g, '/').toLowerCase();
  const home = trimmed(userHome);
  const target = trimmed(path);
  if (!home) return target;
  if (folded(target) === folded(home)) return '~';
  if (target.length > home.length && /[\\/]/.test(target.charAt(home.length)) && folded(target.slice(0, home.length)) === folded(home)) {
    return '~' + target.slice(home.length);
  }
  return target;
}
