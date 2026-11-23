import type { Adapter, Provider } from '../adapters/types';

export interface StatusTerminal {
  name: string;
  /** Typed into the terminal without a trailing newline. The user presses Enter. */
  text: string;
  /** Home override for a saved profile. Absent for the default profile. */
  env?: Record<string, string>;
}

/** Official read-only status commands from §12. Constant text, nothing from settings or providers. */
const commands: Record<Provider, string> = {
  'claude-code': 'claude auth status --text',
  codex: 'codex login status',
};

/**
 * The terminal that lets the user run the official status command for one profile. The default
 * profile inherits the environment unchanged, because Claude keeps its global state in a different
 * file when `CLAUDE_CONFIG_DIR` is set, even to the default folder. A saved profile gets its home
 * override for this terminal only, never globally.
 */
export function statusTerminal(
  adapter: Pick<Adapter, 'id' | 'label' | 'homeOverride'>,
  profile: { id: string; label: string; home: string },
): StatusTerminal {
  return {
    name: 'Agent Lens: ' + adapter.label + ' status (' + profile.label.slice(0, 40) + ')',
    text: commands[adapter.id],
    env: profile.id === 'default' ? undefined : { [adapter.homeOverride]: profile.home },
  };
}
