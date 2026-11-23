/** Minimal DOM helpers. Every provider string is inserted as a text node, never as markup. */

export interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

import { clean } from '../shared/clean';
import type { SignalView } from '../shared/protocol';

declare function acquireVsCodeApi(): VsCodeApi;

export const api: VsCodeApi = acquireVsCodeApi();

export { clean };

export type Child = Node | string | undefined | false | null;

export interface Props {
  cls?: string;
  text?: string;
  attrs?: Record<string, string | number | boolean | undefined>;
  on?: Partial<{ [K in keyof HTMLElementEventMap]: (event: HTMLElementEventMap[K]) => void }>;
}

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.cls) node.className = props.cls;
  if (props.text !== undefined) node.textContent = clean(props.text);
  for (const [name, value] of Object.entries(props.attrs ?? {})) {
    if (value === undefined || value === false) continue;
    node.setAttribute(name, value === true ? '' : String(value));
  }
  for (const [name, handler] of Object.entries(props.on ?? {})) {
    node.addEventListener(name, handler as EventListener);
  }
  for (const child of children) {
    if (child === undefined || child === false || child === null) continue;
    node.append(typeof child === 'string' ? document.createTextNode(clean(child)) : child);
  }
  return node;
}

export function button(label: string, onClick: () => void, props: Props = {}): HTMLButtonElement {
  return el('button', { ...props, text: label, attrs: { type: 'button', ...props.attrs }, on: { click: onClick } });
}

/** A status label: the color class is decoration, the text is the signal. */
export function badge(text: string, tone: string): HTMLSpanElement {
  return el('span', { cls: 'badge tone-' + tone, text });
}

/**
 * A signal as a text label. The tone only colors it, the words carry the meaning. A warning gets a leading mark so it
 * reads as a warning without color, and the full text is also the accessible name. No motion is used.
 */
export function signalBadge(view: SignalView): HTMLSpanElement {
  const text = (view.tone === 'neutral' ? '' : '! ') + view.label + (view.detail ? ' · ' + view.detail : '');
  return el('span', { cls: 'badge signal tone-' + view.tone, text, attrs: { title: text, 'data-signal': view.kind } });
}

export function visuallyHidden(text: string): HTMLSpanElement {
  return el('span', { cls: 'visually-hidden', text });
}

export function announce(text: string): void {
  const live = document.getElementById('live');
  if (live) live.textContent = clean(text);
}

/** Re-render a container while keeping scroll position and keyboard focus on the same keyed element. */
export function preserve(container: HTMLElement, render: () => void): void {
  const scroller = document.scrollingElement;
  const top = scroller?.scrollTop ?? 0;
  const active = document.activeElement instanceof HTMLElement && container.contains(document.activeElement)
    ? document.activeElement : undefined;
  const key = active?.dataset.key;
  render();
  if (scroller) scroller.scrollTop = top;
  if (key) {
    const next = [...container.querySelectorAll<HTMLElement>('[data-key]')].find(node => node.dataset.key === key);
    next?.focus({ preventScroll: true });
    if (next instanceof HTMLInputElement && next.type === 'search') next.setSelectionRange(next.value.length, next.value.length);
  }
}

/** Arrow-key movement between focusable items marked with data-nav. */
export function navigate(container: HTMLElement, event: KeyboardEvent): void {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Home' && event.key !== 'End') return;
  const items = [...container.querySelectorAll<HTMLElement>('[data-nav]')].filter(node => node.offsetParent !== null);
  const index = items.indexOf(document.activeElement as HTMLElement);
  if (!items.length || index < 0) return;
  event.preventDefault();
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
    : Math.min(items.length - 1, Math.max(0, index + (event.key === 'ArrowDown' ? 1 : -1)));
  items[next]?.focus();
}

export function gaugeBlock(view: { provider: string; profile: string; label: string; state: string; percent?: number; reason: string }, reset: string): HTMLElement {
  const percent = view.percent;
  const name = view.provider + ' ' + view.profile + ' ' + view.label;
  return el('div', { cls: 'gauge', attrs: { 'data-state': view.state.toLowerCase().replace(' ', '-'), title: view.reason } },
    el('div', { cls: 'gauge-head' },
      el('span', { cls: 'gauge-name', text: view.provider + ' · ' + view.profile + ' · ' + view.label }),
      el('span', { cls: 'gauge-value', text: (percent === undefined ? 'No data' : Math.round(percent) + '% used') + ' · ' + view.state }),
    ),
    percent === undefined ? undefined : el('progress', {
      attrs: { max: 100, value: Math.min(100, Math.max(0, percent)), 'aria-label': name + ', ' + Math.round(percent) + ' percent used, ' + view.state },
    }),
    el('div', { cls: 'gauge-note', text: reset || view.reason }),
  );
}

const svgNamespace = 'http://www.w3.org/2000/svg';

export function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, ...children: (Node | string)[]): SVGElementTagNameMap[K] {
  const node = document.createElementNS(svgNamespace, tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, String(value));
  for (const child of children) node.append(typeof child === 'string' ? document.createTextNode(clean(child)) : child);
  return node;
}
