import type { DayBar, UsageModel, UsageView } from '../../shared/protocol';
import { formatReset, formatTokens } from '../../shared/format';
import { api, button, el, gaugeBlock, svg } from '../dom';
import { relayCard } from '../relay';
import type { SessionModel, Ui } from './state';
import { saveUi } from './state';

function tokenTable(rows: UsageView['tokens'], caption: string): HTMLElement {
  const cell = (value: number | undefined) => el('td', { cls: 'num', text: formatTokens(value) });
  return el('table', {},
    el('caption', { text: caption }),
    el('thead', {}, el('tr', {}, ...['Agent', 'Input', 'Cache read', 'Cache write', 'Output', 'Reasoning', 'Total']
      .map(text => el('th', { attrs: { scope: 'col' }, text })))),
    el('tbody', {}, ...rows.map(row => el('tr', {}, el('th', { attrs: { scope: 'row' }, text: row.label }),
      cell(row.input), cell(row.cacheRead), cell(row.cacheWrite), cell(row.output), cell(row.reasoning), cell(row.total)))));
}

function observedTable(rows: SessionModel['observed']): HTMLElement {
  const text = (value: string | undefined) => value ?? 'Not recorded';
  return el('table', { cls: 'observed' },
    el('caption', { text: 'Observed model and effort. These are the values the agent recorded, not the selection that was requested.' }),
    el('thead', {}, el('tr', {}, ...['Agent', 'Model', 'Effort', 'Turns', 'Source', 'Current']
      .map(label => el('th', { attrs: { scope: 'col' }, text: label })))),
    el('tbody', {}, ...rows.map(row => el('tr', {},
      el('th', { attrs: { scope: 'row' }, text: row.lane }),
      el('td', { text: text(row.model) }),
      el('td', { text: text(row.effort) }),
      el('td', { cls: 'num', text: row.turns === undefined ? '' : String(row.turns) }),
      el('td', { text: row.source }),
      el('td', { text: row.current ? 'Current' : '' })))));
}

/** Usage tab inside a session: this session's tokens and context, never account quota. */
export function sessionUsageTab(session: SessionModel): HTMLElement {
  return el('section', { cls: 'usage-tab' },
    el('p', { text: session.usageText + ' · ' + session.contextText }),
    session.usage.tokens.length ? tokenTable(session.usage.tokens, 'Tokens by agent') : el('p', { cls: 'empty', text: 'No token counts recorded for this session.' }),
    session.observed.length ? observedTable(session.observed) : undefined,
    el('p', { cls: 'muted', text: session.usage.scope + (session.usage.partial ? ' Some usage evidence is partial, so totals may be incomplete.' : '') }));
}

function chart(days: readonly DayBar[]): SVGElement {
  const width = 640;
  const height = 180;
  const max = Math.max(1, ...days.map(day => day.total));
  const slot = width / Math.max(days.length, 1);
  const barWidth = Math.max(2, Math.min(28, slot * 0.7));
  const summary = days.length
    ? 'Daily tokens from ' + days[0]?.day + ' to ' + days[days.length - 1]?.day + '. Peak ' + formatTokens(max) + ' tokens. A table follows.'
    : 'No daily token data.';
  const bars = days.map((day, index) => {
    const x = index * slot + (slot - barWidth) / 2;
    const claude = (day.claude / max) * (height - 20);
    const codex = (day.codex / max) * (height - 20);
    return svg('g', {},
      svg('title', {}, day.day + ': Claude Code ' + formatTokens(day.claude) + ', Codex ' + formatTokens(day.codex)),
      svg('rect', { class: 'bar-claude', x, y: height - 20 - claude, width: barWidth, height: claude }),
      svg('rect', { class: 'bar-codex', x, y: height - 20 - claude - codex, width: barWidth, height: codex }));
  });
  return svg('svg', { viewBox: '0 0 ' + width + ' ' + height, role: 'img', 'aria-label': summary, class: 'chart', preserveAspectRatio: 'none' },
    svg('line', { class: 'axis', x1: 0, y1: height - 20, x2: width, y2: height - 20 }),
    ...bars,
    svg('text', { class: 'axis-label', x: 0, y: height - 4 }, days[0]?.day ?? ''),
    svg('text', { class: 'axis-label', x: width, y: height - 4, 'text-anchor': 'end' }, days[days.length - 1]?.day ?? ''));
}

function filters(usage: UsageModel): HTMLElement {
  const post = (next: UsageModel['filters']) => api.postMessage({ type: 'usageFilters', filters: next });
  const select = (label: string, value: string, options: readonly (readonly [string, string])[], change: (value: string) => void) =>
    el('select', { attrs: { 'aria-label': label }, on: { change: event => change((event.target as HTMLSelectElement).value) } },
      ...options.map(([id, text]) => el('option', { attrs: { value: id, selected: id === value }, text })));
  return el('div', { cls: 'toolbar' },
    select('Date range', usage.filters.range, [['7', 'Last 7 days'], ['30', 'Last 30 days'], ['all', 'All time']],
      value => post({ ...usage.filters, range: value === '7' || value === 'all' ? value : '30' })),
    select('Filter by agent', usage.filters.adapter, [['', 'All agents'], ...usage.adapters.map(item => [item.id, item.label] as const)],
      value => post({ ...usage.filters, adapter: value })),
    select('Filter by project', usage.filters.project, [['', 'All projects'], ...usage.projects.map(item => [item.id, item.label] as const)],
      value => post({ ...usage.filters, project: value })));
}

export function usagePage(usage: UsageModel, ui: Ui): HTMLElement {
  const now = Date.now();
  ui.usage = usage.filters;
  saveUi(ui);
  const gauges = [...usage.gauges, ...usage.otherGauges];
  return el('section', { cls: 'usage-page' },
    el('h2', { text: 'Usage and limits' }),
    el('section', { cls: 'quotas', attrs: { 'aria-label': 'Account limits' } },
      ...(gauges.length ? gauges.map(gauge => el('div', {},
        gauge.bucket && usage.otherGauges.includes(gauge) ? el('div', { cls: 'muted', text: 'Other limit: ' + gauge.bucket }) : undefined,
        gaugeBlock(gauge, gauge.resetsAt ? 'Resets ' + formatReset(gauge.resetsAt, now) : ''))) : [el('p', { cls: 'empty', text: 'No limit data yet.' })]),
      el('div', { cls: 'actions' },
        el('button', { attrs: { type: 'button', disabled: usage.refresh.enabled ? undefined : true, 'aria-describedby': 'refresh-reason' }, text: 'Refresh limits',
          on: { click: () => api.postMessage({ type: 'relay', command: 'refresh', profile: usage.relays[0]?.profileId ?? '' }) } }),
        el('span', { cls: 'muted', attrs: { id: 'refresh-reason' }, text: usage.refresh.reason }))),
    el('section', { cls: 'relays', attrs: { 'aria-label': 'Claude limits relay' } }, ...usage.relays.map(relayCard)),
    filters(usage),
    usage.partial ? el('p', { cls: 'notice', text: 'Some usage evidence is partial, so these totals may be incomplete.' }) : undefined,
    el('div', { cls: 'summaries' }, ...usage.summaries.map(item => el('div', { cls: 'summary-card' },
      el('strong', { text: item.provider }),
      el('span', { text: formatTokens(item.tokens) + ' tokens' }),
      item.context === undefined ? undefined : el('span', { cls: 'muted', text: 'context ' + Math.round(item.context) + '%' })))),
    el('figure', { cls: 'chart-figure' },
      chart(usage.days),
      el('figcaption', { cls: 'legend' },
        el('span', { cls: 'swatch swatch-claude' }), ' Claude Code ',
        el('span', { cls: 'swatch swatch-codex' }), ' Codex')),
    el('details', { cls: 'table-details' },
      el('summary', { text: 'Daily token table' }),
      el('table', {},
        el('caption', { text: 'Tokens per day' }),
        el('thead', {}, el('tr', {}, ...['Day', 'Claude Code', 'Codex', 'Total'].map(text => el('th', { attrs: { scope: 'col' }, text })))),
        el('tbody', {}, ...usage.days.map(day => el('tr', {}, el('th', { attrs: { scope: 'row' }, text: day.day }),
          el('td', { cls: 'num', text: formatTokens(day.claude) }), el('td', { cls: 'num', text: formatTokens(day.codex) }),
          el('td', { cls: 'num', text: formatTokens(day.total) })))))),
    el('h3', { text: 'By model' }),
    usage.models.length ? el('table', {},
      el('caption', { text: 'Tokens by model' }),
      el('thead', {}, el('tr', {}, ...['Agent', 'Model', 'Input', 'Cache read', 'Cache write', 'Output', 'Total'].map(text => el('th', { attrs: { scope: 'col' }, text })))),
      el('tbody', {}, ...usage.models.map(row => el('tr', {}, el('td', { text: row.provider }), el('th', { attrs: { scope: 'row' }, text: row.model }),
        ...[row.input, row.cacheRead, row.cacheWrite, row.output, row.total].map(value => el('td', { cls: 'num', text: formatTokens(value) })))))) : el('p', { cls: 'empty', text: 'No token usage recorded in this range.' }));
}
