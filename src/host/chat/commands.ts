import { maxChatDraft, maxSearch } from '../../shared/protocol';
import type { SlashOption } from '../../shared/protocol';
import { canCheckFast, chatSettingReason, isVerifiedClaudeChat, normalizeEffortChoice, normalizeModelChoice } from '../adapters/claude-code/chat-settings';
import { minimumClaudeCodeVersion, supportsClaudeCodeVersion } from '../adapters/claude-code/version';
import { identifier } from '../privacy/projection';
import type { ChatCapabilities } from './types';

type LocalOption = Omit<SlashOption, 'name' | 'route'>;

const catalog = {
  usage: { description: 'Show scoped tokens and limit windows' },
  context: { description: 'Show measured context and its source' },
  agents: { description: 'Inspect the agents and linked runs' },
  files: { description: 'Find recorded file activity', arguments: '[path filter]' },
  diff: { description: 'Inspect recorded changes', arguments: '[path filter]' },
  tasks: { description: 'Inspect to-dos and background work', arguments: '[background]' },
  status: { description: 'Show conversation scope, ownership and limits' },
  help: { description: 'Show commands and availability', arguments: '[name]' },
  clear: { description: 'Open a fresh conversation tab' },
  resume: { description: 'Find and open a conversation', arguments: '[--all-projects] [filter]' },
  model: { description: 'Choose a model', arguments: '[default|inherit|alias-or-ID]' },
  effort: { description: 'Choose a reasoning effort', arguments: '[default|inherit|level]' },
  fast: { description: 'Check Fast mode', arguments: '[on|off]' },
  login: { description: 'Sign in with the official CLI', reason: 'In-chat sign-in is planned for the Accounts phase.' },
  logout: { description: 'Sign out of this profile', reason: 'In-chat sign-out requires the later Accounts phase and verified credential-store isolation.' },
  profile: { description: 'Find or switch account profiles', arguments: '[label filter]', reason: 'Profile switching is planned for the Accounts phase.' },
  codex: { description: 'Start or inspect a linked Codex run', arguments: '[start [prompt]|follow [filter]]' },
  stop: { description: 'Choose a turn, session or agent to stop', arguments: '[turn|session|agent]', reason: 'Scoped Stop is planned for the approvals and Stop phase. Use Interrupt in the composer for an eligible main turn.' },
} satisfies Record<string, LocalOption>;

export type LocalCommandName = keyof typeof catalog;
type LocalInput = {
  kind: 'local';
  name: LocalCommandName;
  argument: string;
  allProjects?: boolean;
  codexMode?: 'start' | 'follow';
  reason?: string;
};

export type ParsedChatInput =
  | { kind: 'text'; text: string }
  | { kind: 'literal'; text: string }
  | { kind: 'incomplete' | 'invalid'; reason: string; suggestions?: readonly SlashOption[]; canSendAsText?: boolean }
  | LocalInput
  | { kind: 'native'; name: string; text: string; route: 'Native' | 'Official terminal'; reason?: string };

const escapedReason = `Literal slash text requires Claude Code ${minimumClaudeCodeVersion} or newer and an initialized chat channel. The draft is still here.`;
const unsupportedNative = `This command requires Claude Code ${minimumClaudeCodeVersion} or newer and an initialized chat channel that advertises it.`;
const busyNative = 'Wait for the current turn to finish before sending a native command.';
const knownTerminalCommands = ['mcp', 'doctor', 'color', 'focus', 'reload-plugins'];
const singleLineBreak = /[\r\n\u2028\u2029]/;
const unexpectedFlag = /(?:^|\s)(?:--|-[\w])/;
const commandName = /^\/(\S*)([\s\S]*)$/;

interface TerminalHandoffState {
  trusted: boolean;
  exactSession: boolean;
  approvedProfile: boolean;
  localProject: boolean;
  owner?: boolean;
  busy?: boolean;
  writer?: 'present' | 'absent' | 'unknown';
}

/** Card preflight can omit presence I/O. Launch always needs evidence that the writer is absent. */
export function terminalHandoffReason(state: TerminalHandoffState, preflight = false): string | undefined {
  if (!state.trusted) return 'Trust this workspace before opening the official terminal.';
  if (!state.exactSession) return 'Open a confirmed conversation before resuming it in the official terminal.';
  if (!state.approvedProfile || !state.localProject) return 'The conversation needs its approved profile and trusted local project.';
  if (state.busy) return 'Wait for the current operation to finish before handing off.';
  if (state.owner) return 'Release the Agent Lens chat owner before handing off.';
  if (state.writer === 'present') return 'Another client owns this conversation.';
  if (state.writer !== 'absent' && (!preflight || state.writer !== undefined)) {
    return 'The conversation writer could not be verified as released.';
  }
  return undefined;
}

function localName(name: string): LocalCommandName | undefined {
  if (!/^[A-Za-z]+$/.test(name)) return undefined;
  const lower = name.toLowerCase();
  return Object.hasOwn(catalog, lower) ? lower as LocalCommandName : undefined;
}

/** Advertisement gives discovery. An executable version and observed semantics govern delivery separately. */
export function slashCatalog(capabilities?: ChatCapabilities, busy?: boolean): SlashOption[] {
  const verified = isVerifiedClaudeChat(capabilities);
  const local = (Object.entries(catalog) as [LocalCommandName, LocalOption][]).map(
    ([name, option]): SlashOption => ({
      name, ...option, route: 'Local',
      ...(name === 'fast' && !canCheckFast(capabilities) ? {
        reason: verified ? 'The current Fast account state has no verified diagnostic route.' : chatSettingReason.fast,
      } : {}),
    }),
  );
  const commands = new Set(capabilities?.version ? capabilities.commands.slice(0, 256).map(identifier).filter(Boolean) : []);
  const skills = new Set(capabilities?.version ? capabilities.skills.slice(0, 256).map(identifier).filter(Boolean) : []);
  const terminal = new Set([...knownTerminalCommands,
    ...(supportsClaudeCodeVersion(capabilities?.version) ? capabilities?.terminalCommands ?? [] : []).slice(0, 256).map(identifier).filter(Boolean),
  ]);
  const options = [...local];
  for (const name of new Set(['compact', ...commands, ...skills, ...terminal])) {
    if (!name || localName(name) || name.startsWith('native:')) continue;
    const terminalOnly = terminal.has(name);
    options.push({
      name,
      route: terminalOnly ? 'Official terminal' : 'Native',
      description: name === 'compact' ? 'Compact the provider context'
        : name === 'mcp' ? 'Manage provider MCP connections'
          : terminalOnly ? 'Open in the provider terminal'
            : commands.has(name) ? 'Provider command' : 'Provider skill',
      reason: terminalOnly ? undefined
        : !verified || (!commands.has(name) && !skills.has(name)) ? unsupportedNative : busy ? busyNative : undefined,
    });
  }
  return options;
}

function nearName(input: string, name: string): boolean {
  if (Math.abs(input.length - name.length) > 1) return false;
  let left = 0;
  let right = 0;
  while (input[left] === name[right] && left < input.length && right < name.length) {
    left++;
    right++;
  }
  if (input.length === name.length) {
    const tail = name.slice(right + 1);
    return input.slice(left + 1) === tail
      || (input[left] === name[right + 1] && input[left + 1] === name[right] && input.slice(left + 2) === name.slice(right + 2));
  }
  return input.length > name.length ? input.slice(left + 1) === name.slice(right) : input.slice(left) === name.slice(right + 1);
}

export function slashSuggestions(query: string, options: readonly SlashOption[]): SlashOption[] {
  const needle = query.replace(/^\//, '').toLowerCase();
  const exact: SlashOption[] = [];
  const prefix: SlashOption[] = [];
  const description: SlashOption[] = [];
  const nearby: SlashOption[] = [];
  for (const option of options) {
    const name = option.name.toLowerCase();
    if (name === needle) exact.push(option);
    else if (name.startsWith(needle)) prefix.push(option);
    else if (option.description.toLowerCase().includes(needle)) description.push(option);
    else if (needle.length > 1 && nearName(needle, name)) nearby.push(option);
  }
  return [...exact, ...prefix, ...description, ...nearby].slice(0, 8);
}

function filterArgument(value: string): string | undefined {
  const quoted = value.length >= 2 && value.startsWith('"') && value.endsWith('"');
  const filter = quoted ? value.slice(1, -1) : value;
  return filter.length > maxSearch || (!quoted && unexpectedFlag.test(filter)) ? undefined : filter;
}

function parseLocal(name: LocalCommandName, value: string): LocalInput | undefined {
  const option: LocalOption = catalog[name];
  const local: LocalInput = { kind: 'local', name, argument: value, ...(option.reason ? { reason: option.reason } : {}) };
  switch (name) {
    case 'files':
    case 'diff':
    case 'profile': {
      const argument = filterArgument(value);
      return argument === undefined ? undefined : { ...local, argument };
    }
    case 'resume': {
      const allProjects = /^--all-projects(?:\s|$)/.test(value);
      const argument = filterArgument(allProjects ? value.slice('--all-projects'.length).trim() : value);
      return argument === undefined ? undefined : { ...local, allProjects, argument };
    }
    case 'tasks':
      return !value || value === 'background' ? local : undefined;
    case 'stop':
      return !value || ['turn', 'session', 'agent'].includes(value) ? local : undefined;
    case 'model':
      return !value || normalizeModelChoice(value) !== undefined ? local : undefined;
    case 'effort':
      return !value || normalizeEffortChoice(value) !== undefined ? local : undefined;
    case 'fast':
      return !value || value === 'on' || value === 'off' ? local : undefined;
    case 'help': {
      const argument = value.replace(/^\//, '');
      return !value || identifier(argument) ? { ...local, argument } : undefined;
    }
    case 'codex': {
      if (!value) return local;
      const subcommand = /^(start|follow)(?:\s+([\s\S]*))?$/.exec(value);
      if (!subcommand) return undefined;
      const codexMode = subcommand[1];
      if (codexMode === 'start') return { ...local, codexMode, argument: subcommand[2] ?? '' };
      if (codexMode !== 'follow') return undefined;
      const argument = filterArgument(subcommand[2] ?? '');
      return argument === undefined ? undefined : { ...local, codexMode, argument };
    }
    default:
      return !value ? local : undefined;
  }
}

/** Parse submissions on the host. A malformed, unknown or unavailable name cannot become provider input. */
export function parseChatInput(text: string, capabilities?: ChatCapabilities, busy?: boolean): ParsedChatInput {
  if (text.length > maxChatDraft || text.includes('\0')) {
    return { kind: 'invalid', reason: 'Use a draft within the message limit and remove any null character.' };
  }
  const input = text.trimStart();
  if (!input) return { kind: 'invalid', reason: 'Enter a message.' };
  const literal = capabilities?.literalText === true && capabilities.send && supportsClaudeCodeVersion(capabilities.version);
  if (input.startsWith('\\/')) {
    return literal ? { kind: 'literal', text } : { kind: 'invalid', reason: escapedReason };
  }
  if (input.startsWith('!')) {
    return { kind: 'invalid', reason: 'Leading ! requires a verified native shell command route. This chat has no such route, and Agent Lens never runs it in a host shell. Open the official Claude Code terminal to run it.' };
  }
  if (!input.startsWith('/')) return { kind: 'text', text };

  const match = commandName.exec(input);
  const name = match?.[1] ?? '';
  const args = match?.[2] ?? '';
  const optionName = localName(name);
  if (optionName) {
    const result = !singleLineBreak.test(args) ? parseLocal(optionName, args.trim()) : undefined;
    const syntax = (catalog[optionName] as LocalOption).arguments;
    return result ?? { kind: 'invalid', reason: 'Usage: /' + optionName + (syntax ? ' ' + syntax : '') };
  }
  const options = slashCatalog(capabilities, busy);
  if (!name && !args.trim()) return { kind: 'incomplete', reason: 'Choose a command.', suggestions: options };
  const qualified = name.startsWith('native:');
  const nativeName = qualified ? name.slice('native:'.length) : name;
  const exact = options.find(option => option.route !== 'Local' && option.name === nativeName);
  if (exact) {
    const compact = exact.route === 'Native' && nativeName === 'compact';
    const reason = exact.reason ?? (compact && (args.trim() || singleLineBreak.test(args))
      ? 'Only the bare /compact command is verified for chat.' : undefined);
    return { kind: 'native', name: nativeName, text: '/' + nativeName + (compact && !reason ? '' : args),
      route: exact.route === 'Official terminal' ? 'Official terminal' : 'Native', ...(reason ? { reason } : {}) };
  }
  if (qualified && localName(nativeName) && capabilities?.version
    && (capabilities.commands.includes(nativeName) || capabilities.skills.includes(nativeName))) {
    return { kind: 'native', name: nativeName, text: '/' + nativeName + args, route: 'Native',
      reason: 'This native name overlaps an Agent Lens command and has no verified separate route.' };
  }
  const suggestions = slashSuggestions(name, options);
  if (!args.trim() && !singleLineBreak.test(args) &&
    options.some(option => option.route === 'Local' ? option.name.startsWith(name.toLowerCase()) : option.name.startsWith(name))) {
    return { kind: 'incomplete', reason: 'Choose a matching command or finish typing its name.', suggestions };
  }
  return { kind: 'invalid', reason: 'Unknown command.', suggestions, ...(literal ? { canSendAsText: true } : {}) };
}
