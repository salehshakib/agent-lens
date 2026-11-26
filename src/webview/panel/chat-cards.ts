import { formatAge, formatDuration, formatReset, formatTokens } from '../../shared/format';
import type { AgentDelegation, CardLink, ChatCard, ChatCardAction, GaugeView, PanelRequest, TokenRow, UsageView } from '../../shared/protocol';
import { badge, button, clean, el, gaugeBlock, visuallyHidden } from '../dom';

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

export function renderDiff(hunks: NonNullable<ChatCard['diff']>, key?: string): HTMLElement {
  return el('div', { cls: 'chat-card-diff', attrs: { role: 'region', tabindex: 0,
    'aria-label': 'Recorded diff preview', 'data-key': key } },
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

export function renderLinks(links: readonly CardLink[] | undefined, post: Post,
  openTab?: (tab: 'map' | 'files') => void, keyPrefix?: string): HTMLElement | undefined {
  if (!links?.length) return undefined;
  return el('div', { cls: 'chat-card-actions' }, ...links.map((link, index) => {
    if (!link.request && !link.tab) {
      return el('span', { cls: 'muted', text: link.label + ' unavailable: ' + (link.reason ?? 'not recorded') + '.' });
    }
    return button(link.label, () => {
      if (link.request) post(link.request);
      else if (link.tab) openTab?.(link.tab);
    }, { attrs: { 'data-key': keyPrefix ? keyPrefix + ':' + index : undefined } });
  }));
}

export function renderChatCard(card: ChatCard, post: Post, tabOpener?: (tab: 'map' | 'files') => void): HTMLElement {
  if (!card.folded) return renderCardBody(card, post, tabOpener);
  const block = el('details', { cls: 'chat-card-fold' }, el('summary', { text: card.title }),
    renderCardBody({ ...card, title: '' }, post, tabOpener));
  return block;
}

function renderCardBody(card: ChatCard, post: Post, openTab?: (tab: 'map' | 'files') => void): HTMLElement {
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
      renderActions(entry.actions, post, entry.title), renderLinks(entry.links, post, openTab)))) : undefined,
    card.diff?.length ? renderDiff(card.diff) : undefined);
}

export class AgentDelegationBlock {
  private readonly name = el('strong', { cls: 'agent-delegation-name' });
  private readonly provider = el('span', { cls: 'agent-delegation-provider muted' });
  private readonly status = badge('', 'neutral');
  private readonly elapsed = el('span', { cls: 'agent-delegation-elapsed muted' });
  private readonly recent = el('span', { cls: 'agent-delegation-recent muted' });
  private readonly chevron = el('span', { cls: 'agent-delegation-chevron', text: '›', attrs: { 'aria-hidden': true } });
  private readonly reason = el('p', { cls: 'agent-delegation-reason muted' });
  private readonly actions = el('details', { cls: 'agent-delegation-actions' }, el('summary', { text: 'Delegation actions' }));
  readonly primary = button('', () => {
    if (this.agent?.ref) this.enter(this.agent.ref, this.agent.id);
  }, { cls: 'agent-delegation-primary' });
  readonly element = el('div', { cls: 'agent-delegation' }, this.primary, this.reason, this.actions);
  private agent?: AgentDelegation;
  private linkSignature?: string;

  constructor(private readonly enter: (ref: string, id: string) => void, private readonly post: Post,
    private readonly openTab?: (tab: 'map' | 'files') => void) {
    this.primary.replaceChildren(el('span', { cls: 'agent-delegation-facts' }, this.name, this.provider,
      this.status, this.elapsed, this.recent), this.chevron);
  }

  update(agent: AgentDelegation): void {
    this.agent = agent;
    this.primary.dataset.key = 'agent:' + agent.id;
    this.primary.dataset.agent = agent.id;
    this.primary.setAttribute('aria-disabled', String(!agent.ref));
    if (agent.ref) this.primary.setAttribute('aria-haspopup', 'dialog');
    else this.primary.removeAttribute('aria-haspopup');
    for (const [node, value] of [
      [this.name, agent.label], [this.provider, agent.provider], [this.status, agent.status],
      [this.elapsed, agent.elapsedMs === undefined ? '' : formatDuration(agent.elapsedMs)], [this.recent, agent.recent ?? ''],
      [this.reason, agent.reason ?? ''],
    ] as const) {
      if (node.textContent !== clean(value)) node.textContent = clean(value);
      node.hidden = !value;
    }
    this.reason.id = 'agent-reason-' + agent.id;
    if (agent.reason) this.primary.setAttribute('aria-describedby', this.reason.id);
    else this.primary.removeAttribute('aria-describedby');
    this.status.className = 'badge tone-' + agent.tone;
    this.chevron.hidden = !agent.ref;

    const signature = JSON.stringify(agent.links ?? []);
    if (signature === this.linkSignature) return;
    this.linkSignature = signature;
    this.actions.dataset.fold = 'agent-actions:' + agent.id;
    const summary = this.actions.firstElementChild as HTMLElement;
    summary.dataset.key = this.actions.dataset.fold;
    const focus = this.actions.contains(document.activeElement) && document.activeElement instanceof HTMLElement
      ? document.activeElement.dataset.key : undefined;
    const links = renderLinks(agent.links, this.post, this.openTab, this.actions.dataset.fold);
    if (this.actions.lastElementChild !== summary) this.actions.lastElementChild?.remove();
    if (links) this.actions.append(links);
    this.actions.hidden = !links;
    if (focus) {
      const target = [...this.actions.querySelectorAll<HTMLElement>('[data-key]')].find(node => node.dataset.key === focus);
      (links ? target ?? summary : this.primary).focus({ preventScroll: true });
    }
  }
}
