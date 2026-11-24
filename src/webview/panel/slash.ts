import { maxChatDraft } from '../../shared/protocol';
import type { SlashOption } from '../../shared/protocol';
import { clean, el } from '../dom';

const listId = 'chat-slash-list';

interface SlashDraft {
  leading: string;
  name: string;
  trailing: string;
}

function slashDraft(value: string): SlashDraft | undefined {
  const match = /^(\s*)\/(\S*)([^\S\r\n\u2028\u2029]*)$/.exec(value);
  if (match && match[0] === value) return { leading: match[1]!, name: match[2]!, trailing: match[3]! };
  return undefined;
}

function asciiLower(value: string): string {
  return value.replace(/[A-Z]/g, letter => letter.toLowerCase());
}

function nameMatch(option: SlashOption, name: string): number {
  const query = option.route === 'Local' ? asciiLower(name) : name;
  if (option.name === query) return 0;
  if (option.name.startsWith(query)) return 1;
  if (option.description.toLowerCase().includes(name.toLowerCase())) return 2;
  return 3;
}

/** List autocomplete for the multiline composer. Focus stays on its native textbox. */
export class SlashMenu {
  private readonly heading = el('p', { cls: 'chat-slash-heading' });
  private readonly list = el('ul', { cls: 'chat-slash-list', attrs: { id: listId, role: 'listbox', 'aria-label': 'Slash commands' } });
  private readonly status = el('span', { cls: 'visually-hidden', attrs: { role: 'status', 'aria-atomic': 'true' } });
  private readonly empty = el('p', { cls: 'chat-slash-reason', text: 'No matching commands.' });
  private readonly popup = el('div', { cls: 'chat-slash-menu', attrs: { hidden: true } }, this.heading, this.list, this.empty);
  readonly element = el('div', { cls: 'chat-slash' }, this.popup, this.status);

  private options: readonly SlashOption[] = [];
  private matches: readonly SlashOption[] = [];
  private active = -1;
  private dismissed?: string;
  private rendered = '';
  private disabled = true;

  constructor(private readonly input: HTMLTextAreaElement, private readonly complete: (value: string) => void) {
    this.input.setAttribute('aria-autocomplete', 'list');
    this.input.setAttribute('aria-haspopup', 'listbox');
    this.input.setAttribute('aria-controls', listId);
    this.input.addEventListener('focus', () => this.refresh());
    this.input.addEventListener('blur', () => this.close());
  }

  reset(): void {
    this.dismissed = undefined;
    this.close();
  }

  update(options: readonly SlashOption[] | undefined, scope: string | undefined, disabled: boolean): void {
    this.options = options ?? [];
    this.disabled = disabled;
    const heading = scope ? 'Commands · ' + clean(scope) : 'Commands';
    if (this.heading.textContent !== heading) this.heading.textContent = heading;
    this.refresh();
  }

  inputChanged(): void {
    this.dismissed = undefined;
    this.setActive(-1);
    this.refresh();
  }

  /** Reopen suggestions for a bare slash or a name that can still be completed. */
  openForIncomplete(): boolean {
    const draft = this.disabled ? undefined : slashDraft(this.input.value);
    if (!draft) return false;
    const ranks = this.options.map(option => nameMatch(option, draft.name));
    if (draft.name && (ranks.includes(0) || !ranks.includes(1))) return false;
    this.dismissed = undefined;
    this.refresh();
    return true;
  }

  handleKey(event: KeyboardEvent): boolean {
    if (this.disabled || event.isComposing || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return false;
    if (event.key === 'Escape' && !this.popup.hidden) {
      this.dismiss();
    } else if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') && !this.popup.hidden && this.matches.length) {
      const index = this.active < 0 ? (event.key === 'ArrowDown' ? 0 : this.matches.length - 1)
        : Math.min(this.matches.length - 1, Math.max(0, this.active + (event.key === 'ArrowDown' ? 1 : -1)));
      this.setActive(index, true);
    } else if ((event.key === 'Tab' || event.key === 'Enter') && !this.popup.hidden && this.active >= 0) {
      if (!event.repeat) this.insert(this.matches[this.active]!);
    } else if (event.key !== 'Enter' || !this.openForIncomplete()) {
      return false;
    }
    event.preventDefault();
    event.stopPropagation();
    return true;
  }

  private refresh(): void {
    const draft = slashDraft(this.input.value);
    if (this.disabled || this.input.disabled || document.activeElement !== this.input || !draft
      || this.dismissed === this.input.value) {
      this.close();
      return;
    }
    const matches = this.options
      .map(option => ({ option, rank: nameMatch(option, draft.name) }))
      .filter(match => match.rank < 3
        && draft.leading.length + 1 + match.option.name.length + draft.trailing.length <= maxChatDraft)
      .sort((left, right) => left.rank - right.rank)
      .map(match => match.option);
    const selected = this.matches[this.active]?.name;
    this.matches = matches;
    this.popup.hidden = false;
    this.empty.hidden = matches.length > 0;
    this.list.hidden = matches.length === 0;
    const serialized = JSON.stringify(matches);
    if (serialized !== this.rendered) {
      this.rendered = serialized;
      this.list.replaceChildren(...matches.map((option, index) => this.option(option, index)));
      this.setActive(matches.findIndex(option => option.name === selected));
    }
    const count = matches.length;
    const unavailable = matches.filter(option => option.route !== 'Official terminal' && option.reason).length;
    const terminal = matches.filter(option => option.route === 'Official terminal').length;
    const summary = [
      count === 1 ? 'One matching command.' : count ? count + ' matching commands.' : 'No matching commands.',
      unavailable ? unavailable + ' unavailable in chat.' : '',
      terminal === 1 ? 'One requires the official terminal.' : terminal ? terminal + ' require the official terminal.' : '',
    ].filter(Boolean).join(' ');
    if (this.status.textContent !== summary) this.status.textContent = summary;
  }

  private option(option: SlashOption, index: number): HTMLElement {
    const command = '/' + option.name + (option.arguments ? ' ' + option.arguments : '');
    return el('li', {
      cls: 'chat-slash-option',
      attrs: { id: listId + '-' + index, role: 'option', 'aria-selected': 'false' },
      on: {
        pointerdown: event => { if (event.button === 0) event.preventDefault(); },
        click: () => this.insert(option),
      },
    },
    el('code', { cls: 'chat-slash-command', text: command }),
    el('span', { cls: 'chat-slash-description', text: option.route + ' · ' + option.description }),
    option.reason ? el('span', { cls: 'chat-slash-reason', text: option.reason }) : undefined);
  }

  private close(): void {
    this.setActive(-1);
    this.popup.hidden = true;
    if (this.status.textContent) this.status.textContent = '';
  }

  dismiss(): void {
    this.dismissed = this.input.value;
    this.close();
  }

  private setActive(index: number, reveal = false): void {
    this.list.children[this.active]?.setAttribute('aria-selected', 'false');
    this.active = index;
    const next = this.list.children[index];
    if (next) {
      next.setAttribute('aria-selected', 'true');
      this.input.setAttribute('aria-activedescendant', next.id);
      if (reveal) next.scrollIntoView({ block: 'nearest' });
    } else {
      this.input.removeAttribute('aria-activedescendant');
    }
  }

  private insert(option: SlashOption): void {
    const draft = slashDraft(this.input.value);
    if (!draft || this.popup.hidden) return;
    const value = draft.leading + '/' + option.name + draft.trailing;
    this.complete(value);
    this.dismissed = value;
    this.close();
    this.input.focus({ preventScroll: true });
  }
}
