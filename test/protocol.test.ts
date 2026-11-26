import { deepEqual, equal } from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { build } from 'esbuild';
import { clean } from '../src/shared/clean';
import { isHostMessage, parsePanelRequest, parseSidebarRequest } from '../src/shared/protocol';

const session = 'a'.repeat(32);
const action = 'b'.repeat(64);

test('sidebar requests accept only known shapes', () => {
  deepEqual(parseSidebarRequest({ type: 'ready' }), { type: 'ready' });
  deepEqual(parseSidebarRequest({ type: 'openSession', id: session }), { type: 'openSession', id: session });
  deepEqual(parseSidebarRequest({ type: 'filter', filters: { search: 'x', adapter: '', project: '', warnings: false } }),
    { type: 'filter', filters: { search: 'x', adapter: '', project: '', warnings: false } });
  equal(parseSidebarRequest({ type: 'openSession', id: '../../etc' }), undefined);
  equal(parseSidebarRequest({ type: 'openSession', id: session, extra: 1 }), undefined);
  equal(parseSidebarRequest({ type: 'filter', filters: { search: 'x'.repeat(201), adapter: '', project: '', warnings: false } }), undefined);
  equal(parseSidebarRequest({ type: 'filter', filters: { search: '', adapter: '', project: '' } }), undefined);
  equal(parseSidebarRequest({ type: 'filter', filters: { search: '', adapter: '', project: '', warnings: 'yes' } }), undefined);
  deepEqual(parseSidebarRequest({ type: 'openParent', id: session }), { type: 'openParent', id: session });
  equal(parseSidebarRequest({ type: 'openParent', id: 'not-an-id' }), undefined);
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

test('panel navigation requests carry opaque session, lane and row ids only', () => {
  const row = 'c'.repeat(32);
  deepEqual(parsePanelRequest({ type: 'goto', session, lane: session, row }), { type: 'goto', session, lane: session, row });
  deepEqual(parsePanelRequest({ type: 'goto', session, lane: '', row: '' }), { type: 'goto', session, lane: '', row: '' });
  equal(parsePanelRequest({ type: 'goto', session, lane: '../x', row }), undefined);
  equal(parsePanelRequest({ type: 'goto', session, lane: '', row: 'C:/x.jsonl' }), undefined);
  equal(parsePanelRequest({ type: 'goto', session, lane: '' }), undefined);
  equal(parsePanelRequest({ type: 'goto', session, lane: '', row, extra: 1 }), undefined);
  deepEqual(parsePanelRequest({ type: 'openParent', session, lane: '' }), { type: 'openParent', session, lane: '' });
  deepEqual(parsePanelRequest({ type: 'openParent', session, lane: session }), { type: 'openParent', session, lane: session });
  equal(parsePanelRequest({ type: 'openParent', session: 'x', lane: '' }), undefined);
  equal(parsePanelRequest({ type: 'openParent', session }), undefined);
  deepEqual(parsePanelRequest({ type: 'openSettings' }), { type: 'openSettings' });
  equal(parsePanelRequest({ type: 'openSettings', section: 'signals' }), undefined);
});

test('agent reader requests validate a revision and opaque offered reference', () => {
  for (const type of ['agentEnter', 'agentJump', 'agentOutput']) {
    const request = { type, revision: 2, ref: action };
    deepEqual(parsePanelRequest(request), request);
    equal(parsePanelRequest({ ...request, ref: session }), undefined);
    equal(parsePanelRequest({ ...request, ref: '../provider-log.jsonl' }), undefined);
    equal(parsePanelRequest({ ...request, row: session }), undefined);
    equal(parsePanelRequest({ ...request, revision: -1 }), undefined);
  }
  for (const type of ['agentBack', 'agentClose', 'agentEarlier']) {
    const request = { type, revision: 0 };
    deepEqual(parsePanelRequest(request), request);
    equal(parsePanelRequest({ ...request, revision: 1.5 }), undefined);
    equal(parsePanelRequest({ ...request, limit: 100_000 }), undefined);
  }
  deepEqual(parsePanelRequest({ type: 'openSessionView', session, tab: 'files' }), { type: 'openSessionView', session, tab: 'files' });
  equal(parsePanelRequest({ type: 'openSessionView', session, tab: 'chat' }), undefined);
  equal(isHostMessage({ type: 'agentReader', reader: { revision: 5, privateMode: true, invalidate: true } }), true);
  equal(isHostMessage({ type: 'agentReader', reader: { revision: '5', privateMode: true } }), false);
});

interface BrowserReplay {
  chromium: { launch(options: { channel?: string; timeout: number; args: string[] }): Promise<{
    newPage(options: { viewport: { width: number; height: number } }): Promise<{
      setContent(html: string): Promise<void>;
      addStyleTag(options: { content: string }): Promise<unknown>;
      addScriptTag(options: { content: string }): Promise<unknown>;
      locator(selector: string): { textContent(options: { timeout: number }): Promise<string | null> };
    }>;
    close(): Promise<void>;
  }> };
}

// Use an existing local browser installation without adding a runtime or dev dependency to Agent Lens.
const browserModule = process.env.AGENT_LENS_PLAYWRIGHT;
test('bundled webview preserves modal navigation, live anchors, and access invalidation in Chromium', {
  skip: !browserModule && 'Set AGENT_LENS_PLAYWRIGHT to an installed Playwright module for the offline DOM replay',
}, async () => {
  const { chromium } = require(browserModule!) as BrowserReplay;
  const replay = await build({ entryPoints: ['test/fixtures/agent-popup-replay.ts'], bundle: true,
    platform: 'browser', format: 'iife', target: 'es2023', write: false });
  const browser = await chromium.launch({ channel: process.env.AGENT_LENS_PLAYWRIGHT_CHANNEL, timeout: 15_000,
    args: ['--in-process-gpu', '--disable-gpu', '--disable-software-rasterizer', '--disable-background-networking'] });
  try {
    const page = await browser.newPage({ viewport: { width: 375, height: 800 } });
    await page.setContent('<div id="root"></div><div id="live" class="visually-hidden" role="status" aria-live="polite"></div>');
    for (const css of ['media/lens.css', 'media/panel.css', 'media/chat.css']) {
      await page.addStyleTag({ content: await readFile(css, 'utf8') });
    }
    await page.addStyleTag({ content: 'body { --vscode-font-family: sans-serif; --vscode-font-size: 13px; }' });
    await page.addScriptTag({ content: replay.outputFiles[0]!.text });
    equal(await page.locator('#replay-result').textContent({ timeout: 10_000 }), 'passed');
  } finally {
    await browser.close();
  }
});
