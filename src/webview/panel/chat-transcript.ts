import type { ChatCard, ChatRow, PanelRequest } from '../../shared/protocol';
import { clean, el } from '../dom';
import { renderCardBody } from './chat-cards';

interface TranscriptOptions {
  post(request: PanelRequest): void;
  openTab?: (tab: 'map' | 'files') => void;
  announce?: (text: string) => void;
}

interface MountedCard {
  element: HTMLElement;
  summary?: HTMLElement;
  body?: HTMLElement;
  signature?: string;
  children?: ChatTranscript;
}

interface MountedRow {
  element: HTMLLIElement;
  meta: HTMLElement;
  label: HTMLElement;
  status: HTMLElement;
  body: HTMLElement;
  content: Text;
  text?: string;
  announcement?: string;
  card?: MountedCard;
}

const roleLabel: Record<ChatRow['role'], string> = {
  user: 'You', assistant: 'Assistant', tool: 'Tool', notice: 'Notice', error: 'Error',
};

const deliveryLabel: Record<NonNullable<ChatRow['state']>, string> = {
  pending: 'Awaiting confirmation', failed: 'Send failed', uncertain: 'Delivery uncertain',
};

function text(node: HTMLElement, value: string): void {
  if (node.textContent !== value) node.textContent = value;
}

function makeRow(): MountedRow {
  const label = el('span', { cls: 'chat-row-label' });
  const status = el('span', { cls: 'chat-row-status' });
  const meta = el('div', { cls: 'chat-row-meta' }, label, status);
  const content = document.createTextNode('');
  const body = el('p', { cls: 'chat-row-body' }, content);
  const element = el('li', { cls: 'chat-row' }, meta, body);
  return { element, meta, label, status, content, body };
}

function keyed(container: HTMLElement, key: string | undefined): HTMLElement | undefined {
  if (!key) return undefined;
  return container.querySelector<HTMLElement>('[data-key="' + CSS.escape(key) + '"]') ?? undefined;
}

function focus(node: HTMLElement | undefined): void {
  if (node && document.activeElement !== node) node.focus({ preventScroll: true });
}

function contentScroll(container: HTMLElement) {
  return [...container.querySelectorAll<HTMLElement>('.chat-card-diff, .chat-card-output')]
    .map(node => ({ node, left: node.scrollLeft, top: node.scrollTop }))
    .filter(position => position.left || position.top);
}

function placeRow(list: HTMLOListElement, row: HTMLElement, before: Element | null): void {
  const active = document.activeElement instanceof HTMLElement && row.contains(document.activeElement)
    ? document.activeElement : undefined;
  const positions = row.parentElement === list ? contentScroll(row) : [];
  list.insertBefore(row, before);
  for (const { node, left, top } of positions) node.scrollTo(left, top);
  focus(active);
}

function replaceCardBody(previous: HTMLElement, next: HTMLElement): void {
  for (const input of previous.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input[data-key], textarea[data-key]')) {
    const replacement = keyed(next, input.dataset.key);
    if ((replacement instanceof HTMLInputElement || replacement instanceof HTMLTextAreaElement)
      && replacement.defaultValue === input.defaultValue) {
      replacement.value = input.value;
      replacement.setSelectionRange(input.selectionStart, input.selectionEnd);
    }
  }
  const positions = contentScroll(previous);
  previous.replaceWith(next);
  for (const { node, left, top } of positions) keyed(next, node.dataset.key)?.scrollTo(left, top);
}

/** Keyed transcript rows shared by the conversation and nested delegated histories. */
export class ChatTranscript {
  private rows = new Map<string, MountedRow>();
  private aliases = new Map<string, MountedRow>();

  constructor(private readonly list: HTMLOListElement, private readonly options: TranscriptOptions) {}

  get size(): number { return this.rows.size; }

  get(id: string): HTMLElement | undefined {
    return (this.rows.get(id) ?? this.aliases.get(id))?.element;
  }

  clear(): void {
    this.rows.clear();
    this.aliases.clear();
    this.list.replaceChildren();
  }

  update(rows: readonly ChatRow[], provider: string | undefined, privateMode: boolean): number {
    const active = document.activeElement instanceof HTMLElement && this.list.contains(document.activeElement)
      ? document.activeElement : undefined;
    const activeKey = active?.dataset.key;
    const mounted = new Map<string, MountedRow>();
    const aliases = new Map<string, MountedRow>();
    const used = new Set<MountedRow>();
    const canonical = new Set(rows.map(row => row.id));
    const reserved = new Set(rows.flatMap(row => this.rows.get(row.id) ?? []));
    let focusRow: MountedRow | undefined;
    let fresh = 0;
    let before = this.list.firstElementChild;

    for (const row of rows) {
      const previous = (row.anchors ?? []).filter(id => !canonical.has(id))
        .flatMap(id => this.rows.get(id) ?? this.aliases.get(id) ?? [])
        .filter(candidate => !reserved.has(candidate) && !used.has(candidate));
      const focused = active && previous.find(candidate => candidate.element.contains(active));
      const old = this.rows.get(row.id) ?? focused ?? previous[0];
      const next = old ?? makeRow();
      if (!old) fresh++;
      if (active && (next.element.contains(active) || focused)) focusRow = next;
      used.add(next);
      mounted.set(row.id, next);
      for (const alias of row.anchors ?? []) if (!canonical.has(alias)) aliases.set(alias, next);

      if (next.element === before) before = before.nextElementSibling;
      else placeRow(this.list, next.element, before);
      this.updateRow(next, row, provider, privateMode);
      const details = next.card?.element;
      if (details instanceof HTMLDetailsElement && !details.open && previous.some(candidate => candidate.card?.element instanceof HTMLDetailsElement
        && candidate.card.element.open)) details.open = true;
    }

    for (const row of this.rows.values()) if (!used.has(row)) row.element.remove();
    this.rows = mounted;
    this.aliases = aliases;

    if (active && !this.list.contains(document.activeElement)) {
      if (active.isConnected && this.list.contains(active)) focus(active);
      else {
        const equivalent = focusRow && (keyed(focusRow.element, activeKey) ?? focusRow.card?.summary);
        const destination = equivalent ?? focusRow?.element ?? this.list;
        if (!equivalent) destination.tabIndex = -1;
        focus(destination);
      }
    }

    return fresh;
  }

  private updateRow(mounted: MountedRow, row: ChatRow, provider: string | undefined, privateMode: boolean): void {
    // Folded evidence has already passed the host's private display projection. Keep local command cards hidden.
    const card = privateMode && !row.card?.folded ? undefined : row.card;
    const delivery = row.state ? deliveryLabel[row.state] : undefined;
    const status = [delivery, row.identityUnresolved ? 'Identity unresolved' : undefined].filter(Boolean).join(' · ');
    const author = row.role === 'assistant' && provider ? clean(provider) : roleLabel[row.role];
    const data = mounted.element.dataset;
    const hideMeta = Boolean(card?.folded && !status);
    if (data.id !== row.id) data.id = row.id;
    if (data.role !== row.role) data.role = row.role;
    if (data.delivery !== (row.state ?? '')) data.delivery = row.state ?? '';
    if (mounted.meta.hidden !== hideMeta) mounted.meta.hidden = hideMeta;
    if (mounted.status.hidden !== !status) mounted.status.hidden = !status;
    text(mounted.label, card && !card.folded ? 'Agent Lens' : author);
    text(mounted.status, status);
    const visible = privateMode || card?.folded ? '' : row.text;
    if (mounted.text !== visible) {
      const next = clean(visible);
      const current = mounted.content.data;
      if (next.startsWith(current)) mounted.content.appendData(next.slice(current.length));
      else mounted.content.data = next;
      mounted.text = visible;
      mounted.body.hidden = !next;
    }
    this.updateCard(mounted, card, provider, privateMode);
    const announcement = privateMode ? undefined : card?.announcement ?? (row.role === 'error' ? row.text : undefined);
    if (announcement && mounted.announcement !== announcement) this.options.announce?.(announcement);
    mounted.announcement = announcement;
  }

  private updateCard(row: MountedRow, card: ChatCard | undefined, provider: string | undefined, privateMode: boolean): void {
    if (!card) {
      row.card?.element.remove();
      row.card = undefined;
      return;
    }
    if (!row.card || Boolean(row.card.summary) !== Boolean(card.folded)) {
      const summary = card.folded ? el('summary', { attrs: { 'data-key': 'disclosure' } }) : undefined;
      const element = summary ? el('details', { cls: 'chat-card-fold' }, summary) : el('div');
      if (row.card) row.card.element.replaceWith(element);
      else row.element.append(element);
      row.card = { element, summary };
    }
    const mounted = row.card;
    const { children, ...body } = card;
    const signature = JSON.stringify(body);
    if (signature !== mounted.signature) {
      if (mounted.summary) text(mounted.summary, clean([card.title, card.outcome].filter(Boolean).join(' · ')));
      const next = renderCardBody(body, this.options.post, this.options.openTab);
      const previous = mounted.body;
      if (previous) replaceCardBody(previous, next);
      else mounted.element.append(next);
      mounted.body = next;
      mounted.signature = signature;
    }
    if (children?.length && !mounted.children) {
      const list = el('ol', { cls: 'chat-transcript-children', attrs: { role: 'list', 'aria-label': 'Delegated transcript' } });
      mounted.element.append(list);
      mounted.children = new ChatTranscript(list, { post: this.options.post, openTab: this.options.openTab });
    }
    if (mounted.children) {
      mounted.children.update(children ?? [], undefined, privateMode);
      const hidden = !mounted.children.size;
      if (mounted.children.list.hidden !== hidden) mounted.children.list.hidden = hidden;
    }
  }
}
