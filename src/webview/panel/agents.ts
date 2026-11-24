import type { AgentNode } from '../../shared/protocol';
import { formatDuration, formatTokens } from '../../shared/format';
import { api, badge, button, el, signalBadge } from '../dom';
import { parentAction } from './nav';
import type { SessionModel, Ui } from './state';
import { saveUi } from './state';

const kindText: Record<AgentNode['kind'], string> = { main: 'Main agent', agent: 'Subagent', 'codex-run': 'Linked Codex run' };
import { stopAgentUnavailable } from '../../shared/stop-reasons';

const stopReason = stopAgentUnavailable;

function stats(node: AgentNode): string {
  const parts = [
    node.model && node.effort ? node.model + ' (' + node.effort + ' effort)' : node.model ?? (node.effort ? node.effort + ' effort' : undefined),
    node.elapsedMs === undefined ? undefined : 'elapsed ' + formatDuration(node.elapsedMs),
    node.tokens === undefined ? 'tokens unavailable' : formatTokens(node.tokens) + ' ' + node.tokenLabel,
    node.contextPercent === undefined ? 'context unavailable'
      : 'context ' + Math.round(node.contextPercent) + '%' + (node.contextApproximate ? ' (approximate)' : ''),
  ];
  return parts.filter(Boolean).join(' · ');
}

function popover(node: AgentNode, close: () => void): HTMLElement {
  const reason = el('p', { cls: 'muted', attrs: { id: 'stop-reason-' + node.id.slice(0, 16) }, text: stopReason });
  const box = el('div', { cls: 'popover', attrs: { role: 'dialog', 'aria-label': node.title + ' details', tabindex: -1 } },
    el('h4', { text: node.title }),
    el('p', { cls: 'muted', text: kindText[node.kind] + (node.parentTitle ? ' · started by ' + node.parentTitle : '') }),
    node.note ? el('p', { text: node.note }) : undefined,
    node.signals.length ? el('ul', { cls: 'signal-list', attrs: { 'aria-label': 'Signals' } },
      ...node.signals.map(view => el('li', {}, signalBadge(view)))) : undefined,
    el('h5', { text: 'Tools, in order' }),
    node.tools.length ? el('ol', { cls: 'tools' }, ...node.tools.map(tool => el('li', {},
      el('strong', { text: tool.name }),
      tool.target ? el('span', { cls: 'muted', text: ' ' + tool.target }) : undefined,
      tool.line ? el('span', { cls: 'muted', text: ' (' + tool.line + ')' }) : undefined)))
      : el('p', { cls: 'muted', text: 'No tool calls recorded.' }),
    el('div', { cls: 'actions' },
      parentAction(node.sessionId, node.laneId, node.parentInfo, node.id.slice(0, 16)),
      node.transcript
        ? button('Open transcript', () => api.postMessage({ type: 'openTranscript', session: node.sessionId, lane: node.laneId }))
        : el('span', { cls: 'muted', text: 'Transcript not available.' }),
      el('button', { attrs: { type: 'button', disabled: true, 'aria-describedby': reason.id }, text: 'Stop agent' }),
      button('Close', close)),
    reason);
  return box;
}

export function mapTab(session: SessionModel, ui: Ui, rerender: () => void): HTMLElement {
  const byParent = new Map<string, AgentNode[]>();
  const ids = new Set(session.agents.map(agent => agent.id));
  const roots: AgentNode[] = [];
  for (const agent of session.agents) {
    if (agent.parent && ids.has(agent.parent) && agent.parent !== agent.id) {
      byParent.set(agent.parent, [...(byParent.get(agent.parent) ?? []), agent]);
    } else roots.push(agent);
  }
  const visited = new Set<string>();
  function close(trigger?: HTMLElement): void {
    ui.agent = undefined;
    saveUi(ui);
    rerender();
    if (trigger?.dataset.key) {
      [...document.querySelectorAll<HTMLElement>('[data-key]')].find(node => node.dataset.key === trigger.dataset.key)?.focus();
    }
  }
  function card(node: AgentNode, depth: number): HTMLElement {
    if (visited.has(node.id) || depth > 8) return el('li');
    visited.add(node.id);
    const open = ui.agent === node.id;
    const level = node.signals.find(view => view.kind === 'context');
    const warnings = node.signals.filter(view => view.kind !== 'context');
    const trigger = el('button', {
      cls: 'agent-card', attrs: { type: 'button', 'data-key': 'agent-' + node.id, 'aria-expanded': open, 'aria-haspopup': 'dialog' },
      on: { click: () => { ui.agent = open ? undefined : node.id; saveUi(ui); rerender(); } },
    },
    el('span', { cls: 'agent-title', text: node.title }),
    badge(node.status, node.tone),
    el('span', { cls: 'muted', text: kindText[node.kind] }),
    warnings.length ? el('span', { cls: 'agent-signals' }, ...warnings.map(signalBadge)) : undefined,
    el('span', { cls: 'agent-stats' }, stats(node), level ? ' ' : undefined, level ? signalBadge(level) : undefined));
    const pop = open ? popover(node, () => close(trigger)) : undefined;
    pop?.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        close(trigger);
      }
    });
    const kids = byParent.get(node.id) ?? [];
    const item = el('li', { cls: 'agent-node' },
      el('div', { cls: 'agent-wrap' }, trigger, pop),
      kids.length ? el('ul', { cls: 'agent-children', attrs: { 'aria-label': 'Started by ' + node.title } }, ...kids.map(kid => card(kid, depth + 1))) : undefined);
    if (pop) queueMicrotask(() => pop.focus());
    return item;
  }
  const tree = el('ul', { cls: 'agent-tree', attrs: { 'aria-label': 'Agent map' } }, ...roots.map(root => card(root, 0)));
  tree.addEventListener('keydown', event => {
    if (event.key === 'Escape' && ui.agent) close();
  });
  return el('section', { cls: 'map-tab' },
    session.agents.length > 1 ? undefined : el('p', { cls: 'muted', text: 'This session has not started other agents.' }),
    tree);
}
