import type { ChatStatus, ChatStatusItem } from '../../shared/protocol';

export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const pad = (value: number) => String(value).padStart(2, '0');
  return hours ? hours + ':' + pad(minutes % 60) + ':' + pad(seconds % 60) : minutes + ':' + pad(seconds % 60);
}

/** The text of one item. Unknown values read "Unknown" so a missing measurement is never mistaken for zero. */
export function itemText(item: ChatStatusItem, now: number): string {
  const value = item.since !== undefined ? formatElapsed(now - item.since) : item.value;
  return item.label + ' ' + value;
}

/** Plain-text status for screen readers and tests. */
export function statusSummary(status: ChatStatus, now: number): string {
  return status.items.map(item => itemText(item, now)).join('. ');
}

/**
 * A compact, non-live status row. Only the elapsed counter changes each second, and it is not announced.
 * State changes are announced by the composer's own status region.
 */
export class ChatStatusLine {
  readonly element = document.createElement('div');
  private rendered = '';

  constructor() {
    this.element.className = 'chat-statusbar';
    this.element.setAttribute('role', 'group');
    this.element.setAttribute('aria-label', 'Chat status');
  }

  private elapsed?: { node: HTMLElement; item: ChatStatusItem };
  private timer?: number;

  update(status: ChatStatus | undefined, now = Date.now()): void {
    const key = JSON.stringify(status?.items.map(item => [item.id, item.value, item.known, item.detail, item.since]));
    if (key !== this.rendered) {
      this.rendered = key;
      this.elapsed = undefined;
      this.element.replaceChildren(...(status?.items ?? []).map(item => {
        const node = document.createElement('span');
        node.className = 'chat-status-item' + (item.known ? '' : ' unknown');
        node.textContent = itemText(item, now);
        if (item.detail) node.title = item.detail;
        if (item.since !== undefined) this.elapsed = { node, item };
        return node;
      }));
    }
    this.element.hidden = !status;
    if (this.elapsed && this.timer === undefined) {
      this.timer = window.setInterval(() => this.tick(), 1000);
    } else if (!this.elapsed && this.timer !== undefined) {
      window.clearInterval(this.timer);
      this.timer = undefined;
    }
    this.tick(now);
  }

  private tick(now = Date.now()): void {
    if (!this.elapsed) return;
    const text = itemText(this.elapsed.item, now);
    if (this.elapsed.node.textContent !== text) this.elapsed.node.textContent = text;
  }

  dispose(): void {
    if (this.timer !== undefined) window.clearInterval(this.timer);
    this.timer = undefined;
  }
}
