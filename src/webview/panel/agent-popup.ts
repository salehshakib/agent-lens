import { formatDuration } from '../../shared/format';
import type { AgentActivity, AgentActivityRow, AgentBreadcrumb, AgentPopup, AgentReader, PanelRequest } from '../../shared/protocol';
import { announce, badge, button, clean, el } from '../dom';
import { AgentDelegationBlock, renderDiff, renderLinks } from './chat-cards';

const stateLabel: Record<AgentActivity['state'], string> = {
  ready: '', loading: 'Loading activity…', waiting: 'Waiting for transcript', transcriptUnavailable: 'Transcript unavailable',
  sourceUnavailable: 'Source unavailable', emptyActive: 'No activity recorded yet', empty: 'No activity recorded',
  private: 'Activity hidden in private display',
};

interface ViewPosition {
  top: number;
  row?: string;
  offset?: number;
  open: Set<string>;
  focus?: string;
  focusFold?: string;
  following: boolean;
  unread: number;
}

interface ActivityNode {
  element: HTMLLIElement;
  signature: string;
}

interface PopupActions {
  focusLaunch(id: string): boolean;
  focusApproval(): boolean;
  openTab(tab: 'map' | 'files'): void;
  inspecting(active: boolean): void;
}

function keyed(container: HTMLElement, key: string | undefined): HTMLElement | undefined {
  return key === undefined ? undefined : [...container.querySelectorAll<HTMLElement>('[data-key]')]
    .find(element => element.dataset.key === key);
}

function openDetails(container: HTMLElement): Set<string> {
  return new Set([...container.querySelectorAll<HTMLDetailsElement>('details[open][data-fold]')]
    .map(details => details.dataset.fold!));
}

function restoreDetails(container: HTMLElement, folds: ReadonlySet<string>): void {
  for (const details of container.querySelectorAll<HTMLDetailsElement>('details[data-fold]')) {
    details.open = folds.has(details.dataset.fold!);
  }
}

/** One read-only modal for the entire editor. Only the currently selected activity is mounted. */
export class AgentPopupView {
  private readonly title = el('h2', { attrs: { id: 'agent-popup-heading', tabindex: -1 } });
  private readonly provider = el('span', { cls: 'muted' });
  private readonly status = badge('', 'neutral');
  private readonly elapsed = el('span', { cls: 'muted agent-delegation-elapsed' });
  private readonly breadcrumbs = el('ol', { cls: 'agent-breadcrumb-list', attrs: { role: 'list' } });
  private readonly back = button('Back', () => this.stepBack(), { attrs: { 'data-key': 'agent-back' } });
  private readonly closeButton = button('×', () => this.close(), {
    cls: 'agent-popup-close', attrs: { 'aria-label': 'Close agent view', 'data-key': 'agent-close' },
  });
  private readonly approval = el('div', { cls: 'agent-popup-approval notice', attrs: { hidden: true } },
    el('span', { text: 'Approval waiting in chat' }),
    button('Go to approval', () => this.close(true), { attrs: { 'data-key': 'agent-approval' } }));
  private readonly links = el('div', { cls: 'agent-popup-actions', attrs: { hidden: true } });
  private readonly state = el('p', { cls: 'agent-popup-state muted', attrs: { hidden: true } });
  private readonly partial = el('p', { cls: 'agent-popup-state muted', text: 'History partial', attrs: { hidden: true } });
  private readonly missingFinal = el('p', { cls: 'agent-popup-state muted', text: 'Final result not recorded', attrs: { hidden: true } });
  private readonly earlier = button('Load earlier activity', () => this.loadEarlier(), {
    attrs: { 'data-key': 'agent-earlier', hidden: true },
  });
  private readonly list = el('ol', { cls: 'agent-popup-activity', attrs: { role: 'list' } });
  private readonly scroller = el('div', { cls: 'agent-popup-scroll', attrs: {
    'aria-label': 'Agent activity', role: 'region', tabindex: 0, 'data-key': 'agent-scroll',
  } }, this.state, this.partial, this.earlier, this.list, this.missingFinal);
  private readonly jump = button('Jump to latest', () => {
    this.scroller.focus({ preventScroll: true });
    this.followLatest();
  }, { cls: 'agent-popup-jump', attrs: { 'data-key': 'agent-latest', hidden: true } });
  private readonly dialog = el('dialog', { cls: 'agent-popup', attrs: { 'aria-labelledby': 'agent-popup-heading' } },
    el('header', { cls: 'agent-popup-header' },
      el('div', { cls: 'agent-popup-nav' }, this.back, el('nav', { attrs: { 'aria-label': 'Agent path' } }, this.breadcrumbs), this.closeButton),
      this.title, el('div', { cls: 'agent-popup-facts' }, this.provider, this.status, this.elapsed), this.links, this.approval),
    el('div', { cls: 'agent-popup-reading' }, this.scroller, this.jump));
  private readonly rows = new Map<string, ActivityNode>();
  private readonly positions = new Map<string, ViewPosition>();
  private revision = 0;
  private closedAt?: number;
  private previous?: AgentReader;
  private current?: string;
  private rootLaunch?: string;
  private requestedAt?: number;
  private returnRevision?: number;
  private crumbCount = 0;
  private crumbSignature?: string;
  private linkSignature?: string;
  private activityState?: AgentActivity['state'];
  private following = true;
  private unread = 0;
  private backdropPressed = false;

  constructor(private readonly post: (request: PanelRequest) => void, private readonly actions: PopupActions) {
    this.dialog.addEventListener('cancel', event => {
      event.preventDefault();
      this.escape();
    });
    this.dialog.addEventListener('pointerdown', event => {
      this.backdropPressed = this.onBackdrop(event);
    });
    this.dialog.addEventListener('click', event => {
      if (this.backdropPressed && this.onBackdrop(event)) this.close();
      this.backdropPressed = false;
    });
    // Keep the underlying composer from consuming Escape, including a held key after the modal closes.
    document.addEventListener('keydown', event => this.keydown(event), true);
    this.scroller.addEventListener('scroll', () => {
      if (!this.dialog.open) return;
      this.following = this.nearBottom();
      if (this.following) this.unread = 0;
      this.updateJump();
    }, { passive: true });
  }

  get open(): boolean {
    return this.dialog.open;
  }

  enter(ref: string, id: string): void {
    if (!this.open) {
      if (this.closedAt !== undefined) return;
      this.rootLaunch = id;
      this.requestedAt = this.revision;
    }
    this.post({ type: 'agentEnter', revision: this.revision, ref });
  }

  loadEarlier(): void {
    this.post({ type: 'agentEarlier', revision: this.revision });
  }

  leaveChat(): void {
    if (!this.open) return;
    this.sendClose({ type: 'agentClose', revision: this.revision });
  }

  update(reader: AgentReader, approvalWaiting: boolean, chatMounted = true): void {
    if (reader.revision < this.revision) return;
    const prior = this.previous;
    this.previous = reader;
    this.revision = reader.revision;
    if (this.closedAt !== undefined) {
      if (!reader.popup) this.closedAt = undefined;
      else if (reader.revision > this.closedAt) {
        // A page or selection may have advanced while Escape was being delivered.
        this.closedAt = reader.revision;
        this.post({ type: 'agentClose', revision: reader.revision });
      }
    }
    const selected = this.closedAt !== undefined || !chatMounted ? undefined : reader.popup;
    const popup = selected?.state === 'sourceUnavailable' ? { ...selected, rows: [], links: undefined,
      historyPartial: false, earlier: false, finalMissing: false } : selected;
    if (popup && this.open && reader === prior) {
      this.updateApproval(approvalWaiting);
      return;
    }
    if ((reader.invalidate && reader !== prior) || (popup?.state === 'sourceUnavailable' && this.activityState !== 'sourceUnavailable')
      || (prior && reader.privateMode !== prior.privateMode)) this.clearActivity();
    if (!popup) {
      const returnTo = this.rootLaunch ?? reader.returnTo;
      const wasOpen = this.open;
      if (wasOpen || this.requestedAt !== reader.revision) this.hide();
      if (wasOpen && chatMounted && returnTo) this.focusRootLaunch(returnTo);
      return;
    }

    const wasOpen = this.open;
    const same = this.current === popup.id;
    if (!same && this.current) this.positions.set(this.current, this.readPosition());
    const position = same ? this.readPosition() : this.positions.get(popup.id);
    const tailIndex = same ? popup.rows.findLastIndex(row => !row.synthetic && this.rows.has(row.id)) : -1;
    const fresh = tailIndex < 0 ? 0 : popup.rows.slice(tailIndex + 1).filter(row => !row.synthetic && !this.rows.has(row.id)).length;
    const pastState = this.activityState;
    const pastStatus = this.status.textContent;
    this.current = popup.id;
    this.requestedAt = undefined;
    this.crumbCount = popup.breadcrumbs.length;
    this.rootLaunch ??= popup.breadcrumbs[1]?.id;
    this.activityState = popup.state;
    this.renderHeader(popup);
    this.renderBody(popup, same);
    this.updateApproval(approvalWaiting);
    this.show();

    if (!position) this.scroller.scrollTop = 0;
    this.following = position?.following ?? this.nearBottom();
    this.unread = position?.unread ?? 0;
    if (this.following) this.followLatest();
    else if (position) {
      this.unread += fresh;
      this.restorePosition(position);
    }
    const returned = this.returnRevision !== reader.revision && reader.returnTo;
    if (returned) {
      this.returnRevision = reader.revision;
      const block = keyed(this.dialog, 'agent:' + returned);
      if (block) {
        block.scrollIntoView({ block: 'nearest' });
        block.focus({ preventScroll: true });
      } else {
        this.title.focus({ preventScroll: true });
        announce('Launch evidence changed.');
      }
    } else if (!same || !wasOpen) {
      this.title.focus({ preventScroll: true });
    } else if (position?.focus && (!this.dialog.contains(document.activeElement) || document.activeElement?.closest('[hidden]'))) {
      const target = keyed(this.dialog, position.focus);
      const outputSummary = keyed(this.dialog, position.focusFold);
      const fallback = position.focus === 'agent-earlier' ? this.scroller : outputSummary ?? this.title;
      (target && !target.closest('[hidden]') ? target : fallback).focus({ preventScroll: true });
    }
    if (same && !returned) {
      const notices = [pastState !== popup.state ? stateLabel[popup.state] || 'Agent activity is available.' : '',
        pastStatus !== popup.agent.status ? popup.agent.status : ''].filter(Boolean);
      if (notices.length) announce(notices.join(' '));
    }
    if (!same) {
      const path = new Set(popup.breadcrumbs.map(crumb => crumb.id));
      for (const id of this.positions.keys()) if (!path.has(id)) this.positions.delete(id);
    }
    this.updateJump();
  }

  private renderHeader(popup: AgentPopup): void {
    const { agent } = popup;
    if (this.title.textContent !== clean(agent.label)) this.title.textContent = clean(agent.label);
    if (this.provider.textContent !== clean(agent.provider)) this.provider.textContent = clean(agent.provider);
    if (this.status.textContent !== agent.status) this.status.textContent = agent.status;
    this.status.className = 'badge tone-' + agent.tone;
    const elapsed = agent.elapsedMs === undefined ? '' : formatDuration(agent.elapsedMs);
    if (this.elapsed.textContent !== elapsed) this.elapsed.textContent = elapsed;
    this.elapsed.hidden = !elapsed;
    const crumbs = JSON.stringify(popup.breadcrumbs);
    if (crumbs !== this.crumbSignature) {
      const menuOpen = this.ancestorMenu()?.open;
      this.crumbSignature = crumbs;
      const items = popup.breadcrumbs.map((crumb, index) => this.crumb(crumb, index, index === popup.breadcrumbs.length - 1));
      if (items.length > 4) {
        const menu = el('details', { cls: 'agent-ancestor-menu' },
          el('summary', { text: 'Earlier levels', attrs: { 'data-key': 'agent-ancestor-menu' } }),
          el('ol', { attrs: { role: 'list' } }, ...items.slice(1, -2)));
        menu.open = Boolean(menuOpen);
        this.breadcrumbs.replaceChildren(items[0]!, el('li', {}, menu), ...items.slice(-2));
      } else {
        this.breadcrumbs.replaceChildren(...items);
      }
    }
    const links = JSON.stringify(popup.links ?? []);
    if (links !== this.linkSignature) {
      this.linkSignature = links;
      const actions = renderLinks(popup.links, request => this.secondary(request), tab => this.secondaryTab(tab), 'agent-link');
      this.links.replaceChildren(...(actions ? [actions] : []));
      this.links.hidden = !actions;
    }
  }

  private crumb(crumb: AgentBreadcrumb, index: number, current: boolean): HTMLElement {
    const ref = crumb.ref;
    return el('li', { cls: 'agent-breadcrumb' }, ref ? button(crumb.label, () => {
      const request: PanelRequest = { type: 'agentJump', revision: this.revision, ref };
      if (index === 0) this.sendClose(request, this.rootLaunch);
      else this.post(request);
    }, { cls: 'link', attrs: { 'data-key': 'agent-crumb:' + crumb.id } }) : el('span', {
      text: crumb.label, attrs: { 'aria-current': current ? 'location' : undefined },
    }));
  }

  private renderBody(popup: AgentPopup, same: boolean): void {
    const state = stateLabel[popup.state];
    this.state.textContent = state;
    this.state.hidden = !state;
    this.partial.hidden = !popup.historyPartial;
    this.earlier.hidden = !popup.earlier;
    this.missingFinal.hidden = !popup.finalMissing;
    this.scroller.setAttribute('aria-busy', String(popup.state === 'loading'));
    if (!same) {
      this.list.replaceChildren();
      this.rows.clear();
    }
    const ids = new Set(popup.rows.map(row => row.id));
    for (const [id, row] of this.rows) {
      if (ids.has(id)) continue;
      row.element.remove();
      this.rows.delete(id);
    }
    let before = this.list.firstElementChild;
    for (const row of popup.rows) {
      let node = this.rows.get(row.id);
      if (!node) {
        node = { element: el('li', { cls: 'agent-activity-row', attrs: { 'data-row': row.id } }), signature: '' };
        this.rows.set(row.id, node);
      }
      if (node.element === before) before = before.nextElementSibling;
      else this.list.insertBefore(node.element, before);
      const signature = JSON.stringify(row);
      if (signature !== node.signature) {
        const folds = openDetails(node.element);
        const codeScroll = [...node.element.querySelectorAll<HTMLElement>('.agent-tool-field pre, .chat-card-diff[data-key]')]
          .filter(field => field.scrollTop || field.scrollLeft)
          .map(field => ({ key: field.dataset.key, top: field.scrollTop, left: field.scrollLeft }));
        const activity = row.tool ? this.tool(row, row.tool) : el('div', {},
          el('strong', { cls: 'agent-activity-label', text: row.label }),
          row.text ? el('p', { cls: 'agent-activity-text', text: row.text }) : undefined);
        const children = row.children?.map(agent => {
          const block = new AgentDelegationBlock((ref, id) => this.enter(ref, id),
            request => this.secondary(request), tab => this.secondaryTab(tab));
          block.update(agent);
          return block.element;
        }) ?? [];
        node.element.replaceChildren(activity, ...children);
        restoreDetails(node.element, folds);
        for (const position of codeScroll) {
          const field = keyed(node.element, position.key);
          if (field) field.scrollTo(position.left, position.top);
        }
        node.signature = signature;
      }
    }
    this.list.hidden = !popup.rows.length;
    if (!same) {
      const position = this.positions.get(popup.id);
      if (position) restoreDetails(this.list, position.open);
    }
  }

  private tool(row: AgentActivityRow, tool: NonNullable<AgentActivityRow['tool']>): HTMLElement {
    const key = 'tool:' + row.id;
    const facts = [tool.status, tool.durationMs === undefined ? undefined : formatDuration(tool.durationMs),
      tool.exitCode === undefined ? undefined : 'Exit ' + tool.exitCode].filter(Boolean).join(' · ');
    const output = [this.toolField(row.id, 'Output', tool.output), this.toolField(row.id, 'Stdout', tool.stdout),
      this.toolField(row.id, 'Stderr', tool.stderr)];
    const ref = tool.outputRef;
    return el('details', { cls: 'agent-tool', attrs: { 'data-fold': key } },
      el('summary', { attrs: { 'data-key': key } },
        el('strong', { text: row.label }), facts ? el('span', { cls: 'muted agent-tool-facts', text: facts }) : undefined),
      el('div', { cls: 'agent-tool-body' },
        row.text ? el('p', { cls: 'agent-activity-text', text: row.text }) : undefined,
        this.toolField(row.id, 'Input', tool.input) ?? (row.kind === 'tool' ? el('p', { cls: 'muted', text: 'Input not recorded' }) : undefined),
        ...output,
        !output.some(Boolean) ? el('p', { cls: 'muted', text: 'Output not recorded' }) : undefined,
        tool.outputTruncated ? el('p', { cls: 'muted', text: 'Output truncated' }) : undefined,
        ref ? button('Show more output', () => this.post({ type: 'agentOutput', revision: this.revision, ref }), {
          attrs: { 'data-key': 'output:' + row.id },
        }) : undefined,
        tool.diff?.length ? renderDiff(tool.diff, 'field:' + row.id + ':diff') : undefined));
  }

  private toolField(rowId: string, label: string, value: string | undefined): HTMLElement | undefined {
    return value === undefined ? undefined : el('div', { cls: 'agent-tool-field' },
      el('h3', { text: label }), el('pre', { text: value, attrs: { role: 'region', 'aria-label': label, tabindex: 0,
        'data-key': 'field:' + rowId + ':' + label } }));
  }

  private updateApproval(waiting: boolean): void {
    if (waiting === !this.approval.hidden) return;
    if (!waiting && this.approval.contains(document.activeElement)) this.title.focus({ preventScroll: true });
    this.approval.hidden = !waiting;
    if (waiting && this.open) announce('Approval waiting in chat.');
  }

  private readPosition(): ViewPosition {
    const viewport = this.scroller.getBoundingClientRect();
    const active = document.activeElement;
    const position: ViewPosition = { top: this.scroller.scrollTop, following: this.following, unread: this.unread,
      open: openDetails(this.list), focus: active instanceof HTMLElement && this.dialog.contains(active) ? active.dataset.key : undefined,
      focusFold: active?.closest<HTMLElement>('.agent-tool')?.dataset.fold };
    for (const node of this.list.children) {
      const bounds = node.getBoundingClientRect();
      if (bounds.bottom > viewport.top) return { ...position, row: (node as HTMLElement).dataset.row, offset: bounds.top - viewport.top };
    }
    return position;
  }

  private restorePosition(position: ViewPosition): void {
    const row = position.row === undefined ? undefined : this.rows.get(position.row)?.element;
    if (!row || position.offset === undefined) this.scroller.scrollTop = position.top;
    else this.scroller.scrollTop += row.getBoundingClientRect().top - this.scroller.getBoundingClientRect().top - position.offset;
  }

  private nearBottom(): boolean {
    return this.scroller.scrollHeight - this.scroller.scrollTop - this.scroller.clientHeight <= 48;
  }

  private followLatest(): void {
    this.scroller.scrollTop = this.scroller.scrollHeight;
    this.following = true;
    this.unread = 0;
    this.updateJump();
  }

  private updateJump(): void {
    if (this.following && document.activeElement === this.jump) this.scroller.focus({ preventScroll: true });
    this.jump.hidden = this.following;
    const label = this.unread ? `Jump to latest (${this.unread} new)` : 'Jump to latest';
    if (this.jump.textContent !== label) this.jump.textContent = label;
  }

  private show(): void {
    if (this.open) return;
    this.actions.inspecting(true);
    document.body.append(this.dialog);
    const live = document.getElementById('live');
    if (live) {
      live.textContent = '';
      this.dialog.append(live);
    }
    this.dialog.showModal();
    if (!this.approval.hidden) announce('Approval waiting in chat.');
  }

  private hide(): void {
    if (this.open) {
      this.dialog.close();
      const live = document.getElementById('live');
      if (live && this.dialog.contains(live)) {
        live.textContent = '';
        document.body.append(live);
      }
      this.dialog.remove();
      this.actions.inspecting(false);
    }
    this.clearActivity();
    this.rootLaunch = undefined;
    this.requestedAt = undefined;
    this.backdropPressed = false;
  }

  private clearActivity(): void {
    this.rows.clear();
    this.positions.clear();
    this.list.replaceChildren();
    this.breadcrumbs.replaceChildren();
    this.links.replaceChildren();
    this.title.textContent = '';
    this.provider.textContent = '';
    this.status.textContent = '';
    this.elapsed.textContent = '';
    this.state.textContent = '';
    this.approval.hidden = true;
    this.current = undefined;
    this.crumbSignature = undefined;
    this.linkSignature = undefined;
    this.activityState = undefined;
    this.scroller.scrollTop = 0;
    this.following = true;
    this.unread = 0;
    if (this.open) announce('');
  }

  private close(approval = false): void {
    this.sendClose({ type: 'agentClose', revision: this.revision }, this.rootLaunch, approval);
  }

  private sendClose(request: PanelRequest, returnTo?: string, approval = false): void {
    this.closedAt = this.revision;
    this.hide();
    if (!(approval && this.actions.focusApproval()) && returnTo) this.focusRootLaunch(returnTo);
    this.post(request);
  }

  private focusRootLaunch(id: string): void {
    if (!this.actions.focusLaunch(id)) announce('Launch evidence changed.');
  }

  private stepBack(): void {
    const request: PanelRequest = { type: 'agentBack', revision: this.revision };
    if (this.crumbCount <= 2) this.sendClose(request, this.rootLaunch);
    else this.post(request);
  }

  private secondary(request: PanelRequest): void {
    if (request.type === 'goto' || request.type === 'openSessionView') this.leaveChat();
    this.post(request);
  }

  private secondaryTab(tab: 'map' | 'files'): void {
    this.leaveChat();
    this.actions.openTab(tab);
  }

  private ancestorMenu(): HTMLDetailsElement | null {
    return this.breadcrumbs.querySelector<HTMLDetailsElement>('.agent-ancestor-menu');
  }

  private escape(): void {
    const menu = this.ancestorMenu();
    if (menu?.open) {
      menu.open = false;
      menu.querySelector('summary')?.focus({ preventScroll: true });
    } else {
      this.close();
    }
  }

  private keydown(event: KeyboardEvent): void {
    if (event.key === 'Escape' && this.open) {
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat && !event.isComposing) this.escape();
      return;
    }
    if (!this.open || event.key !== 'Tab' || event.defaultPrevented) return;
    const controls = [...this.dialog.querySelectorAll<HTMLElement>('button:not(:disabled), summary, [tabindex="0"]')]
      .filter(element => {
        const folded = element.closest('details:not([open])');
        return !element.closest('[hidden]') && (!folded || folded.firstElementChild === element)
          && element.getClientRects().length > 0;
      });
    const active = document.activeElement;
    if (active === this.title && !event.shiftKey) return;
    if (active === controls[event.shiftKey ? 0 : controls.length - 1] || !controls.includes(active as HTMLElement)) {
      event.preventDefault();
      controls[event.shiftKey ? controls.length - 1 : 0]?.focus();
    }
  }

  private onBackdrop(event: MouseEvent): boolean {
    if (event.target !== this.dialog) return false;
    const { left, right, top, bottom } = this.dialog.getBoundingClientRect();
    return event.clientX < left || event.clientX > right || event.clientY < top || event.clientY > bottom;
  }
}
