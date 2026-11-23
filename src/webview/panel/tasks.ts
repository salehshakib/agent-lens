import type { TaskView } from '../../shared/protocol';
import { formatAge } from '../../shared/format';
import { api, badge, button, el, navigate } from '../dom';

export function taskList(tasks: readonly TaskView[], empty: string, openSessions: boolean): HTMLElement {
  if (!tasks.length) return el('p', { cls: 'empty', text: empty });
  const now = Date.now();
  const list = el('ul', { cls: 'tasks', attrs: { 'aria-label': 'Background tasks' } }, ...tasks.map(task => el('li', { cls: 'task' },
    el('div', { cls: 'task-head' },
      el('strong', { text: task.title }),
      badge(task.status, task.tone)),
    el('div', { cls: 'muted', text: [task.provider, task.project, task.lane !== 'Agent' ? 'started by ' + task.lane : undefined,
      task.at ? formatAge(task.at, now) : undefined].filter(Boolean).join(' · ') }),
    openSessions ? button('Open session', () => api.postMessage({ type: 'openSession', id: task.sessionId }), {
      attrs: { 'data-nav': true, 'aria-label': 'Open session for ' + task.title } }) : undefined)));
  list.addEventListener('keydown', event => navigate(list, event));
  return list;
}

export function tasksPage(tasks: readonly TaskView[], privateMode: boolean): HTMLElement {
  return el('section', { cls: 'tasks-page' },
    el('h2', { text: 'Background tasks' }),
    privateMode ? el('p', { cls: 'notice', text: 'Private display mode is on. Task titles are hidden.' }) : undefined,
    taskList(tasks, 'No background tasks recorded.', true));
}
