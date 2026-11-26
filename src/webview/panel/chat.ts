import type { ChatRow, ChatView, PanelRequest } from '../../shared/protocol';
import { button, clean, el } from '../dom';
import { Composer } from './composer';
import { AgentDelegationBlock, renderChatCard } from './chat-cards';
import { renderApproval } from './chat-approvals';

interface TranscriptRow {
  element: HTMLLIElement;
  label: HTMLSpanElement;
  status: HTMLSpanElement;
  body: HTMLParagraphElement;
  content: Text;
  text?: string;
  card?: { signature: string; element: HTMLElement };
  approval?: { signature: string; element: HTMLElement };
  delegation?: AgentDelegationBlock;
}

export interface ChatPosition {
  readonly top: number;
  readonly row?: string;
  readonly offset?: number;
}

const persistedRow = /^(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i;
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

const roleLabel: Record<ChatRow['role'], string> = {
  user: 'You', assistant: 'Assistant', tool: 'Tool', notice: 'Notice', error: 'Error',
};

const deliveryLabel: Record<NonNullable<ChatRow['state']>, string> = {
  pending: 'Awaiting confirmation', failed: 'Send failed', uncertain: 'Delivery uncertain',
};

const followThreshold = 48;

/** A conversation's mounted transcript and composer. Leaving Chat parks the reader's place and focus. */
export class ChatPane {
  readonly element: HTMLElement;
  private readonly composer: Composer;
  private readonly empty = el('p', { cls: 'chat-empty' });
  private readonly earlier = button('Load earlier activity', () => this.loadEarlier?.(), {
    attrs: { 'data-key': 'chat-earlier', hidden: true },
  });
  private readonly list = el('ol', { cls: 'chat-transcript', attrs: { role: 'list' } });
  private readonly scroller = el('div', {
    cls: 'chat-scroll', attrs: { role: 'region', 'aria-label': 'Conversation transcript', tabindex: 0 },
  }, el('div', { cls: 'chat-earlier' }, this.earlier), this.empty, this.list);
  private readonly updates = el('div', { cls: 'visually-hidden', attrs: { role: 'status', 'aria-atomic': 'true' } });
  private readonly commandStatus = el('div', { cls: 'visually-hidden', attrs: { role: 'status', 'aria-atomic': 'true' } });
  private readonly announcements = new Map<string, string>();
  private readonly jump = button('Jump to latest', () => {
    this.scroller.focus({ preventScroll: true });
    this.followLatest();
  }, { cls: 'chat-jump', attrs: { hidden: true } });
  private readonly rows = new Map<string, TranscriptRow>();
  private readonly scrollerResize: ResizeObserver;
  private key?: string;
  private following = true;
  private hidden = true;
  private inspecting = false;
  private unread = 0;
  private anchor?: ChatPosition;
  private startupPosition?: ChatPosition;
  private savedPosition?: ChatPosition;
  private saveTimer?: number;
  private focusedControl?: HTMLElement;

  constructor(
    private readonly post: (request: PanelRequest) => void,
    private readonly onPositionChange?: (position: ChatPosition | undefined) => void,
    initialPosition?: ChatPosition,
    private readonly openTab?: (tab: 'map' | 'files') => void,
    private readonly enterAgent?: (ref: string, id: string) => void,
    private readonly loadEarlier?: () => void,
  ) {
    this.composer = new Composer(post);
    this.startupPosition = this.savedPosition = parseChatPosition(initialPosition);
    this.element = el('section', { cls: 'chat-pane', attrs: { 'aria-label': 'Conversation' } },
      el('div', { cls: 'chat-reading-pane' }, this.scroller,
        el('div', { cls: 'chat-jump-position' }, this.jump)), this.composer.element, this.updates, this.commandStatus);
    this.composer.onToggleFolds = () => this.toggleFolds();
    this.element.addEventListener('keydown', event => {
      if (!event.defaultPrevented && event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey
        && !event.isComposing && event.key.toLowerCase() === 'o') {
        event.preventDefault();
        this.toggleFolds();
      }
    });
    this.scroller.addEventListener('scroll', () => {
      if (this.hidden) return;
      this.following = !this.inspecting && this.nearBottom();
      if (this.following) this.unread = 0;
      this.updateJump();
      if (this.onPositionChange) {
        window.clearTimeout(this.saveTimer);
        this.saveTimer = window.setTimeout(() => this.savePosition(), 150);
      }
    }, { passive: true });
    this.scrollerResize = new ResizeObserver(() => {
      if (!this.hidden && !this.inspecting && this.following) this.followLatest();
    });
  }

  update(chat: ChatView): void {
    const first = this.key !== chat.key;
    if (first) {
      this.anchor = this.startupPosition;
      this.startupPosition = undefined;
      this.key = chat.key;
      this.rows.clear();
      this.announcements.clear();
      this.commandStatus.textContent = '';
      this.list.replaceChildren();
      this.focusedControl = undefined;
      this.following = !this.anchor;
      this.unread = 0;
    }
    const visible = !this.hidden && this.element.isConnected;
    if (visible && !first) {
      this.following = !this.inspecting && this.nearBottom();
      if (this.following) this.unread = 0;
      this.anchor = this.following ? undefined : this.readAnchor();
    }

    const fresh = this.renderRows(chat);
    const empty = chat.privateMode ? 'No messages to display.' : chat.state === 'view-only' ? 'No recorded messages.' : 'No messages yet.';
    this.empty.hidden = this.rows.size > 0;
    if (this.empty.textContent !== empty) this.empty.textContent = empty;
    this.list.hidden = !this.rows.size;
    this.composer.update(chat, first);
    if (this.following && !this.inspecting) {
      if (visible) this.followLatest();
    } else {
      if (!first && !this.inspecting) this.unread += fresh;
      if (visible) this.restoreAnchor();
    }
    this.updateJump();
    if (first && visible) this.focusInitial();
  }

  setEarlier(available: boolean): void {
    const wasVisible = !this.earlier.hidden;
    if (wasVisible === available) return;
    const anchor = this.readAnchor();
    this.earlier.hidden = !available;
    if (!available && document.activeElement === this.earlier) this.scroller.focus({ preventScroll: true });
    if (this.inspecting || wasVisible || !this.following) {
      this.anchor = anchor;
      this.restoreAnchor();
    }
  }

  setInspecting(inspecting: boolean): void {
    if (this.inspecting === inspecting) return;
    this.inspecting = inspecting;
    if (inspecting) {
      this.anchor = this.readAnchor();
      this.following = false;
    } else {
      this.following = this.nearBottom();
      if (this.following) this.unread = 0;
    }
    this.updateJump();
  }

  clearDelegations(): void {
    const anchor = this.readAnchor();
    for (const row of this.rows.values()) {
      row.delegation?.element.remove();
      row.delegation = undefined;
    }
    this.anchor = anchor;
    this.restoreAnchor();
  }

  focusLaunch(id: string): boolean {
    const control = [...this.rows.values()].find(row => row.delegation?.primary.dataset.agent === id)?.delegation?.primary;
    (control ?? this.scroller).focus({ preventScroll: true });
    return !!control;
  }

  focusApproval(): boolean {
    const approval = this.list.querySelector<HTMLElement>('.chat-approval[data-state="pending"]');
    if (!approval) return false;
    const control = approval.querySelector<HTMLElement>('button:not(:disabled)') ?? approval;
    if (control === approval) control.tabIndex = -1;
    control.scrollIntoView({ block: 'nearest' });
    control.focus({ preventScroll: true });
    return true;
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

  /** Ctrl+O: open every eligible folded row, or close them all when each is already open. */
  private toggleFolds(): void {
    const folds = [...this.list.querySelectorAll('details')];
    const open = folds.some(fold => !fold.open);
    for (const fold of folds) fold.open = open;
    this.commandStatus.textContent = folds.length ? (open ? 'Folded rows expanded.' : 'Folded rows collapsed.') : 'No folded rows.';
  }

  private renderRows(chat: ChatView): number {
    const present = new Set(chat.rows.map(row => row.id));
    for (const [id, row] of this.rows) {
      if (present.has(id)) continue;
      row.element.remove();
      this.rows.delete(id);
      this.announcements.delete(id);
    }
    let fresh = 0;
    let before = this.list.firstElementChild;
    for (const row of chat.rows) {
      let rendered = this.rows.get(row.id);
      if (!rendered) {
        const label = el('span', { cls: 'chat-row-label' });
        const status = el('span', { cls: 'chat-row-status' });
        const content = document.createTextNode('');
        const body = el('p', { cls: 'chat-row-body' }, content);
        const element = el('li', { cls: 'chat-row', attrs: { 'data-id': row.id } },
          el('div', { cls: 'chat-row-meta' }, label, status), body);
        rendered = { element, label, status, body, content };
        this.rows.set(row.id, rendered);
        fresh++;
      }
      if (rendered.element === before) before = before.nextElementSibling;
      else this.list.insertBefore(rendered.element, before);

      const author = row.role === 'assistant' && chat.provider ? clean(chat.provider) : roleLabel[row.role];
      const label = row.card ? 'Agent Lens' : author;
      if (rendered.label.textContent !== label) rendered.label.textContent = label;
      rendered.label.parentElement!.hidden = !!row.delegation && !row.text && !row.card && !row.approval;
      this.updateCard(rendered, chat.privateMode ? undefined : row.card);
      this.updateDelegation(rendered, row.delegation);
      this.updateApproval(rendered, row.approval);
      const announcement = chat.privateMode ? undefined : row.card?.announcement ?? (row.role === 'error' ? row.text : undefined);
      if (announcement && this.announcements.get(row.id) !== announcement) {
        this.announcements.set(row.id, announcement);
        if (!this.hidden) this.commandStatus.textContent = clean(announcement);
      }
      if (rendered.element.dataset.role !== row.role) rendered.element.dataset.role = row.role;
      const status = row.state ? deliveryLabel[row.state] : '';
      if (rendered.status.textContent !== status) rendered.status.textContent = status;
      rendered.status.hidden = !status;
      if (rendered.element.dataset.delivery !== (row.state ?? '')) rendered.element.dataset.delivery = row.state ?? '';

      const text = chat.privateMode ? '' : row.text;
      if (rendered.text !== text) {
        const current = rendered.content.data;
        const next = clean(text);
        if (next.startsWith(current)) rendered.content.appendData(next.slice(current.length));
        else rendered.content.data = next;
        rendered.text = text;
        rendered.body.hidden = !next;
      }
    }
    return fresh;
  }

  private updateDelegation(row: TranscriptRow, agent: ChatRow['delegation']): void {
    if (!agent) {
      row.delegation?.element.remove();
      row.delegation = undefined;
      return;
    }
    if (!row.delegation) {
      row.delegation = new AgentDelegationBlock((ref, id) => this.enterAgent?.(ref, id), this.post, this.openTab);
      row.element.insertBefore(row.delegation.element, row.approval?.element ?? null);
    }
    row.delegation.update(agent);
  }

  private updateApproval(row: TranscriptRow, approval: ChatRow['approval']): void {
    if (!approval) {
      row.approval?.element.remove();
      row.approval = undefined;
      return;
    }
    const signature = JSON.stringify(approval);
    if (row.approval?.signature === signature) return;
    const element = renderApproval(approval, this.post);
    if (row.approval) {
      const previous = row.approval.element;
      const active = document.activeElement;
      const key = active instanceof HTMLElement && previous.contains(active) ? active.dataset.key : undefined;
      previous.replaceWith(element);
      // Move focus only when it was already inside the card, never from the composer.
      if (key) {
        const focus = element.querySelector<HTMLElement>('[data-key="' + CSS.escape(key) + '"]:not(:disabled)') ?? element;
        if (focus === element) element.tabIndex = -1;
        focus.focus({ preventScroll: true });
      }
    } else {
      row.element.append(element);
    }
    row.approval = { signature, element };
  }

  private updateCard(row: TranscriptRow, card: ChatRow['card']): void {
    if (!card) {
      row.card?.element.remove();
      row.card = undefined;
      return;
    }
    const signature = JSON.stringify(card);
    if (row.card?.signature === signature) return;
    const active = document.activeElement;
    const element = renderChatCard(card, this.post, this.openTab);
    if (row.card) {
      const previous = row.card.element;
      if (previous instanceof HTMLDetailsElement && element instanceof HTMLDetailsElement) element.open = previous.open;
      const key = active instanceof HTMLElement && previous.contains(active) ? active.dataset.key : undefined;
      for (const input of previous.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input[data-key], textarea[data-key]')) {
        const next = element.querySelector<HTMLInputElement | HTMLTextAreaElement>('[data-key="' + CSS.escape(input.dataset.key!) + '"]');
        if (next && next.defaultValue === input.defaultValue) {
          next.value = input.value;
          next.setSelectionRange(input.selectionStart, input.selectionEnd);
        }
      }
      previous.replaceWith(element);
      if (key) {
        const focus = element.querySelector<HTMLElement>('[data-key="' + CSS.escape(key) + '"]') ?? element;
        if (focus === element) focus.tabIndex = -1;
        focus.focus({ preventScroll: true });
      }
    } else {
      row.element.insertBefore(element, row.delegation?.element ?? row.approval?.element ?? null);
    }
    row.card = { signature, element };
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
    const row = anchor.row === undefined ? undefined : this.rows.get(anchor.row)?.element;
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
    this.jump.hidden = this.following || this.inspecting;
    const label = this.unread ? `Jump to latest (${this.unread} new)` : 'Jump to latest';
    if (this.jump.textContent !== label) this.jump.textContent = label;
    const announcement = this.unread ? `${this.unread} new ${this.unread === 1 ? 'entry' : 'entries'} in the transcript.` : '';
    if (!this.hidden && this.updates.textContent !== announcement) this.updates.textContent = announcement;
  }
}
