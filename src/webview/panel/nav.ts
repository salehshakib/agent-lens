import type { ParentInfo, RowTarget } from '../../shared/protocol';
import { api, button, el } from '../dom';
import { historyLimit, saveUi } from './state';
import type { Place, Ui } from './state';

/** Where the timeline scrolls after the next render. An empty row means the top of the lane. */
export interface Landing {
  row: string;
  /** A jump to a spawning row is highlighted and focused. A Back restore only scrolls. */
  highlight: boolean;
}

/** What a panel message means for navigation, decided once when the message arrives. */
export interface Arrival {
  focus?: { lane: string; row: string };
  restore?: Place;
}

let landing: Landing | undefined;
let restorePlace: Place | undefined;
let sent: { session: string; from: Place } | undefined;

export function setLanding(next: Landing | undefined): void {
  landing = next;
}

/** The pending landing without consuming it, so the timeline can open a collapsed streak that holds the row. */
export function peekLanding(): Landing | undefined {
  return landing;
}

export function takeLanding(): Landing | undefined {
  const next = landing;
  landing = undefined;
  return next;
}

/** The row at the top of the viewport, below the sticky tab bar. */
export function topAnchor(): string {
  const offset = (document.querySelector<HTMLElement>('.tabs')?.getBoundingClientRect().bottom ?? 0) + 1;
  for (const node of document.querySelectorAll<HTMLElement>('.trow[data-id]')) {
    if (node.getBoundingClientRect().bottom > offset) return node.dataset.id ?? '';
  }
  return '';
}

/** The place the reader is at now, while the DOM still shows it. */
export function snapshot(ui: Ui): Place | undefined {
  if (!ui.session) return undefined;
  return { session: ui.session, lane: ui.lane, kind: ui.kind, anchor: ui.tab === 'timeline' ? topAnchor() : '', tab: ui.tab };
}

function same(left: Place, right: Place): boolean {
  return left.session === right.session && left.lane === right.lane && left.kind === right.kind
    && left.anchor === right.anchor && left.tab === right.tab;
}

function push(ui: Ui, place: Place | undefined): void {
  if (!place) return;
  const last = ui.history[ui.history.length - 1];
  if (last && same(last, place)) return;
  ui.history = [...ui.history, place].slice(-historyLimit);
  saveUi(ui);
}

/** Show the timeline with every row visible, then land on a row. An empty row only sets the lane filter. */
export function applyFocus(ui: Ui, lane: string, row: string): void {
  ui.tab = 'timeline';
  ui.kind = '';
  ui.lane = row ? '' : lane;
  landing = { row, highlight: Boolean(row) };
}

export function applyRestore(ui: Ui, place: Place): void {
  ui.tab = place.tab;
  ui.lane = place.lane;
  ui.kind = place.kind;
  landing = place.tab === 'timeline' && place.anchor ? { row: place.anchor, highlight: false } : undefined;
}

/**
 * Called when a panel message for a session arrives. Pushes the place being left onto the Back history when the
 * message is part of a navigation, and returns how to land. A session opened from the sidebar is not a navigation.
 */
export function arrive(ui: Ui, id: string, focus: Arrival['focus'], shown: boolean): Arrival | undefined {
  if (restorePlace && restorePlace.session === id) {
    const restore = restorePlace;
    restorePlace = undefined;
    return { restore };
  }
  if (focus || (sent && sent.session === id)) {
    if (shown) push(ui, sent && sent.session === id ? sent.from : snapshot(ui));
    sent = undefined;
    return focus ? { focus } : {};
  }
  return undefined;
}

/** A message arrived that is not a session, so a pending navigation can no longer complete. */
export function departed(): void {
  restorePlace = undefined;
  sent = undefined;
}

/** Open a row. In the open session it lands locally. In another session the host switches and replies with a focus. */
export function goTo(ui: Ui, target: RowTarget, rerender: () => void): void {
  if (target.sessionId === ui.session) {
    push(ui, snapshot(ui));
    applyFocus(ui, target.laneId, target.rowId);
    saveUi(ui);
    rerender();
    return;
  }
  const from = snapshot(ui);
  if (from) sent = { session: target.sessionId, from };
  api.postMessage({ type: 'goto', session: target.sessionId, lane: target.laneId, row: target.rowId });
}

export function canGoBack(ui: Ui): boolean {
  return ui.history.length > 0;
}

/** Return to the previous place: its session, lane filter, tab and scroll anchor. */
export function goBack(ui: Ui, rerender: () => void): void {
  const place = ui.history[ui.history.length - 1];
  if (!place) return;
  ui.history = ui.history.slice(0, -1);
  saveUi(ui);
  if (place.session === ui.session) {
    applyRestore(ui, place);
    saveUi(ui);
    rerender();
    return;
  }
  restorePlace = place;
  api.postMessage({ type: 'goto', session: place.session, lane: '', row: '' });
}

/**
 * The Open parent control. Root sessions have none. An unresolved parent shows it disabled with the reason as text.
 * When a thread was launched more than once, the host opens a menu of launches, newest first.
 */
export function parentAction(session: string, lane: string, info: ParentInfo, key: string): HTMLElement | undefined {
  if (info.state === 'root') return undefined;
  const disabled = info.state === 'unresolved';
  const reasonId = 'parent-reason-' + key;
  const reason = 'Parent unavailable: ' + (info.reason ?? 'not resolved yet') + '.';
  return el('span', { cls: 'parent-action' },
    button('Open parent', () => api.postMessage({ type: 'openParent', session, lane }), {
      attrs: { 'data-key': 'open-parent-' + key, disabled, 'aria-describedby': disabled ? reasonId : undefined },
    }),
    disabled ? el('span', { cls: 'muted', attrs: { id: reasonId }, text: reason }) : undefined);
}
