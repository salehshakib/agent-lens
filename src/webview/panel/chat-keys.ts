/** Pure composer key decisions, kept apart from the DOM so the order of precedence can be tested. */

export interface KeyLike {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  repeat?: boolean;
  isComposing?: boolean;
  keyCode?: number;
}

export interface KeyContext {
  /** An open slash or mention menu, or a dialog, takes Esc and the arrow keys first. */
  menuOpen: boolean;
  canInterrupt: boolean;
  /** Shift+Tab cycles modes only when the host verified a live mode control. */
  canCycleMode: boolean;
  value: string;
  selectionStart: number;
  selectionEnd: number;
  /** True while the reader is stepping through earlier prompts. */
  browsingHistory: boolean;
  hasHistory: boolean;
}

export type KeyAction = 'none' | 'menu' | 'send' | 'interrupt' | 'cycleMode' | 'historyPrev' | 'historyNext' | 'toggleFolds';

/** Whether the caret sits on the first line of the draft with nothing selected. */
export function atFirstLine(value: string, start: number, end: number): boolean {
  return start === end && !value.slice(0, start).includes('\n');
}

/** Whether the caret sits on the last line of the draft with nothing selected. */
export function atLastLine(value: string, start: number, end: number): boolean {
  return start === end && !value.slice(end).includes('\n');
}

export function resolveKey(event: KeyLike, context: KeyContext): KeyAction {
  // IME composition owns every key until it ends. 229 is the legacy composition key code.
  if (event.isComposing || event.keyCode === 229) return 'none';
  const plain = !event.ctrlKey && !event.altKey && !event.metaKey;
  if (event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey && event.key.toLowerCase() === 'o') return 'toggleFolds';
  if (!plain) return 'none';
  switch (event.key) {
    case 'Escape':
      if (context.menuOpen) return 'menu';
      return context.canInterrupt && !event.repeat ? 'interrupt' : 'none';
    case 'Enter':
      if (event.shiftKey) return 'none';
      if (context.menuOpen) return 'menu';
      return event.repeat ? 'none' : 'send';
    case 'Tab':
      if (context.menuOpen && !event.shiftKey) return 'menu';
      return event.shiftKey && context.canCycleMode ? 'cycleMode' : 'none';
    case 'ArrowUp':
      if (event.shiftKey) return 'none';
      if (context.menuOpen) return 'menu';
      return context.hasHistory && atFirstLine(context.value, context.selectionStart, context.selectionEnd) ? 'historyPrev' : 'none';
    case 'ArrowDown':
      if (event.shiftKey) return 'none';
      if (context.menuOpen) return 'menu';
      return context.browsingHistory && atLastLine(context.value, context.selectionStart, context.selectionEnd) ? 'historyNext' : 'none';
    default:
      return 'none';
  }
}

/** Earlier sent prompts. Stepping back stashes the unsent draft, and stepping past the newest entry restores it. */
export class PromptHistory {
  private entries: string[] = [];
  private index = -1;
  private stash = '';

  constructor(private readonly limit = 100) {}

  get browsing(): boolean {
    return this.index >= 0;
  }

  get size(): number {
    return this.entries.length;
  }

  /** Replace the entries, for example from the conversation's user rows. Keeps the position when nothing changed. */
  seed(entries: readonly string[]): void {
    const next = entries.filter(Boolean).slice(-this.limit);
    if (next.length === this.entries.length && next.every((value, index) => value === this.entries[index])) return;
    this.entries = next;
    this.index = -1;
  }

  push(text: string): void {
    if (text && this.entries[this.entries.length - 1] !== text) this.entries = [...this.entries, text].slice(-this.limit);
    this.index = -1;
    this.stash = '';
  }

  /** The next older prompt, or undefined at the oldest. `draft` is stashed on the first step. */
  previous(draft: string): string | undefined {
    if (!this.entries.length) return undefined;
    if (this.index < 0) {
      this.stash = draft;
      this.index = this.entries.length - 1;
    } else if (this.index > 0) {
      this.index -= 1;
    } else {
      return undefined;
    }
    return this.entries[this.index];
  }

  /** The next newer prompt, or the stashed draft after the newest. */
  next(): string | undefined {
    if (this.index < 0) return undefined;
    if (this.index < this.entries.length - 1) return this.entries[++this.index];
    this.index = -1;
    const draft = this.stash;
    this.stash = '';
    return draft;
  }

  /** Leave browsing after the reader edits a recalled prompt. */
  stop(): void {
    this.index = -1;
    this.stash = '';
  }
}
