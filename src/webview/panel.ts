import { isHostMessage } from '../shared/protocol';
import type { PanelModel, PanelTab } from '../shared/protocol';
import { formatDuration } from '../shared/format';
import { api, badge, button, el, preserve, signalBadge } from './dom';
import { mapTab } from './panel/agents';
import { filesTab } from './panel/files';
import { applyFocus, applyRestore, arrive, canGoBack, departed, goBack, goTo, parentAction } from './panel/nav';
import type { Arrival } from './panel/nav';
import { loadUi, saveUi } from './panel/state';
import type { SessionModel } from './panel/state';
import { taskList, tasksPage } from './panel/tasks';
import { timelineTab } from './panel/timeline';
import { sessionUsageTab, usagePage } from './panel/usage';

const root = document.getElementById('root');
if (!root) throw new Error('Missing root');
const ui = loadUi();
let model: PanelModel | undefined;

const tabs: readonly (readonly [PanelTab, string])[] = [
  ['timeline', 'Timeline'], ['map', 'Agent map'], ['files', 'Files'], ['usage', 'Usage'], ['tasks', 'Background tasks'],
];

/** How the next draw lands, set when a panel message arrives and used once. */
let arrival: Arrival | undefined;

function breadcrumb(session: SessionModel): HTMLElement | undefined {
  if (session.breadcrumb.length < 3) return undefined;
  const last = session.breadcrumb.length - 1;
  return el('nav', { cls: 'crumbs', attrs: { 'aria-label': 'Delegation chain' } },
    el('ol', {}, ...session.breadcrumb.map((crumb, index) => el('li', {},
      index === 0 ? el('span', { cls: 'muted', text: crumb.label })
        : crumb.target ? button(crumb.label, () => goTo(ui, crumb.target!, draw), { cls: 'link', attrs: { 'data-key': 'crumb-' + index } })
          : el('span', { attrs: index === last ? { 'aria-current': 'location' } : {}, text: crumb.label }),
      index < last ? el('span', { cls: 'sep muted', attrs: { 'aria-hidden': true }, text: ' › ' }) : undefined))));
}

function signalSummary(session: SessionModel): HTMLElement {
  const { liveLoops, outcome, context } = session.signals;
  const loop = liveLoops > 0 ? signalBadge({ kind: 'loop', state: 'live', label: 'Possible loop',
    detail: liveLoops === 1 ? '1 live streak' : liveLoops + ' live streaks', tone: 'warn' }) : undefined;
  const none = !loop && !outcome && !context;
  return el('p', { cls: 'signal-summary', attrs: { role: 'group', 'aria-label': 'Signals' } },
    loop, outcome ? signalBadge(outcome) : undefined, context ? signalBadge(context) : undefined,
    none ? el('span', { cls: 'muted', text: 'No warnings.' }) : undefined,
    button('Signal settings', () => api.postMessage({ type: 'openSettings' }), { cls: 'link', attrs: { 'data-key': 'signal-settings',
      title: 'Loop threshold, check commands, ignore patterns and context alerts' } }));
}

function header(session: SessionModel): HTMLElement {
  const facts = [session.provider, session.profile && session.profile !== 'default' ? 'profile ' + session.profile : undefined,
    session.project, session.branch ? 'branch ' + session.branch : undefined, session.model,
    session.effort ? 'effort ' + session.effort : undefined,
    session.elapsedMs === undefined ? undefined : 'elapsed ' + formatDuration(session.elapsedMs),
    session.agentCount + (session.agentCount === 1 ? ' agent' : ' agents'), session.contextText, session.usageText];
  const parent = parentAction(session.id, '', session.parent, 'session');
  return el('header', { cls: 'session-head' },
    canGoBack(ui) || parent ? el('div', { cls: 'actions head-actions' },
      canGoBack(ui) ? button('Back', () => goBack(ui, draw), { attrs: { 'data-key': 'back', title: 'Back to the previous place' } }) : undefined,
      parent) : undefined,
    breadcrumb(session),
    el('h1', {}, session.title, ' ', badge(session.status, session.tone)),
    el('p', { cls: 'facts muted', text: facts.filter(Boolean).join(' · ') }),
    signalSummary(session),
    session.privateMode ? el('p', { cls: 'notice', text: 'Private display mode is on. Prompts, commands, output and diffs are hidden.' }) : undefined,
    session.note ? el('p', { cls: 'notice', text: session.note }) : undefined);
}

function tabBar(session: SessionModel): HTMLElement {
  const bar = el('div', { cls: 'tabs', attrs: { role: 'tablist', 'aria-label': 'Session views' } });
  tabs.forEach(([id, label]) => {
    const selected = ui.tab === id;
    const count = id === 'files' ? session.files.length : id === 'tasks' ? session.tasks.length : id === 'map' ? session.agents.length : undefined;
    bar.append(el('button', {
      cls: 'tab', attrs: { type: 'button', role: 'tab', id: 'tab-' + id, 'aria-selected': selected, 'aria-controls': 'tabpanel',
        tabindex: selected ? 0 : -1, 'data-key': 'tab-' + id },
      text: count === undefined ? label : label + ' (' + count + ')',
      on: { click: () => select(id) },
    }));
  });
  bar.addEventListener('keydown', event => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault();
    const index = tabs.findIndex(([id]) => id === ui.tab);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
      : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    const target = tabs[next];
    if (target) select(target[0]);
  });
  return bar;
}

function select(tab: PanelTab): void {
  ui.tab = tab;
  saveUi(ui);
  draw();
}

function body(session: SessionModel): HTMLElement {
  switch (ui.tab) {
    case 'map': return mapTab(session, ui, draw);
    case 'files': return filesTab(session, ui, draw);
    case 'usage': return sessionUsageTab(session);
    case 'tasks': return el('section', {}, taskList(session.tasks, 'No background tasks recorded for this session.', false));
    default: return timelineTab(session, ui, draw);
  }
}

function draw(): void {
  if (!model || !root) return;
  const current = model;
  preserve(root, () => {
    if (!root) return;
    switch (current.mode) {
      case 'session': {
        const landed = arrival;
        arrival = undefined;
        if (ui.session !== current.session.id) {
          ui.session = current.session.id;
          ui.lane = '';
          ui.kind = '';
          ui.agent = undefined;
          ui.expanded = [];
          // A session opened from the sidebar starts a new trail. A navigation keeps it.
          if (!landed) ui.history = [];
        }
        if (landed?.restore) applyRestore(ui, landed.restore);
        else if (landed?.focus) applyFocus(ui, landed.focus.lane, landed.focus.row);
        saveUi(ui);
        root.replaceChildren(header(current.session), tabBar(current.session),
          el('div', { cls: 'tabpanel', attrs: { role: 'tabpanel', id: 'tabpanel', 'aria-labelledby': 'tab-' + ui.tab } }, body(current.session)));
        break;
      }
      case 'usage': root.replaceChildren(usagePage(current.usage, ui)); break;
      case 'tasks': root.replaceChildren(tasksPage(current.tasks, current.privateMode)); break;
      case 'empty': root.replaceChildren(el('p', { cls: 'empty', text: current.message })); break;
    }
  });
}

window.addEventListener('message', event => {
  const message: unknown = event.data;
  if (!isHostMessage(message) || message.type !== 'panel') return;
  if (message.tab && message.model.mode === 'session') {
    ui.tab = message.tab;
    saveUi(ui);
  }
  if (message.model.mode === 'session') arrival = arrive(ui, message.model.session.id, message.focus, model?.mode === 'session');
  else {
    departed();
    arrival = undefined;
  }
  model = message.model;
  draw();
});

api.postMessage({ type: 'ready' });
if (ui.usage.range !== '30' || ui.usage.project || ui.usage.adapter) api.postMessage({ type: 'usageFilters', filters: ui.usage });
