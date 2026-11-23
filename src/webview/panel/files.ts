import type { FileGroup } from '../../shared/protocol';
import { api, badge, button, el, navigate } from '../dom';
import type { SessionModel, Ui } from './state';
import { saveUi } from './state';

function matches(group: FileGroup, ui: Ui): boolean {
  const needle = ui.fileSearch.trim().toLowerCase();
  if (needle && !group.path.toLowerCase().includes(needle)) return false;
  if (ui.fileKind === 'changed') return group.changed > 0;
  if (ui.fileKind === 'read') return group.read > 0;
  if (ui.fileKind === 'mentioned') return group.mentioned > 0;
  return true;
}

function counts(group: FileGroup): string {
  return [group.changed ? group.changed + ' changed' : '', group.read ? group.read + ' read' : '',
    group.mentioned ? group.mentioned + ' mentioned' : ''].filter(Boolean).join(' · ');
}

export function filesTab(session: SessionModel, ui: Ui, rerender: () => void): HTMLElement {
  const groups = session.files.filter(group => matches(group, ui));
  const search = el('input', { attrs: { type: 'search', placeholder: 'Filter files', 'aria-label': 'Filter files by path', value: ui.fileSearch, maxlength: 200, 'data-key': 'file-search' } });
  let timer: number | undefined;
  search.addEventListener('input', () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => { ui.fileSearch = search.value; saveUi(ui); rerender(); }, 200);
  });
  const kind = el('select', { attrs: { 'aria-label': 'Filter by file activity', 'data-key': 'file-kind' }, on: {
    change: event => { ui.fileKind = (event.target as HTMLSelectElement).value; saveUi(ui); rerender(); } } },
  ...([['', 'All files'], ['changed', 'Changed'], ['read', 'Read'], ['mentioned', 'Mentioned']] as const)
    .map(([id, text]) => el('option', { attrs: { value: id, selected: id === ui.fileKind }, text })));
  const list = el('ul', { cls: 'files', attrs: { 'aria-label': 'Files touched in this session' } }, ...groups.map(group => el('li', { cls: 'file' },
    el('div', { cls: 'file-head' },
      el('code', { cls: 'path', text: group.path }),
      el('span', { cls: 'muted', text: counts(group) })),
    el('div', { cls: 'muted', text: group.agents.length ? 'By ' + group.agents.join(', ') : '' }),
    el('div', { cls: 'actions' },
      group.openId ? button('Open file', () => api.postMessage({ type: 'openFile', id: group.openId }), {
        attrs: { 'data-nav': true, 'aria-label': 'Open ' + group.path } }) : undefined,
      group.diffId ? button('Open recorded diff', () => api.postMessage({ type: 'openDiff', id: group.diffId }), {
        attrs: { 'data-nav': true, 'aria-label': 'Open recorded diff for ' + group.path } })
        : group.diffNote ? el('span', { cls: 'muted', text: group.diffNote }) : undefined),
    group.items.length > 1 ? el('details', { cls: 'file-items' }, el('summary', { text: group.items.length + ' recorded actions' }),
      el('ul', {}, ...group.items.map(item => el('li', {},
        el('span', { text: item.kind }), badge(item.status, item.status === 'failed' ? 'fail' : 'neutral'),
        el('span', { cls: 'muted', text: item.laneTitle }),
        item.hasDiff ? button('Diff', () => api.postMessage({ type: 'openDiff', id: item.actionId }), {
          attrs: { 'aria-label': 'Open recorded diff for this ' + item.kind + ' of ' + group.path } }) : undefined)))) : undefined)));
  list.addEventListener('keydown', event => navigate(list, event));
  return el('section', { cls: 'files-tab' },
    el('div', { cls: 'toolbar' }, search, kind),
    groups.length ? list : el('p', { cls: 'empty', text: session.files.length ? 'No files match these filters.' : 'No file activity recorded for this session.' }));
}
