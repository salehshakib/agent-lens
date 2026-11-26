import type { ChatView, PanelRequest } from '../../shared/protocol';
import { button, el } from '../dom';
import { Composer } from './composer';
import { ChatTranscript } from './chat-transcript';

export interface ChatPosition {
  readonly top: number;
  readonly row?: string;
  readonly offset?: number;
}

const persistedRow = /^(?:(?:fold:|agent:)?[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i;
const maxScrollPosition = 100_000_000;

/** Store only viewport geometry and fixed-format internal row identifiers. */
export function parseChatPosition(value: unknown): ChatPosition | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { top, row, offset } = value as Record<string, unknown>;
  if (typeof top !== 'number' || !Number.isFinite(top) || top < 0 || top > maxScrollPosition) return undefined;
  if (typeof row === 'string' && persistedRow.test(row)
    && typeof offset === 'number' && Number.isFinite(offset) && Math.abs(offset) <= maxScrollPosition) {
    return { top, row, offset };
  }
  return { top };
}

const followThreshold = 48;

/** A conversation's mounted transcript and composer. Leaving Chat parks the reader's place and focus. */
export class ChatPane {
  readonly element: HTMLElement;
  private readonly composer: Composer;
  private readonly empty = el('p', { cls: 'chat-empty' });
  private readonly list = el('ol', { cls: 'chat-transcript', attrs: { role: 'list' } });
  private readonly scroller = el('div', {
    cls: 'chat-scroll', attrs: { role: 'region', 'aria-label': 'Conversation transcript', tabindex: 0 },
  }, this.empty, this.list);
  private readonly updates = el('div', { cls: 'visually-hidden', attrs: { role: 'status', 'aria-atomic': 'true' } });
  private readonly commandStatus = el('div', { cls: 'visually-hidden', attrs: { role: 'status', 'aria-atomic': 'true' } });
  private readonly jump = button('Jump to latest', () => {
    this.scroller.focus({ preventScroll: true });
    this.followLatest();
  }, { cls: 'chat-jump', attrs: { hidden: true } });
  private readonly transcript: ChatTranscript;
  private readonly scrollerResize: ResizeObserver;
  private key?: string;
  private following = true;
  private hidden = true;
  private unread = 0;
  private anchor?: ChatPosition;
  private startupPosition?: ChatPosition;
  private savedPosition?: ChatPosition;
  private saveTimer?: number;
  private focusedControl?: HTMLElement;

  constructor(
    post: (request: PanelRequest) => void,
    private readonly onPositionChange?: (position: ChatPosition | undefined) => void,
    initialPosition?: ChatPosition,
    openTab?: (tab: 'map' | 'files') => void,
  ) {
    this.composer = new Composer(post);
    this.transcript = new ChatTranscript(this.list, { post, openTab, announce: message => {
      if (!this.hidden) this.commandStatus.textContent = message;
    } });
    this.startupPosition = this.savedPosition = parseChatPosition(initialPosition);
    this.element = el('section', { cls: 'chat-pane', attrs: { 'aria-label': 'Conversation' } },
      el('div', { cls: 'chat-reading-pane' }, this.scroller,
        el('div', { cls: 'chat-jump-position' }, this.jump)), this.composer.element, this.updates, this.commandStatus);
    this.scroller.addEventListener('scroll', () => {
      if (this.hidden) return;
      this.following = this.nearBottom();
      if (this.following) this.unread = 0;
      this.updateJump();
      if (this.onPositionChange) {
        window.clearTimeout(this.saveTimer);
        this.saveTimer = window.setTimeout(() => this.savePosition(), 150);
      }
    }, { passive: true });
    this.scrollerResize = new ResizeObserver(() => {
      if (!this.hidden && this.following) this.followLatest();
    });
  }

  update(chat: ChatView): void {
    const first = this.key !== chat.key;
    if (first) {
      this.anchor = this.startupPosition;
      this.startupPosition = undefined;
      this.key = chat.key;
      this.transcript.clear();
      this.commandStatus.textContent = '';
      this.focusedControl = undefined;
      this.following = !this.anchor;
      this.unread = 0;
    }
    const visible = !this.hidden && this.element.isConnected;
    if (visible && !first) {
      this.following = this.nearBottom();
      if (this.following) this.unread = 0;
      this.anchor = this.following ? undefined : this.readAnchor();
    }

    const fresh = this.transcript.update(chat.rows, chat.provider, chat.privateMode);
    const empty = chat.privateMode ? 'No messages to display.' : chat.state === 'view-only' ? 'No recorded messages.' : 'No messages yet.';
    this.empty.hidden = this.transcript.size > 0;
    if (this.empty.textContent !== empty) this.empty.textContent = empty;
    this.list.hidden = !this.transcript.size;
    this.composer.update(chat, first);
    if (this.following) {
      if (visible) this.followLatest();
    } else {
      if (!first) this.unread += fresh;
      if (visible) this.restoreAnchor();
    }
    this.updateJump();
    if (first && visible) this.focusInitial();
  }

  hide(): void {
    if (this.hidden) return;
    this.following = this.nearBottom();
    this.anchor = this.following ? undefined : this.readAnchor();
    const active = document.activeElement;
    this.focusedControl = active instanceof HTMLElement && this.element.contains(active) ? active : undefined;
    this.hidden = true;
    this.scrollerResize.disconnect();
    this.savePosition();
  }

  show(): void {
    if (!this.hidden || !this.element.isConnected) return;
    this.hidden = false;
    this.scrollerResize.observe(this.scroller);
    if (this.following) this.followLatest();
    else this.restoreAnchor();
    if (this.key === undefined) return;
    const target = this.focusedControl;
    if (target?.isConnected && !target.hidden && !target.matches(':disabled')) target.focus({ preventScroll: true });
    else this.focusInitial();
    this.focusedControl = undefined;
    this.updateJump();
  }

  getPosition(): ChatPosition | undefined {
    if (this.key === undefined) return this.startupPosition;
    if (this.hidden) return parseChatPosition(this.anchor);
    return this.nearBottom() ? undefined : parseChatPosition(this.readAnchor());
  }

  restorePosition(position: unknown): void {
    const anchor = parseChatPosition(position);
    if (this.key === undefined) {
      this.startupPosition = anchor;
      return;
    }
    this.anchor = anchor;
    this.following = !anchor;
    if (!this.hidden) {
      if (this.following) this.followLatest();
      else this.restoreAnchor();
    }
    this.updateJump();
  }

  private focusInitial(): void {
    if (!this.composer.focus()) this.scroller.focus({ preventScroll: true });
  }

  private nearBottom(): boolean {
    return this.scroller.scrollHeight - this.scroller.scrollTop - this.scroller.clientHeight <= followThreshold;
  }

  private readAnchor(): ChatPosition {
    const top = this.scroller.scrollTop;
    const viewport = this.scroller.getBoundingClientRect();
    for (const row of this.list.children) {
      if (!(row instanceof HTMLElement)) continue;
      const bounds = row.getBoundingClientRect();
      if (bounds.bottom > viewport.top) return { top, row: row.dataset.id, offset: bounds.top - viewport.top };
    }
    return { top };
  }

  private restoreAnchor(): void {
    const anchor = this.anchor;
    if (!anchor) return;
    const row = anchor.row === undefined ? undefined : this.transcript.get(anchor.row);
    if (row && anchor.offset !== undefined) {
      const offset = row.getBoundingClientRect().top - this.scroller.getBoundingClientRect().top;
      this.scroller.scrollTop += offset - anchor.offset;
    } else {
      this.scroller.scrollTop = anchor.top;
    }
  }

  private followLatest(): void {
    this.scroller.scrollTop = this.scroller.scrollHeight;
    this.following = true;
    this.anchor = undefined;
    this.unread = 0;
    this.updateJump();
  }

  private savePosition(): void {
    window.clearTimeout(this.saveTimer);
    if (!this.onPositionChange) return;
    const position = this.getPosition();
    if (position?.top === this.savedPosition?.top && position?.row === this.savedPosition?.row
      && position?.offset === this.savedPosition?.offset) return;
    this.savedPosition = position;
    this.onPositionChange(position);
  }

  private updateJump(): void {
    if (this.following && document.activeElement === this.jump) this.scroller.focus({ preventScroll: true });
    this.jump.hidden = this.following;
    const label = this.unread ? `Jump to latest (${this.unread} new)` : 'Jump to latest';
    if (this.jump.textContent !== label) this.jump.textContent = label;
    const announcement = this.unread ? `${this.unread} new ${this.unread === 1 ? 'entry' : 'entries'} in the transcript.` : '';
    if (!this.hidden && this.updates.textContent !== announcement) this.updates.textContent = announcement;
  }
}
