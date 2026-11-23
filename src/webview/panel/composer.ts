import { maxChatDraft } from '../../shared/protocol';
import type { ChatView, PanelRequest } from '../../shared/protocol';
import { button, clean, el } from '../dom';

const stateLabel: Record<ChatView['state'], string> = {
  draft: 'Draft',
  'view-only': 'Read only',
  starting: 'Starting…',
  idle: 'Ready',
  working: 'Working…',
  interrupting: 'Interrupting…',
  blocked: 'Needs attention',
};

export class Composer {
  private readonly status = el('span', { cls: 'chat-status' });
  private readonly reason = el('p', { cls: 'chat-reason', attrs: { id: 'chat-composer-reason', hidden: true } });
  private readonly input = el('textarea', {
    attrs: { 'aria-label': 'Message', 'aria-describedby': 'chat-composer-reason chat-composer-keys',
      maxlength: maxChatDraft, rows: 3, placeholder: 'Write a message' },
  });
  private readonly keys = el('span', { cls: 'chat-keys', attrs: { id: 'chat-composer-keys' } });
  private readonly sendButton = button('Send', () => this.send(), { cls: 'primary' });
  private readonly interrupt = button('Interrupt', () => this.requestInterrupt());
  private readonly resume = button('Continue', () => this.post({ type: 'chatContinue' }));
  private readonly retry = button('Retry send', () => this.post({ type: 'chatRetry' }));
  private readonly scope = button('Choose scope', () => this.post({ type: 'chatChooseScope' }));
  readonly element = el('section', { cls: 'chat-composer', attrs: { 'aria-label': 'Composer' } },
    el('div', { cls: 'chat-activity' },
      el('p', { cls: 'chat-status-line', attrs: { role: 'status', 'aria-atomic': 'true' } }, this.status),
      this.interrupt),
    this.reason,
    el('div', { cls: 'chat-input-frame' },
      el('span', { cls: 'chat-input-mark', attrs: { 'aria-hidden': true }, text: '›' }), this.input,
      el('div', { cls: 'chat-composer-footer' }, this.keys,
        el('div', { cls: 'chat-composer-actions' }, this.scope, this.resume, this.retry, this.sendButton))));

  private model?: ChatView;
  private revision = 0;
  private sentRevision?: number;
  private composing = false;
  private draft = '';

  constructor(private readonly post: (request: PanelRequest) => void) {
    this.input.spellcheck = false;
    this.input.addEventListener('input', event => {
      if (!this.composing && !(event as InputEvent).isComposing) this.saveDraft();
    });
    this.input.addEventListener('compositionstart', () => {
      this.composing = true;
      this.updateSend();
    });
    this.input.addEventListener('compositionend', () => {
      this.composing = false;
      this.saveDraft();
    });
    this.input.addEventListener('keydown', event => {
      if (event.defaultPrevented || this.composing || event.isComposing || event.keyCode === 229
        || event.ctrlKey || event.altKey || event.metaKey) return;
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        if (!event.repeat) this.send();
      } else if (event.key === 'Escape' && this.model?.canInterrupt) {
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat) this.requestInterrupt();
      }
    });
  }

  update(model: ChatView, first: boolean): void {
    const active = document.activeElement;
    this.model = model;
    if (first) {
      this.revision = model.revision;
      this.sentRevision = undefined;
      this.composing = false;
      this.draft = '';
    }

    const editable = !model.privateMode && model.state !== 'view-only';
    if (model.privateMode) {
      this.input.value = '';
      this.draft = '';
      this.composing = false;
      // The host can discard a request that raced with enabling private display mode.
      this.revision = model.revision;
      this.sentRevision = undefined;
    }
    if (this.sentRevision !== undefined && model.revision >= this.sentRevision) this.sentRevision = undefined;
    if (model.revision >= this.revision) {
      this.revision = model.revision;
      if (!this.composing && !model.privateMode) {
        this.draft = model.draft;
        // Assigning an equal value would still discard the reader's editing position in some browsers.
        if (this.input.value !== this.draft) this.input.value = this.draft;
      }
    }
    this.input.disabled = !editable;
    this.input.placeholder = model.privateMode ? 'Draft hidden in private display mode'
      : model.state === 'view-only' ? 'This conversation is read only' : 'Write a message';
    this.sendButton.hidden = !editable;
    this.interrupt.hidden = !model.canInterrupt;
    this.resume.hidden = !model.canContinue || model.privateMode;
    this.retry.hidden = !model.canRetry || model.privateMode;
    this.scope.hidden = !model.canChooseScope;

    const status = stateLabel[model.state] + (model.canInterrupt ? ' · Esc to interrupt' : '');
    if (this.status.textContent !== status) this.status.textContent = status;
    this.status.dataset.state = model.state;
    const reason = model.privateMode ? 'Private display mode hides conversation content.' : clean(model.reason);
    if (this.reason.textContent !== reason) this.reason.textContent = reason;
    this.reason.hidden = !reason;
    const hint = editable ? model.canSend ? 'Enter to send · Shift+Enter for a new line' : 'Shift+Enter for a new line' : '';
    if (this.keys.textContent !== hint) this.keys.textContent = hint;
    this.updateSend();

    if (active instanceof HTMLElement && this.element.contains(active) && (active.hidden || active.matches(':disabled'))) {
      this.focus();
    }
  }

  focus(): boolean {
    const target = [this.input, this.resume, this.scope, this.interrupt, this.retry]
      .find(control => !control.disabled && !control.hidden);
    target?.focus({ preventScroll: true });
    return Boolean(target);
  }

  private saveDraft(): void {
    const value = this.input.value;
    if (!this.input.disabled && value !== this.draft) {
      this.draft = value;
      this.post({ type: 'chatDraft', revision: ++this.revision, text: value });
    }
    this.updateSend();
  }

  private updateSend(): void {
    this.sendButton.disabled = !this.model?.canSend || this.input.disabled || this.composing
      || this.sentRevision !== undefined || !this.input.value.trim();
  }

  private send(): void {
    if (this.sendButton.disabled) return;
    this.sentRevision = ++this.revision;
    this.post({ type: 'chatSend', revision: this.sentRevision, text: this.input.value });
    this.updateSend();
    this.input.focus({ preventScroll: true });
  }

  private requestInterrupt(): void {
    if (this.model?.canInterrupt) this.post({ type: 'chatInterrupt' });
  }
}
