import type { PanelModel, PanelTab, UsageFilters } from '../../shared/protocol';
import { api } from '../dom';

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
}

const tabs: readonly PanelTab[] = ['timeline', 'map', 'files', 'usage', 'tasks'];
export const defaultUsage: UsageFilters = { range: '30', project: '', adapter: '' };

export function loadUi(): Ui {
  const base: Ui = { tab: 'timeline', lane: '', kind: '', expanded: [], fileSearch: '', fileKind: '', usage: defaultUsage };
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
  };
}

export function saveUi(ui: Ui): void {
  api.setState(ui);
}

export type SessionModel = Extract<PanelModel, { mode: 'session' }>['session'];
