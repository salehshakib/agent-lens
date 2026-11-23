import type { RowView } from '../../shared/protocol';
import { formatClock, formatDuration } from '../../shared/format';
import { announce, badge, button, el, navigate } from '../dom';
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
  compact: 'Compaction', agent: 'Agent', task: 'Task', system: 'System',
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

function rowNode(row: RowView, ui: Ui, many: boolean, rerender: () => void): HTMLElement {
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
  return el('li', { cls: 'trow kind-' + row.kind, attrs: { 'data-id': row.id } },
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
  const allowed = ui.kind ? kindGroups[ui.kind] : undefined;
  const rows = session.rows.filter(row => (!ui.lane || row.laneId === ui.lane) && (!allowed || allowed.includes(row.kind)));
  const fresh = rows.filter(row => !seen.has(row.id)).length;
  const wasFollowing = followed;
  const toolbar = el('div', { cls: 'toolbar' },
    session.lanes.length > 1 ? select('Filter by agent', ui.lane,
      [['', 'All agents'], ...session.lanes.map(lane => [lane.id, lane.label] as const)],
      value => { ui.lane = value; saveUi(ui); manual = true; rerender(); }) : undefined,
    select('Filter by event type', ui.kind, [['', 'All events'], ['conversation', 'Conversation'], ['tools', 'Tools and results'],
      ['reasoning', 'Reasoning'], ['agents', 'Agents and tasks']], value => { ui.kind = value; saveUi(ui); manual = true; rerender(); }));
  const list = el('ol', { cls: 'timeline', attrs: { 'aria-label': 'Session timeline' } },
    ...rows.map(row => rowNode(row, ui, session.lanes.length > 1, rerender)));
  list.addEventListener('keydown', event => navigate(list, event));
  jump = el('button', { cls: 'jump', attrs: { type: 'button', hidden: true }, text: 'Jump to latest',
    on: { click: () => { toBottom(); followed = true; pending = 0; updateJump(); } } });
  const section = el('section', { cls: 'timeline-tab' },
    toolbar,
    session.rowsOmitted ? el('p', { cls: 'muted', text: session.rowsOmitted + ' older events are not shown.' }) : undefined,
    rows.length ? list : el('p', { cls: 'empty', text: session.rows.length ? 'No events match these filters.' : 'No events recorded yet.' }),
    jump);
  for (const row of rows) seen.add(row.id);
  queueMicrotask(() => {
    if (manual) {
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
