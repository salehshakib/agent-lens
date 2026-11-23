import type { RowView } from '../../shared/protocol';
import { formatClock, formatDuration } from '../../shared/format';
import { announce, badge, button, el, navigate, signalBadge } from '../dom';
import { goTo, peekLanding, takeLanding } from './nav';
import type { Landing } from './nav';
import type { SessionModel, Ui } from './state';
import { saveUi } from './state';

const kindGroups: Record<string, readonly string[]> = {
  conversation: ['user', 'assistant', 'final', 'system', 'compact'],
  tools: ['tool', 'result'],
  reasoning: ['reasoning'],
  agents: ['agent', 'task'],
};

const kindLabels: Record<string, string> = {
  user: 'You', assistant: 'Assistant', final: 'Final answer', reasoning: 'Reasoning', tool: 'Tool', result: 'Result',
  compact: 'Compaction', agent: 'Agent', task: 'Task', system: 'System', signal: 'End of turn',
};

const collapsedKinds = new Set(['reasoning', 'tool', 'result']);
const clampChars = 500;

let followed = true;
let lastSession: string | undefined;
let seen = new Set<string>();
let pending = 0;
let jump: HTMLButtonElement | undefined;
let attached = false;
/** Set by a toggle or filter so the next render keeps the reader's position. */
let manual = false;
/** The row an Open parent or Back jump landed on. It keeps a static outline until the reader moves on. */
let highlighted: string | undefined;
/** Shown when a jump targets a row outside the loaded window. */
let gap: string | undefined;

function nearBottom(): boolean {
  const scroller = document.scrollingElement;
  return !scroller || scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
}

function toBottom(): void {
  const scroller = document.scrollingElement;
  if (scroller) scroller.scrollTop = scroller.scrollHeight;
}

function updateJump(): void {
  if (!jump) return;
  jump.hidden = followed || (pending === 0 && nearBottom());
  jump.textContent = pending ? 'Jump to latest (' + pending + ' new)' : 'Jump to latest';
}

function attachScroll(): void {
  if (attached) return;
  attached = true;
  window.addEventListener('scroll', () => {
    followed = nearBottom();
    if (followed) pending = 0;
    updateJump();
  }, { passive: true });
}

function rowBody(row: RowView, open: boolean): HTMLElement | undefined {
  const parts: HTMLElement[] = [];
  if (row.command) {
    parts.push(el('div', { cls: 'cmd' },
      el('code', { text: row.command }),
      row.exitCode === undefined ? undefined : badge('exit ' + row.exitCode, row.exitCode === 0 ? 'ok' : 'fail'),
      row.durationMs === undefined ? undefined : el('span', { cls: 'muted', text: formatDuration(row.durationMs) })));
  }
  if (row.text) {
    const long = row.text.length > clampChars;
    parts.push(el('pre', { cls: 'text' + (long && !open ? ' clamp' : ''), text: row.text }));
    if (row.textTruncated) parts.push(el('p', { cls: 'muted', text: 'Text shortened for display.' }));
  }
  if (row.output) {
    parts.push(el('pre', { cls: 'output', text: row.output }));
    if (row.outputTruncated) parts.push(el('p', { cls: 'muted', text: 'Output shortened for display.' }));
  }
  return parts.length ? el('div', { cls: 'body' }, ...parts) : undefined;
}

/** The end-of-turn marker: the outcome label with links to the last edit and the last check. */
function markerNode(row: RowView, ui: Ui, many: boolean, rerender: () => void): HTMLElement {
  const view = row.signals?.[0];
  const { edit, check } = row.links ?? {};
  return el('li', { cls: 'trow kind-signal', attrs: { 'data-id': row.id } },
    el('div', { cls: 'thead' },
      el('time', { cls: 'muted', text: formatClock(row.at) }),
      el('span', { cls: 'kind', text: 'End of turn' }),
      view ? signalBadge(view) : el('span', { cls: 'label', text: row.label }),
      many ? el('span', { cls: 'lane', text: row.lane }) : undefined,
      edit ? button('Go to last edit', () => goTo(ui, edit, rerender), { cls: 'link', attrs: { 'data-nav': true, 'data-key': 'edit-' + row.id } }) : undefined,
      check ? button('Go to last check', () => goTo(ui, check, rerender), { cls: 'link', attrs: { 'data-nav': true, 'data-key': 'check-' + row.id } }) : undefined));
}

function rowNode(row: RowView, ui: Ui, many: boolean, rerender: () => void): HTMLElement {
  if (row.kind === 'signal') return markerNode(row, ui, many, rerender);
  const collapsible = collapsedKinds.has(row.kind);
  const open = ui.expanded.includes(row.id);
  const longText = (row.text?.length ?? 0) > clampChars;
  const hasBody = Boolean(row.command || row.text || row.output);
  const toggleable = hasBody && (collapsible || longText);
  const showBody = hasBody && (!collapsible || open);
  const summaryText = row.command ? (row.command.split('\n')[0] ?? '') : (row.file ?? '');
  const name = (kindLabels[row.kind] ?? row.kind) + ' ' + row.label;
  const toggle = toggleable ? button(open ? 'Hide' : collapsible ? 'Show details' : 'Show more', () => {
    ui.expanded = open ? ui.expanded.filter(id => id !== row.id) : [...ui.expanded, row.id].slice(-200);
    saveUi(ui);
    manual = true;
    rerender();
  }, { cls: 'link', attrs: { 'data-nav': true, 'data-key': 'row-' + row.id, 'aria-expanded': open,
    'aria-label': (open ? 'Hide ' : 'Show ') + name } }) : undefined;
  const focused = highlighted === row.id;
  return el('li', { cls: 'trow kind-' + row.kind + (focused ? ' focus-target' : ''), attrs: { 'data-id': row.id, tabindex: focused ? -1 : undefined } },
    el('div', { cls: 'thead' },
      el('time', { cls: 'muted', text: formatClock(row.at) }),
      el('span', { cls: 'kind', text: kindLabels[row.kind] ?? row.kind }),
      el('span', { cls: 'label', text: row.label }),
      many ? el('span', { cls: 'lane', text: row.lane }) : undefined,
      row.status && row.status !== 'applied' ? badge(row.status, 'neutral') : undefined,
      collapsible && !showBody && summaryText ? el('span', { cls: 'summary-text muted', text: summaryText }) : undefined,
      toggle),
    showBody ? rowBody(row, open) : undefined);
}

/** A streak of repeated calls as one row with a warning label. Opening it shows each call and its result. */
function groupNode(rows: RowView[], ui: Ui, many: boolean, rerender: () => void): HTMLElement {
  const head = rows[0]!;
  const loop = head.loop!;
  const key = 'loop:' + loop.id + ':' + head.id;
  const open = ui.expanded.includes(key);
  const view = head.signals?.[0];
  const target = head.file ?? head.command?.split('\n')[0];
  const name = loop.tool + (target ? ' ' + target : '') + ' · repeated ' + loop.count + '×';
  return el('li', { cls: 'trow loop-group', attrs: { 'data-group': key } },
    el('div', { cls: 'thead' },
      el('time', { cls: 'muted', text: formatClock(head.at) }),
      el('span', { cls: 'kind', text: 'Repeated calls' }),
      el('span', { cls: 'label', text: name }),
      view ? signalBadge(view) : undefined,
      many ? el('span', { cls: 'lane', text: head.lane }) : undefined,
      button(open ? 'Hide calls' : 'Show calls (' + rows.length + ')', () => {
        ui.expanded = open ? ui.expanded.filter(id => id !== key) : [...ui.expanded, key].slice(-200);
        saveUi(ui);
        manual = true;
        rerender();
      }, { cls: 'link', attrs: { 'data-nav': true, 'data-key': 'group-' + key, 'aria-expanded': open, 'aria-label': (open ? 'Hide ' : 'Show ') + name } })),
    open ? el('ol', { cls: 'loop-members', attrs: { 'aria-label': 'Calls in ' + name } }, ...rows.map(row => rowNode(row, ui, many, rerender))) : undefined);
}

/** Consecutive rows of the same streak become one group. Rows keep their order. */
function items(rows: readonly RowView[]): (RowView | RowView[])[] {
  const out: (RowView | RowView[])[] = [];
  for (const row of rows) {
    const last = out[out.length - 1];
    if (row.loop && Array.isArray(last) && last[0]?.loop?.id === row.loop.id) last.push(row);
    else out.push(row.loop ? [row] : row);
  }
  return out;
}

function land(target: Landing): void {
  highlighted = target.highlight ? target.row : undefined;
  if (!target.row) {
    window.scrollTo(0, 0);
    return;
  }
  const node = [...document.querySelectorAll<HTMLElement>('.trow[data-id]')].find(item => item.dataset.id === target.row);
  if (!node) {
    announce('That row is not in the loaded part of the timeline.');
    return;
  }
  if (target.highlight) {
    node.classList.add('focus-target');
    node.tabIndex = -1;
    node.scrollIntoView({ block: 'center' });
    node.focus({ preventScroll: true });
    announce('Opened ' + (node.querySelector('.kind')?.textContent ?? 'row') + ' ' + (node.querySelector('.label')?.textContent ?? ''));
  } else {
    node.scrollIntoView({ block: 'start' });
    window.scrollBy(0, -(document.querySelector<HTMLElement>('.tabs')?.offsetHeight ?? 0));
  }
}

function select(label: string, value: string, options: readonly (readonly [string, string])[], onChange: (value: string) => void): HTMLSelectElement {
  return el('select', { attrs: { 'aria-label': label }, on: { change: event => onChange((event.target as HTMLSelectElement).value) } },
    ...options.map(([id, text]) => el('option', { attrs: { value: id, selected: id === value }, text })));
}

export function timelineTab(session: SessionModel, ui: Ui, rerender: () => void): HTMLElement {
  attachScroll();
  const first = lastSession !== session.id;
  if (first) {
    lastSession = session.id;
    seen = new Set();
    followed = true;
    pending = 0;
  }
  if (first) {
    highlighted = undefined;
    gap = undefined;
  }
  if (ui.lane && !session.lanes.some(lane => lane.id === ui.lane)) ui.lane = '';
  const allowed = ui.kind ? kindGroups[ui.kind] : undefined;
  const signalsOnly = ui.kind === 'signals';
  const rows = session.rows.filter(row => (!ui.lane || row.laneId === ui.lane)
    && (signalsOnly ? Boolean(row.signals?.length) : !allowed || allowed.includes(row.kind)));
  const incoming = peekLanding();
  if (incoming?.row) {
    gap = session.rows.some(row => row.id === incoming.row) ? undefined
      : 'That row is not shown. It is older than the events loaded here, so Agent Lens cannot scroll to it.';
    // A collapsed streak that holds the row opens so the row can be reached.
    const holder = items(rows).find((item): item is RowView[] => Array.isArray(item) && item.some(row => row.id === incoming.row));
    const holderKey = holder && 'loop:' + holder[0]!.loop!.id + ':' + holder[0]!.id;
    if (holderKey && !ui.expanded.includes(holderKey)) {
      ui.expanded = [...ui.expanded, holderKey].slice(-200);
      saveUi(ui);
    }
  } else if (incoming) gap = undefined;
  const fresh = rows.filter(row => !seen.has(row.id)).length;
  const wasFollowing = followed;
  const toolbar = el('div', { cls: 'toolbar' },
    session.lanes.length > 1 ? select('Filter by agent', ui.lane,
      [['', 'All agents'], ...session.lanes.map(lane => [lane.id, lane.label] as const)],
      value => { ui.lane = value; highlighted = undefined; gap = undefined; saveUi(ui); manual = true; rerender(); }) : undefined,
    select('Filter by event type', ui.kind, [['', 'All events'], ['conversation', 'Conversation'], ['tools', 'Tools and results'],
      ['reasoning', 'Reasoning'], ['agents', 'Agents and tasks'], ['signals', 'Signals']],
      value => { ui.kind = value; highlighted = undefined; gap = undefined; saveUi(ui); manual = true; rerender(); }));
  const list = el('ol', { cls: 'timeline', attrs: { 'aria-label': 'Session timeline' } },
    ...items(rows).map(item => Array.isArray(item) ? groupNode(item, ui, session.lanes.length > 1, rerender)
      : rowNode(item, ui, session.lanes.length > 1, rerender)));
  list.addEventListener('keydown', event => navigate(list, event));
  jump = el('button', { cls: 'jump', attrs: { type: 'button', hidden: true }, text: 'Jump to latest',
    on: { click: () => { toBottom(); followed = true; pending = 0; updateJump(); } } });
  const section = el('section', { cls: 'timeline-tab' },
    toolbar,
    gap ? el('p', { cls: 'notice', attrs: { role: 'status' }, text: gap }) : undefined,
    session.rowsOmitted ? el('p', { cls: 'muted', text: session.rowsOmitted + ' older events are not shown.' }) : undefined,
    rows.length ? list : el('p', { cls: 'empty', text: session.rows.length ? 'No events match these filters.' : 'No events recorded yet.' }),
    jump);
  for (const row of rows) seen.add(row.id);
  queueMicrotask(() => {
    const landing = takeLanding();
    if (landing) {
      manual = false;
      land(landing);
      followed = nearBottom();
      if (followed) pending = 0;
    } else if (manual) {
      manual = false;
    } else if (first || wasFollowing) {
      toBottom();
      followed = true;
    } else if (fresh) {
      pending += fresh;
      announce(pending + ' new events. Jump to latest to read them.');
    }
    updateJump();
  });
  return section;
}
