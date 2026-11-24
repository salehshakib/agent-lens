import { formatAge, formatPercent, formatTokens } from '../../shared/format';
import type { ChatStatus, ChatStatusItem, ChatView, GaugeView } from '../../shared/protocol';
import type { ChatContextEvidence } from './chat-cards';

const stateText: Record<ChatView['state'], string> = {
  draft: 'Idle', 'view-only': 'Read only', starting: 'Starting', idle: 'Idle', working: 'Working',
  interrupting: 'Interrupting', blocked: 'Waiting',
};
const modeText: Record<string, string> = {
  default: 'Ask before edits', acceptEdits: 'Accept edits', plan: 'Plan', auto: 'Auto', bypassPermissions: 'Bypass permissions',
};

export interface ChatStatusInput {
  chat: ChatView;
  gauges: readonly GaugeView[];
  context?: ChatContextEvidence;
  /** Tokens recorded for this conversation's scope, when the scope is known. */
  tokens?: number;
  tokensScope?: string;
  now: number;
}

const unknown = (id: ChatStatusItem['id'], label: string, reason: string): ChatStatusItem =>
  ({ id, label, value: 'Unknown', known: false, detail: reason });

/** Project the chat status line. Every value keeps its source, and an unreported value reads Unknown. */
export function projectChatStatus(input: ChatStatusInput): ChatStatus {
  const { chat, now } = input;
  const live = chat.live;
  const items: ChatStatusItem[] = [{ id: 'state', label: 'State', value: stateText[chat.state], known: true }];
  items.push(chat.profile
    ? { id: 'profile', label: 'Profile', value: chat.profile, known: true }
    : unknown('profile', 'Profile', 'No profile is selected.'));
  if (chat.state === 'working' && live?.turnStartedAt !== undefined && live.turnStartedAt <= now) {
    items.push({ id: 'elapsed', label: 'Elapsed', value: '', known: true, since: live.turnStartedAt });
  }
  items.push(live?.model
    ? { id: 'model', label: 'Model', value: live.model + (live.fastMode === 'on' ? ' · Fast' : ''), known: true,
      detail: 'Reported by Claude Code. Effort is not reported by the CLI.' }
    : unknown('model', 'Model', 'Claude Code has not reported a model for this chat.'));
  items.push(live?.permissionMode
    ? { id: 'mode', label: 'Mode', value: modeText[live.permissionMode] ?? live.permissionMode, known: true,
      detail: 'Permission mode reported by Claude Code at start.' }
    : unknown('mode', 'Mode', 'Claude Code has not reported a permission mode.'));
  const context = input.context;
  if (context && (context.percent !== undefined || context.input !== undefined)) {
    const fill = context.percent !== undefined ? formatPercent(context.percent) + ' used'
      : formatTokens(context.input) + ' tokens';
    items.push({ id: 'context', label: 'Context', value: (context.approximate ? '~' : '') + fill
      + (context.capacity !== undefined ? ' of ' + formatTokens(context.capacity) : ''), known: true,
      detail: context.source + (context.at !== undefined ? ' · ' + formatAge(context.at, now) : '') });
  } else items.push(unknown('context', 'Context', 'No context measurement is recorded for this chat.'));
  items.push(input.tokens !== undefined
    ? { id: 'tokens', label: 'Tokens', value: formatTokens(input.tokens), known: true,
      detail: input.tokensScope ?? 'Recorded for this conversation.' }
    : unknown('tokens', 'Tokens', 'No token usage is recorded for this conversation yet.'));
  const windows = input.gauges.filter(gauge => gauge.state !== 'No data');
  if (windows.length) {
    items.push({ id: 'limit', label: 'Limits', known: true,
      value: windows.map(gauge => gauge.label + ' ' + (gauge.percent === undefined ? '?' : formatPercent(gauge.percent))
        + (gauge.state === 'Fresh' ? '' : ' (' + gauge.state.toLowerCase() + ')')).join(' · '),
      detail: windows.map(gauge => gauge.label + ': ' + (gauge.source ?? 'source unknown')
        + (gauge.observedAt !== undefined ? ', ' + formatAge(gauge.observedAt, now) : '')).join('. ') });
  } else items.push(unknown('limit', 'Limits', input.gauges[0]?.reason ?? 'No limit window is available for this profile.'));
  if (live && live.pending > 0) {
    items.push({ id: 'pending', label: 'Pending', value: String(live.pending), known: true,
      detail: 'Messages waiting for delivery confirmation.' });
  }
  return { items, interruptHint: chat.canInterrupt };
}
