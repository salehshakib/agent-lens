import { isHostMessage } from '../shared/protocol';
import type { ChatView, PanelModel, PanelRequest, PanelTab } from '../shared/protocol';
import { formatDuration } from '../shared/format';
import { api, badge, button, el, preserve, signalBadge } from './dom';
import { mapTab } from './panel/agents';
import { ChatPane } from './panel/chat';
import { filesTab } from './panel/files';
import { applyFocus, applyRestore, arrive, canGoBack, departed, goBack, goTo, goToChatLink, parentAction } from './panel/nav';
import type { Arrival } from './panel/nav';
import { loadUi, saveUi } from './panel/state';
import type { Place, SessionModel } from './panel/state';
import { taskList, tasksPage } from './panel/tasks';
import { timelineTab } from './panel/timeline';
import { sessionUsageTab, usagePage } from './panel/usage';

const root = document.getElementById('root');
if (!root) throw new Error('Missing root');
const ui = loadUi();
let model: PanelModel | undefined;
function postChatRequest(request: PanelRequest): void {
  if (request.type === 'goto' && request.row && request.session === ui.session
    && model?.mode === 'chat' && !model.session?.rows.some(row => row.id === request.row)) {
    api.postMessage(request);
    return;
  }
  if (!goToChatLink(ui, request, draw)) api.postMessage(request);
}

const chatPane = new ChatPane(postChatRequest, position => {
  ui.chatPosition = position;
  saveUi(ui);
}, ui.chatPosition, tab => {
  if (ui.session) postChatRequest({ type: 'goto', session: ui.session, lane: '', row: '', tab });
});
let peerBack = false;
let peerBaseline: Place | undefined;
let activeInspection: PanelTab | undefined;
const inspectionScroll = new Map<PanelTab, number>();

const tabs: readonly (readonly [PanelTab, string])[] = [
  ['chat', 'Chat'], ['timeline', 'Timeline'], ['map', 'Agent map'], ['files', 'Files'], ['usage', 'Usage'], ['tasks', 'Background tasks'],
];

/** How the next draw lands, set when a panel message arrives and used once. */
let arrival: Arrival | undefined;

function backButton(): HTMLElement | undefined {
  if (!peerBack && !canGoBack(ui)) return undefined;
  return button('Back', () => {
    const local = ui.history.at(-1);
    if (peerBack && (!local || local === peerBaseline)) api.postMessage({ type: 'panelBack' });
    else goBack(ui, draw);
  }, { attrs: { 'data-key': 'back', title: 'Back to the previous place' } });
}

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
  const back = backButton();
  return el('header', { cls: 'session-head' },
    back || parent ? el('div', { cls: 'actions head-actions' }, back, parent) : undefined,
    breadcrumb(session),
    el('h1', {}, session.title, ' ', badge(session.status, session.tone)),
    el('p', { cls: 'facts muted', text: facts.filter(Boolean).join(' · ') }),
    signalSummary(session),
    session.privateMode ? el('p', { cls: 'notice', text: 'Private display mode is on. Prompts, commands, output and diffs are hidden.' }) : undefined,
    session.note ? el('p', { cls: 'notice', text: session.note }) : undefined);
}

const chatHeader = el('header', { cls: 'chat-header' });
let chatHeaderKey: string | undefined;

function drawChat(chat: ChatView, session?: SessionModel): void {
  if (!root) return;
  const headerKey = JSON.stringify([chat.title, chat.provider, chat.project, chat.profile, session?.id, session?.parent, peerBack, ui.history.length]);
  const entering = !chatPane.element.isConnected;
  if (entering) {
    document.body.classList.add('chat-open');
    root.replaceChildren(chatHeader, chatPane.element);
  }
  if (headerKey !== chatHeaderKey) {
    chatHeaderKey = headerKey;
    const views = session ? el('details', { cls: 'chat-views' },
      el('summary', { text: 'Views', attrs: { 'data-key': 'chat-views' } }),
      el('div', { cls: 'chat-view-options' }, ...tabs.slice(1).map(([id, label]) => button(label, () => {
        views!.open = false;
        select(id);
      })))) : undefined;
    preserve(chatHeader, () => chatHeader.replaceChildren(
      el('div', { cls: 'chat-heading' }, el('h1', { text: chat.title }),
        el('p', { cls: 'muted', text: [chat.project, chat.provider, chat.profile].filter(Boolean).join(' · ') })),
      el('div', { cls: 'actions' }, backButton(),
        session ? parentAction(session.id, '', session.parent, 'chat') : undefined, views)));
  }
  chatPane.update(chat);
  if (entering) chatPane.show();
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
  const session = current.mode === 'chat' || current.mode === 'session' ? current.session : undefined;
  if (session && arrival) {
    if (arrival.restore) applyRestore(ui, arrival.restore);
    else if (arrival.focus) applyFocus(ui, arrival.focus.lane, arrival.focus.row);
    arrival = undefined;
    saveUi(ui);
  }
  const inspection = session && ui.tab !== 'chat' ? ui.tab : undefined;
  const viewChanged = inspection !== activeInspection;
  const scroller = document.scrollingElement;
  if (activeInspection && viewChanged && scroller) inspectionScroll.set(activeInspection, scroller.scrollTop);
  activeInspection = inspection;
  if (current.mode === 'chat' && (ui.tab === 'chat' || !session)) {
    drawChat(current.chat, session);
    return;
  }
  const wasChat = chatPane.element.isConnected;
  if (wasChat) {
    chatPane.hide();
    document.body.classList.remove('chat-open');
  }
  if (current.mode === 'chat' && current.chat.privateMode) chatPane.update(current.chat);
  preserve(root, () => {
    if (!root) return;
    switch (current.mode) {
      case 'chat':
      case 'session': {
        if (!session) break;
        root.replaceChildren(header(session), tabBar(session),
          el('div', { cls: 'tabpanel', attrs: { role: 'tabpanel', id: 'tabpanel', 'aria-labelledby': 'tab-' + ui.tab } }, body(session)));
        break;
      }
      case 'usage': root.replaceChildren(usagePage(current.usage, ui)); break;
      case 'tasks': root.replaceChildren(tasksPage(current.tasks, current.privateMode)); break;
      case 'empty': root.replaceChildren(el('p', { cls: 'empty', text: current.message })); break;
    }
  });
  if (viewChanged && inspection && scroller) scroller.scrollTop = inspectionScroll.get(inspection) ?? 0;
}

window.addEventListener('message', event => {
  const message: unknown = event.data;
  if (!isHostMessage(message) || message.type !== 'panel') return;
  const next = message.model;
  if (message.peerArrival || (message.back && !peerBack)) peerBaseline = ui.history.at(-1);
  peerBack = message.back === true;
  if (next.mode === 'chat' || next.mode === 'session') {
    const id = next.mode === 'chat' ? next.id : next.session.id;
    const focus = message.focus;
    if (id && (next.mode === 'session' || next.session)) {
      arrival = message.peerArrival ? (focus ? { focus } : undefined)
        : arrive(ui, id, focus, model?.mode === 'chat' || model?.mode === 'session');
    }
    if (id !== ui.session) {
      ui.session = id;
      ui.lane = '';
      ui.kind = '';
      ui.agent = undefined;
      ui.expanded = [];
      if (!arrival) ui.history = [];
    }
    if (message.tab) ui.tab = message.tab;
    if (message.tab === 'files' && message.files && next.session && !next.session.privateMode) {
      ui.fileSearch = message.files.search;
      ui.fileKind = message.files.kind === 'all' ? '' : message.files.kind;
    }
    if (next.mode === 'chat') ui.chatKey = next.chat.key;
    ui.view = undefined;
  } else {
    departed();
    arrival = undefined;
    ui.view = next.mode === 'usage' || next.mode === 'tasks' ? next.mode : undefined;
  }
  saveUi(ui);
  model = next;
  draw();
});

api.postMessage({ type: 'ready' });
if (ui.usage.range !== '30' || ui.usage.project || ui.usage.adapter) api.postMessage({ type: 'usageFilters', filters: ui.usage });
