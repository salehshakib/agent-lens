import { isHostMessage } from '../shared/protocol';
import type { AccountProfileView, Filters, GroupNode, ProjectNode, SessionRow, SidebarModel } from '../shared/protocol';
import { formatAge, formatReset, formatTokens } from '../shared/format';
import { announce, api, badge, button, el, gaugeBlock, navigate, preserve } from './dom';
import { relayCard } from './relay';

interface Saved {
  filters: Filters;
  collapsed: string[];
  selected?: string;
}

const empty: Filters = { search: '', adapter: '', project: '', profile: '' };

function load(): Saved {
  const value = api.getState();
  if (typeof value !== 'object' || value === null) return { filters: empty, collapsed: [] };
  const saved = value as Partial<Saved>;
  const filters = saved.filters;
  const valid = typeof filters === 'object' && filters !== null && typeof filters.search === 'string'
    && typeof filters.adapter === 'string' && typeof filters.project === 'string' && (filters.profile === undefined || typeof filters.profile === 'string');
  return {
    filters: valid ? { search: filters.search.slice(0, 200), adapter: filters.adapter.slice(0, 40), project: filters.project.slice(0, 64), profile: (filters.profile ?? '').slice(0, 180) } : empty,
    collapsed: Array.isArray(saved.collapsed) ? saved.collapsed.filter((item): item is string => typeof item === 'string').slice(0, 200) : [],
    selected: typeof saved.selected === 'string' ? saved.selected : undefined,
  };
}

const saved = load();
const collapsed = new Set(saved.collapsed);
let filters = saved.filters;
let selected = saved.selected;
let lastLive = -1;
let searchTimer: number | undefined;

function persist(): void {
  api.setState({ filters, collapsed: [...collapsed], selected } satisfies Saved);
}

const root = document.getElementById('root');
if (!root) throw new Error('Missing root');

const summary = el('div', { cls: 'summary' });
const quotas = el('section', { cls: 'quotas', attrs: { 'aria-label': 'Usage limits' } });
const relays = el('section', { cls: 'relays', attrs: { 'aria-label': 'Claude limits relay' } });
const search = el('input', { attrs: { type: 'search', placeholder: 'Search sessions', 'aria-label': 'Search sessions', maxlength: 200, value: filters.search } });
const adapter = el('select', { attrs: { 'aria-label': 'Filter by agent' } });
const project = el('select', { attrs: { 'aria-label': 'Filter by project' } });
const profile = el('select', { attrs: { 'aria-label': 'Filter by profile' } });
const tree = el('div', { cls: 'tree', attrs: { role: 'group', 'aria-label': 'Sessions by project' } });
const sources = el('details', { cls: 'sources' });
const accounts = el('details', { cls: 'accounts' });
const privacy = el('p', { cls: 'privacy', attrs: { hidden: true }, text: 'Private display mode is on. Prompts, commands, output and diffs are hidden.' });

function sendFilters(): void {
  filters = { search: search.value, adapter: adapter.value, project: project.value, profile: profile.value };
  persist();
  api.postMessage({ type: 'filter', filters });
}

search.addEventListener('input', () => {
  window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(sendFilters, 200);
});
adapter.addEventListener('change', sendFilters);
project.addEventListener('change', sendFilters);
profile.addEventListener('change', sendFilters);
tree.addEventListener('keydown', event => navigate(tree, event));

root.append(
  summary, privacy, quotas, relays,
  el('div', { cls: 'filters' }, search, el('div', { cls: 'filter-row' }, adapter, project, profile)),
  tree, accounts, sources,
);

function setOptions(select: HTMLSelectElement, all: string, options: readonly { id: string; label: string }[], value: string): void {
  select.replaceChildren(el('option', { attrs: { value: '' }, text: all }),
    ...options.map(option => el('option', { attrs: { value: option.id }, text: option.label })));
  select.value = options.some(option => option.id === value) ? value : '';
}

function openSession(id: string): void {
  selected = id;
  persist();
  api.postMessage({ type: 'openSession', id });
}

function accountCard(item: AccountProfileView, now: number): HTMLElement {
  const counts = item.sessions + (item.sessions === 1 ? ' session' : ' sessions') + ' · ' + item.live + ' live'
    + (item.tokens !== undefined ? ' · ' + formatTokens(item.tokens) + ' tokens' : '');
  return el('div', { cls: 'account' },
    el('strong', { text: item.label }),
    el('span', { text: item.provider + ' · ' + item.role + (item.active ? ' · Active' : '') }),
    el('small', { cls: 'account-home', text: item.home }),
    el('span', { cls: 'account-state', text: item.state + (item.mode ? ' · ' + item.mode : '') }),
    el('small', { text: item.reason + ' ' + (item.checkedAt ? 'Checked ' + formatAge(item.checkedAt, now) + '.' : 'Not checked.') }),
    el('small', { text: counts }),
    button('Open official status in terminal', () => api.postMessage({ type: 'accountStatus', profile: item.key }), {
      cls: 'link', attrs: { 'data-nav': true, 'aria-label': 'Open official status in a terminal for ' + item.label },
    }));
}

function row(item: SessionRow, depth: number, now: number): HTMLElement {
  const meta = [item.provider, item.profile, item.project, item.updatedAt ? formatAge(item.updatedAt, now) : undefined].filter(Boolean).join(' · ');
  const main = el('button', {
    cls: 'row-main',
    attrs: { type: 'button', 'data-nav': true, 'data-key': item.id, 'aria-current': selected === item.id ? 'true' : undefined },
    on: { click: () => openSession(item.id) },
  },
  el('span', { cls: 'row-title', text: item.title }),
  badge(item.status, item.tone),
  el('span', { cls: 'row-meta', text: meta }),
  );
  const agents = item.agents.length ? el('ul', { cls: 'agents', attrs: { 'aria-label': 'Agents in this session' } },
    ...item.agents.map(agent => el('li', {}, el('span', { text: agent.title }), badge(agent.status, agent.tone)))) : undefined;
  const map = item.agents.length ? button('Agent map', () => api.postMessage({ type: 'openMap', id: item.id }), {
    cls: 'link', attrs: { 'data-nav': true, 'aria-label': 'Open agent map for ' + item.title },
  }) : undefined;
  const children = item.children.length ? el('ul', { cls: 'rows', attrs: { 'aria-label': 'Child sessions' } },
    ...item.children.map(child => row(child, depth + 1, now))) : undefined;
  return el('li', { cls: 'row', attrs: { 'data-depth': depth } }, main, agents, map, children);
}

function group(item: GroupNode, projectId: string, now: number): HTMLElement {
  return el('section', { cls: 'group', attrs: { 'data-group': item.key } },
    el('h3', { text: item.label + ' (' + item.rows.length + (item.more ? '+' : '') + ')' }),
    el('ul', { cls: 'rows' }, ...item.rows.map(item => row(item, 0, now))),
    item.more ? button('Load ' + Math.min(item.more, 20) + ' more earlier', () => api.postMessage({ type: 'loadOlder', project: projectId }), {
      cls: 'more', attrs: { 'data-nav': true, 'data-key': 'more-' + projectId },
    }) : undefined);
}

function projectNode(item: ProjectNode, now: number): HTMLElement {
  const details = el('details', { cls: 'project', attrs: { open: !collapsed.has(item.id) } },
    el('summary', { attrs: { 'data-nav': true, 'data-key': 'project-' + item.id }, text: item.label }),
    ...item.groups.map(entry => group(entry, item.id, now)));
  details.addEventListener('toggle', () => {
    if (details.open) collapsed.delete(item.id);
    else collapsed.add(item.id);
    persist();
  });
  return details;
}

function render(next: SidebarModel): void {

  const now = Date.now();
  preserve(root as HTMLElement, () => {
    summary.replaceChildren(
      el('span', { text: next.liveCount + (next.liveCount === 1 ? ' live session' : ' live sessions') }),
      el('span', { text: next.backgroundCount + ' background' }),
      button('Usage', () => api.postMessage({ type: 'openUsage' }), { attrs: { 'data-nav': true } }),
      button('Tasks', () => api.postMessage({ type: 'openTasks' }), { attrs: { 'data-nav': true } }),
    );
    privacy.hidden = !next.privateMode;
    quotas.replaceChildren(...next.gauges.map(gauge => gaugeBlock(gauge, gauge.resetsAt ? 'Resets ' + formatReset(gauge.resetsAt, now) : '')));
    relays.replaceChildren(...next.relays.map(relayCard));
    if (document.activeElement !== adapter) setOptions(adapter, 'All agents', next.adapters, filters.adapter);
    if (document.activeElement !== project) setOptions(project, 'All projects', next.projects, filters.project);
    if (document.activeElement !== profile) setOptions(profile, 'All profiles', next.profiles, filters.profile ?? '');
    if (!next.tree.length) {
      tree.replaceChildren(el('p', { cls: 'empty', text: next.total === 0 && (filters.search || filters.adapter || filters.project || filters.profile)
        ? 'No sessions match these filters.' : 'No sessions found yet. Sessions appear here when Claude Code or Codex records activity on this computer.' }));
    } else {
      tree.replaceChildren(...next.tree.map(item => projectNode(item, now)));
    }
    accounts.replaceChildren(el('summary', { text: 'Accounts' }),
      ...(next.accounts.profiles.length ? [] : [el('p', { cls: 'empty', text: 'No profiles configured.' })]),
      ...next.accounts.profiles.map(item => accountCard(item, now)),
      ...next.accounts.unassigned.map(item => el('small', { cls: 'account-note',
        text: item.provider + ': ' + item.sessions + (item.sessions === 1 ? ' session' : ' sessions') + ' from observation-only sources, no profile attached.' })),
      el('small', { cls: 'account-note', text: 'Status is read from the official command in a terminal you start. Agent Lens does not read credential files or switch accounts.' }));
    sources.replaceChildren(el('summary', { text: 'Sources' }), ...next.sources.map(source => el('div', { cls: 'source' },
      el('strong', { text: source.label }),
      el('span', { text: source.state }),
      source.state === 'Available' || source.state === 'Partial coverage'
        ? el('small', { text: source.transcripts + (source.transcripts === 1 ? ' transcript' : ' transcripts')
          + (source.versions.length ? ' · ' + source.versions.join(', ') : '') }) : undefined)));
  });
  if (next.liveCount !== lastLive) {
    if (lastLive >= 0) announce(next.liveCount + (next.liveCount === 1 ? ' live session' : ' live sessions'));
    lastLive = next.liveCount;
  }
}

window.addEventListener('message', event => {
  const message: unknown = event.data;
  if (isHostMessage(message) && message.type === 'sidebar') render(message.model);
});

api.postMessage({ type: 'ready' });
if (filters.search || filters.adapter || filters.project || filters.profile) api.postMessage({ type: 'filter', filters });
