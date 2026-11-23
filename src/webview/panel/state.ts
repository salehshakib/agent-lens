import type { PanelModel, PanelTab, UsageFilters } from '../../shared/protocol';
import { api } from '../dom';
import { parseChatPosition } from './chat';
import type { ChatPosition } from './chat';

/** One place the reader can come Back to: the session, its lane filter and the topmost visible row. */
export interface Place {
  session: string;
  lane: string;
  kind: string;
  /** Row id at the top of the viewport, or empty. */
  anchor: string;
  tab: PanelTab;
}

export const historyLimit = 20;

export interface Ui {
  tab: PanelTab;
  lane: string;
  kind: string;
  expanded: string[];
  agent?: string;
  fileSearch: string;
  fileKind: string;
  usage: UsageFilters;
  /** Session the saved view belongs to. */
  session?: string;
  chatKey?: string;
  chatPosition?: ChatPosition;
  view?: 'usage' | 'tasks';
  /** Back history of this panel, newest last. */
  history: Place[];
}

const tabs: readonly PanelTab[] = ['chat', 'timeline', 'map', 'files', 'usage', 'tasks'];

function isPlace(value: unknown): value is Place {
  if (typeof value !== 'object' || value === null) return false;
  const place = value as Record<string, unknown>;
  return typeof place.session === 'string' && typeof place.lane === 'string' && typeof place.kind === 'string'
    && typeof place.anchor === 'string' && tabs.includes(place.tab as PanelTab);
}
export const defaultUsage: UsageFilters = { range: '30', project: '', adapter: '' };

export function loadUi(): Ui {
  const base: Ui = { tab: 'chat', lane: '', kind: '', expanded: [], fileSearch: '', fileKind: '', usage: defaultUsage, history: [] };
  const value = api.getState();
  if (typeof value !== 'object' || value === null) return base;
  const saved = value as Partial<Ui>;
  const usage = saved.usage;
  return {
    tab: tabs.includes(saved.tab as PanelTab) ? saved.tab as PanelTab : base.tab,
    lane: typeof saved.lane === 'string' ? saved.lane.slice(0, 80) : '',
    kind: typeof saved.kind === 'string' ? saved.kind.slice(0, 20) : '',
    expanded: Array.isArray(saved.expanded) ? saved.expanded.filter((item): item is string => typeof item === 'string').slice(-200) : [],
    agent: typeof saved.agent === 'string' ? saved.agent : undefined,
    fileSearch: typeof saved.fileSearch === 'string' ? saved.fileSearch.slice(0, 200) : '',
    fileKind: typeof saved.fileKind === 'string' ? saved.fileKind.slice(0, 20) : '',
    usage: usage && (usage.range === '7' || usage.range === '30' || usage.range === 'all')
      && typeof usage.project === 'string' && typeof usage.adapter === 'string'
      ? { range: usage.range, project: usage.project.slice(0, 64), adapter: usage.adapter.slice(0, 40) } : defaultUsage,
    session: typeof saved.session === 'string' ? saved.session : undefined,
    chatKey: typeof saved.chatKey === 'string' ? saved.chatKey.slice(0, 64) : undefined,
    chatPosition: parseChatPosition(saved.chatPosition),
    view: saved.view === 'usage' || saved.view === 'tasks' ? saved.view : undefined,
    history: Array.isArray(saved.history) ? saved.history.filter(isPlace).slice(-historyLimit).map(place => ({
      session: place.session.slice(0, 64), lane: place.lane.slice(0, 80), kind: place.kind.slice(0, 20),
      anchor: place.anchor.slice(0, 200), tab: place.tab })) : [],
  };
}

export function saveUi(ui: Ui): void {
  api.setState(ui);
}

export type SessionModel = Extract<PanelModel, { mode: 'session' }>['session'];
