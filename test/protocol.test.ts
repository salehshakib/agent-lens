import { deepEqual, equal } from 'node:assert/strict';
import { test } from 'node:test';
import { clean } from '../src/shared/clean';
import { isHostMessage, parsePanelRequest, parseSidebarRequest } from '../src/shared/protocol';

const session = 'a'.repeat(32);
const action = 'b'.repeat(64);

test('sidebar requests accept only known shapes', () => {
  deepEqual(parseSidebarRequest({ type: 'ready' }), { type: 'ready' });
  deepEqual(parseSidebarRequest({ type: 'openSession', id: session }), { type: 'openSession', id: session });
  deepEqual(parseSidebarRequest({ type: 'filter', filters: { search: 'x', adapter: '', project: '' } }),
    { type: 'filter', filters: { search: 'x', adapter: '', project: '' } });
  equal(parseSidebarRequest({ type: 'openSession', id: '../../etc' }), undefined);
  equal(parseSidebarRequest({ type: 'openSession', id: session, extra: 1 }), undefined);
  equal(parseSidebarRequest({ type: 'filter', filters: { search: 'x'.repeat(201), adapter: '', project: '' } }), undefined);
  equal(parseSidebarRequest({ type: 'relay', command: 'format', profile: 'default' }), undefined);
  deepEqual(parseSidebarRequest({ type: 'relay', command: 'enable', profile: 'default' }), { type: 'relay', command: 'enable', profile: 'default' });
  equal(parseSidebarRequest({ type: 'run', command: 'x' }), undefined);
  equal(parseSidebarRequest(null), undefined);
  equal(parseSidebarRequest('ready'), undefined);
});

test('panel requests carry opaque ids only', () => {
  deepEqual(parsePanelRequest({ type: 'openFile', id: action }), { type: 'openFile', id: action });
  equal(parsePanelRequest({ type: 'openFile', id: 'C:/Users/example/file.ts' }), undefined);
  equal(parsePanelRequest({ type: 'openDiff', id: session }), undefined);
  deepEqual(parsePanelRequest({ type: 'openTranscript', session, lane: session }), { type: 'openTranscript', session, lane: session });
  equal(parsePanelRequest({ type: 'openTranscript', session, lane: 'C:/x.jsonl' }), undefined);
  equal(parsePanelRequest({ type: 'usageFilters', filters: { range: '90', project: '', adapter: '' } }), undefined);
  deepEqual(parsePanelRequest({ type: 'usageFilters', filters: { range: '7', project: '', adapter: 'codex' } }),
    { type: 'usageFilters', filters: { range: '7', project: '', adapter: 'codex' } });
});

test('host messages need a model object', () => {
  equal(isHostMessage({ type: 'sidebar', model: {} }), true);
  equal(isHostMessage({ type: 'panel', model: { mode: 'empty', message: 'x' } }), true);
  equal(isHostMessage({ type: 'other', model: {} }), false);
  equal(isHostMessage({ type: 'sidebar' }), false);
  equal(isHostMessage(null), false);
});

test('display cleaning removes terminal escapes and control characters but keeps text, tabs and newlines', () => {
  const esc = String.fromCharCode(27);
  equal(clean(esc + '[31mred' + esc + '[0m text'), 'red text');
  equal(clean(esc + ']0;title' + String.fromCharCode(7) + 'after'), 'after');
  equal(clean('a' + String.fromCharCode(0) + 'b\tc\nd'), 'ab\tc\nd');
  equal(clean(undefined), '');
});
