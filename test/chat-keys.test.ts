import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PromptHistory, resolveKey } from '../src/webview/panel/chat-keys';
import type { KeyContext, KeyLike } from '../src/webview/panel/chat-keys';

const key = (name: string, extra: Partial<KeyLike> = {}): KeyLike =>
  ({ key: name, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, ...extra });
const context = (extra: Partial<KeyContext> = {}): KeyContext => ({
  menuOpen: false, canInterrupt: false, canCycleMode: false, value: '', selectionStart: 0, selectionEnd: 0,
  browsingHistory: false, hasHistory: false, ...extra,
});

test('Enter sends and Shift+Enter is left to insert a newline', () => {
  assert.equal(resolveKey(key('Enter'), context()), 'send');
  assert.equal(resolveKey(key('Enter', { shiftKey: true }), context()), 'none');
  assert.equal(resolveKey(key('Enter', { repeat: true }), context()), 'none');
  assert.equal(resolveKey(key('Enter'), context({ menuOpen: true })), 'menu');
});

test('Esc dismisses a menu first and only then interrupts an eligible turn', () => {
  assert.equal(resolveKey(key('Escape'), context({ menuOpen: true, canInterrupt: true })), 'menu');
  assert.equal(resolveKey(key('Escape'), context({ canInterrupt: true })), 'interrupt');
  assert.equal(resolveKey(key('Escape'), context()), 'none');
});

test('Shift+Tab cycles modes only when a live control is verified, otherwise focus moves normally', () => {
  assert.equal(resolveKey(key('Tab', { shiftKey: true }), context({ canCycleMode: true })), 'cycleMode');
  assert.equal(resolveKey(key('Tab', { shiftKey: true }), context()), 'none');
  assert.equal(resolveKey(key('Tab'), context({ canCycleMode: true })), 'none');
});

test('IME composition ignores every key', () => {
  for (const name of ['Enter', 'Escape', 'ArrowUp', 'Tab']) {
    assert.equal(resolveKey(key(name, { isComposing: true }), context({ canInterrupt: true, hasHistory: true })), 'none');
  }
  assert.equal(resolveKey(key('Enter', { keyCode: 229 }), context()), 'none');
});

test('Up and Down move through history only at the draft boundary', () => {
  const multiline = 'one\ntwo';
  assert.equal(resolveKey(key('ArrowUp'), context({ hasHistory: true, value: multiline, selectionStart: 0, selectionEnd: 0 })), 'historyPrev');
  assert.equal(resolveKey(key('ArrowUp'), context({ hasHistory: true, value: multiline, selectionStart: 6, selectionEnd: 6 })), 'none');
  assert.equal(resolveKey(key('ArrowUp'), context({ hasHistory: true, value: multiline, selectionStart: 0, selectionEnd: 3 })), 'none');
  assert.equal(resolveKey(key('ArrowUp'), context({ value: '' })), 'none');
  assert.equal(resolveKey(key('ArrowDown'), context({ browsingHistory: true, value: multiline, selectionStart: 7, selectionEnd: 7 })), 'historyNext');
  assert.equal(resolveKey(key('ArrowDown'), context({ browsingHistory: true, value: multiline, selectionStart: 1, selectionEnd: 1 })), 'none');
  assert.equal(resolveKey(key('ArrowDown'), context({ value: 'x', selectionStart: 1, selectionEnd: 1 })), 'none');
  assert.equal(resolveKey(key('ArrowUp'), context({ menuOpen: true, hasHistory: true })), 'menu');
});

test('platform shortcuts pass through and Ctrl+O toggles folds', () => {
  assert.equal(resolveKey(key('Enter', { ctrlKey: true }), context()), 'none');
  assert.equal(resolveKey(key('c', { metaKey: true }), context()), 'none');
  assert.equal(resolveKey(key('o', { ctrlKey: true }), context()), 'toggleFolds');
});

test('history preserves the unsent draft across stepping and restores it', () => {
  const history = new PromptHistory();
  history.seed(['first', 'second']);
  assert.equal(history.previous('my draft'), 'second');
  assert.equal(history.previous('ignored'), 'first');
  assert.equal(history.previous('ignored'), undefined);
  assert.equal(history.next(), 'second');
  assert.equal(history.next(), 'my draft');
  assert.equal(history.browsing, false);
  assert.equal(history.next(), undefined);
  history.push('third');
  assert.equal(history.previous(''), 'third');
  history.seed(['first', 'second', 'third']);
  assert.equal(history.browsing, true, 'an identical seed keeps the position');
});
