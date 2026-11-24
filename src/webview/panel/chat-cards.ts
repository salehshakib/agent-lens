import { formatAge, formatReset, formatTokens } from '../../shared/format';
import type { CardLink, ChatCard, ChatCardAction, GaugeView, PanelRequest, TokenRow, UsageView } from '../../shared/protocol';
import { button, clean, el, gaugeBlock, visuallyHidden } from '../dom';

type Post = (request: PanelRequest) => void;

function renderAction(action: ChatCardAction, post: Post, entry?: string): HTMLElement {
  const { id, label, input } = action;
  const accessibleLabel = entry ? label + ' · ' + clean(entry) : label;
  if (!input) {
    return button(label, () => post({ type: 'chatCardAction', id }), {
      attrs: { 'aria-label': accessibleLabel, 'data-key': id },
    });
  }
  const props = { attrs: { maxlength: input.maxLength, 'data-key': id + '-input' } };
  const editor = input.multiline ? el('textarea', props) : el('input', props);
  editor.defaultValue = clean(input.value);
  const form = el('form', { cls: 'chat-card-action' },
    el('label', {}, input.label, editor),
    el('button', { attrs: { type: 'submit', 'aria-label': accessibleLabel, 'data-key': id }, text: label }));
  form.addEventListener('submit', event => {
    event.preventDefault();
    post({ type: 'chatCardAction', id, input: editor.value });
  });
  return form;
}

function renderActions(actions: readonly ChatCardAction[] | undefined, post: Post, entry?: string): HTMLElement | undefined {
  if (!actions?.length) return undefined;
  return el('div', { cls: 'chat-card-actions' }, ...actions.map(action => renderAction(action, post, entry)));
}

function renderGauge(gauge: GaugeView, now: number): HTMLElement {
  const reset = formatReset(gauge.resetsAt, now);
  const age = formatAge(gauge.observedAt, now);
  return el('div', {},
    gaugeBlock(gauge, reset ? 'Resets ' + reset : ''),
    reset && gauge.reason ? el('p', { cls: 'chat-card-detail', text: gauge.reason }) : undefined,
    age || gauge.source ? el('p', { cls: 'chat-card-detail',
      text: [gauge.source, age ? 'Observed ' + age : undefined].filter(Boolean).join(' · ') }) : undefined);
}

const tokenColumns: readonly [keyof Omit<TokenRow, 'label'>, string][] = [
  ['input', 'Input'],
  ['cacheRead', 'Cache read'],
  ['cacheWrite', 'Cache write'],
  ['output', 'Output'],
  ['reasoning', 'Reasoning'],
  ['total', 'Total'],
];

function renderUsage(usage: UsageView): HTMLElement {
  const rows = usage.tokens;
  return el('section', { cls: 'chat-card-usage', attrs: { 'aria-label': 'Recorded tokens' } },
    rows.length ? el('div', { cls: 'chat-card-token-table' }, el('table', {},
      el('caption', { text: 'Tokens by agent' }),
      el('thead', {}, el('tr', {},
        el('th', { attrs: { scope: 'col' }, text: 'Agent' }),
        ...tokenColumns.map(([, label]) => el('th', { attrs: { scope: 'col' }, text: label })))),
      el('tbody', {}, ...rows.map(row => el('tr', {},
        el('th', { attrs: { scope: 'row' }, text: row.label }),
        ...tokenColumns.map(([key]) => el('td', { cls: 'num', text: formatTokens(row[key]) })))))))
      : el('p', { cls: 'chat-card-detail', text: 'No token counts recorded for this session.' }),
    el('p', { cls: 'chat-card-detail' }, usage.scope,
      usage.partial ? ' Some usage evidence is partial, so totals may be incomplete.' : undefined));
}

function renderDiff(hunks: NonNullable<ChatCard['diff']>): HTMLElement {
  return el('div', { cls: 'chat-card-diff', attrs: { role: 'region', tabindex: 0, 'aria-label': 'Recorded diff preview' } },
    ...hunks.map(hunk => el('section', {},
      el('p', { cls: 'chat-card-diff-heading', text: hunk.heading }),
      el('pre', {}, ...hunk.lines.map(line => {
        const kind = line.before === undefined ? 'added' : line.after === undefined ? 'removed' : 'context';
        const sign = kind === 'added' ? '+' : kind === 'removed' ? '−' : ' ';
        return el('span', { cls: 'chat-card-diff-line', attrs: { 'data-kind': kind } },
          el('span', { cls: 'chat-card-diff-number', attrs: { 'aria-hidden': 'true' }, text: line.before?.toString() ?? ' ' }),
          el('span', { cls: 'chat-card-diff-number', attrs: { 'aria-hidden': 'true' }, text: line.after?.toString() ?? ' ' }),
          visuallyHidden(kind === 'added' ? 'Added line ' + line.after + ': '
            : kind === 'removed' ? 'Removed line ' + line.before + ': ' : 'Line ' + line.after + ': '),
          el('span', { attrs: { 'aria-hidden': 'true' }, text: sign }),
          el('code', { text: line.text }), '\n');
      })))));
}

const stateLabels: Record<ChatCard['state'], string> = {
  loading: 'Loading…',
  ready: '',
  empty: 'No results.',
  unavailable: 'Unavailable.',
  denied: 'Action denied.',
  changed: 'The target has changed.',
};

let openTab: ((tab: 'map' | 'files') => void) | undefined;

function renderLinks(links: readonly CardLink[] | undefined, post: Post): HTMLElement | undefined {
  if (!links?.length) return undefined;
  return el('div', { cls: 'chat-card-actions' }, ...links.map(link => {
    if (!link.request && !link.tab) {
      return el('span', { cls: 'muted', text: link.label + ' unavailable: ' + (link.reason ?? 'not recorded') + '.' });
    }
    return button(link.label, () => {
      if (link.request) post(link.request);
      else if (link.tab) openTab?.(link.tab);
    });
  }));
}

export function renderChatCard(card: ChatCard, post: Post, tabOpener?: (tab: 'map' | 'files') => void): HTMLElement {
  openTab = tabOpener;
  if (!card.folded) return renderCardBody(card, post);
  const block = el('details', { cls: 'chat-card-fold' }, el('summary', { text: card.title }), renderCardBody({ ...card, title: '' }, post));
  return block;
}

function renderCardBody(card: ChatCard, post: Post): HTMLElement {
  const now = Date.now();
  const message = card.message ?? stateLabels[card.state];
  return el('section', { cls: 'chat-card', attrs: {
    'aria-label': clean(card.title), 'aria-busy': card.state === 'loading' ? 'true' : undefined, 'data-state': card.state,
  } },
    card.title ? el('h3', { cls: 'chat-card-title', text: card.title }) : undefined,
    card.scope ? el('p', { cls: 'chat-card-scope', text: card.scope }) : undefined,
    message ? el('p', { cls: 'chat-card-message', text: message }) : undefined,
    renderActions(card.actions, post),
    card.gauges?.length ? el('div', { cls: 'chat-card-gauges', attrs: { role: 'group', 'aria-label': 'Scoped limits' } },
      ...card.gauges.map(gauge => renderGauge(gauge, now))) : undefined,
    card.usage ? renderUsage(card.usage) : undefined,
    card.entries?.length ? el('ul', { cls: 'chat-card-entries' }, ...card.entries.map(entry => el('li', { cls: 'chat-card-entry' },
      el('strong', { text: entry.title }),
      entry.detail ? el('p', { cls: 'chat-card-detail', text: entry.detail }) : undefined,
      renderActions(entry.actions, post, entry.title), renderLinks(entry.links, post)))) : undefined,
    card.diff?.length ? renderDiff(card.diff) : undefined);
}
