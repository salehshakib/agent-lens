import type { ChatCard, ChatCardAction, ChatCardEntry, SessionDetail } from '../../../shared/protocol';
import type { ChatCapabilities, ChatSettings } from '../../chat/types';
import { safeText } from '../../privacy/projection';
import { minimumClaudeCodeVersion, supportsClaudeCodeVersion } from './version';

export type ChatSettingCommand = 'model' | 'effort' | 'fast';

export const claudeEffortLevels = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
const modelAliases = ['sonnet', 'opus', 'haiku', 'fable'] as const;
export const maxModelChoice = 160;
const modelChoice = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,159}$/;

export const chatSettingReason: Record<ChatSettingCommand, string> = {
  model: `Live model control requires Claude Code ${minimumClaudeCodeVersion} or newer and an initialized chat.`,
  effort: `Live effort changes require Claude Code ${minimumClaudeCodeVersion} or newer and an initialized chat that reports per-turn effort support.`,
  fast: `Checking Fast requires Claude Code ${minimumClaudeCodeVersion} or newer and an initialized chat.`,
};

export function normalizeModelChoice(value: string): string | undefined {
  if (value === 'inherit' || value === 'default') return 'default';
  return modelChoice.test(value) && safeText(value) === value ? value : undefined;
}

export function normalizeEffortChoice(value: string): string | undefined {
  if (value === 'inherit' || value === 'default') return 'default';
  return claudeEffortLevels.find(level => level === value);
}

export function isVerifiedClaudeChat(capabilities?: ChatCapabilities): boolean {
  return capabilities?.nativeCommands === true && capabilities.send && supportsClaudeCodeVersion(capabilities.version);
}

/** The observed Fast command only diagnosed an account where switching Fast was disabled. */
export function canCheckFast(capabilities?: ChatCapabilities): boolean {
  return isVerifiedClaudeChat(capabilities)
    && capabilities?.fastMode === 'off' && capabilities.fastDisabledReason === 'extra_usage_disabled';
}

interface SettingsCardOptions {
  requested?: ChatSettings;
  resolvedModel?: string;
  capabilities?: ChatCapabilities;
  busy?: boolean;
  canStage?: boolean;
  pending?: boolean;
  status?: string;
  action?: (value: string, label: string, input?: ChatCardAction['input']) => ChatCardAction;
}

function fastDisabledReason(value: string | undefined): string | undefined {
  if (value === 'extra_usage_disabled') return 'Extra usage is disabled for this profile.';
  const reason = safeText(value, 100);
  return reason ? 'Fast is disabled by the provider (' + reason + ').' : undefined;
}

/** Requested values come from local choices. Only the provider stream establishes the reported model or speed. */
export function claudeChatSettings(
  kind: ChatSettingCommand, scope: string, argument: string,
  actual: Pick<SessionDetail, 'model' | 'effort'> | undefined,
  options: SettingsCardOptions = {},
): ChatCard {
  const titles: Record<ChatSettingCommand, string> = { model: 'Model', effort: 'Effort', fast: 'Fast' };
  const { capabilities, requested, action, busy, pending } = options;
  const selected = safeText(argument, maxModelChoice);
  const live = isVerifiedClaudeChat(capabilities);
  const busyReason = busy ? 'Wait for the current operation to finish.' : undefined;
  const status = safeText(options.status, 500);
  if (kind === 'fast') {
    const mode = capabilities?.fastMode;
    const disabled = fastDisabledReason(capabilities?.fastDisabledReason);
    const toggle = selected ? 'The CLI has supplied a diagnostic response. Changing Fast on or off is unverified.' : undefined;
    const available = canCheckFast(capabilities);
    const reason = busyReason ?? (!live ? chatSettingReason.fast
      : !available ? 'A Fast diagnostic without changing this setting is unverified for the current account state.' : undefined);
    const entries: ChatCardEntry[] = [
      { title: 'Reported', detail: mode === 'off' ? 'Off' : mode === 'on' ? 'On' : 'Unknown' },
      ...(selected ? [{ title: 'Selected', detail: selected === 'on' ? 'On' : 'Off' }] : []),
    ];
    return {
      title: 'Fast', scope, entries,
      state: pending ? 'loading' : disabled || toggle || reason ? 'unavailable' : 'ready',
      message: [status, disabled, toggle, pending ? 'Waiting for the provider response.' : reason].filter(Boolean).join(' ') || undefined,
      actions: available && !busy && !pending && !selected && action ? [action('', 'Check Fast')] : undefined,
    };
  }

  const canChange = live && (kind === 'model' || capabilities?.effortActive === true);
  const canStage = options.canStage && !capabilities?.send;
  const allowed = !busy && !pending && (canChange || canStage);
  const selectedValue = kind === 'model' ? normalizeModelChoice(argument) : normalizeEffortChoice(argument);
  const effective = kind === 'model' ? safeText(actual?.model, maxModelChoice) : undefined;
  const resolved = options.resolvedModel ? normalizeModelChoice(options.resolvedModel) : undefined;
  const choices: string[] = kind === 'model'
    ? [...new Set<string>([...modelAliases, ...[effective, resolved].filter((value): value is string =>
      Boolean(value && normalizeModelChoice(value) && value !== 'default'))])]
    : [...claudeEffortLevels];
  const entries: ChatCardEntry[] = [
    { title: 'Requested', detail: safeText(requested?.[kind], maxModelChoice) ?? 'Default · Inherit provider settings' },
    { title: 'Reported', detail: kind === 'model' ? effective ?? 'Unknown' : 'Unavailable in the chat stream' },
    { title: 'Default', detail: canStage ? 'Inherit the provider setting on the next start or resume.'
      : 'Available on the next start or resume. The live control needs an explicit value.',
      actions: canStage && allowed && action ? [action('default', 'Use default')] : undefined },
  ];
  if (selectedValue && selectedValue !== 'default' && !choices.includes(selectedValue)) choices.unshift(selectedValue);
  for (const value of choices) {
    entries.push({
      title: value,
      detail: value === selectedValue ? 'Selected'
        : kind === 'effort' ? 'CLI effort level'
          : value === effective ? 'Reported by this conversation'
            : value === resolved ? 'Resolved by the CLI' : 'CLI alias · availability is checked by the provider',
      actions: allowed && action ? [action(value, value === selectedValue ? 'Apply' : 'Use ' + value)] : undefined,
    });
  }
  if (kind === 'model' && allowed && action) {
    entries.push({ title: 'Custom model', actions: [action(':custom', 'Apply model', {
      label: 'Alias or model ID', maxLength: maxModelChoice, value: selectedValue && selectedValue !== 'default' ? selectedValue : undefined,
    })] });
  }
  const reason = pending ? 'Waiting for the provider response.' : busyReason
    ?? (!allowed ? chatSettingReason[kind] : canStage ? 'The selection applies on the next start or exact resume.' : undefined);
  return {
    title: titles[kind], scope, entries,
    state: pending ? 'loading' : allowed ? 'ready' : 'unavailable',
    message: [status, reason].filter(Boolean).join(' ') || undefined,
  };
}
