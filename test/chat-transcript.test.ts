import { deepEqual, equal, ok } from 'node:assert/strict';
import { test } from 'node:test';
import { adapters } from '../src/host/adapters/registry';
import { sourceSessionId } from '../src/host/sessions/evidence';
import { reduceSession } from '../src/host/sessions/reduce';
import { SessionStore } from '../src/host/sessions/store';
import type { FileAction, Lane, Session } from '../src/host/sessions/types';
import { agentOutputPageSize, diffLink, directAgentEdges, projectAgentActivity, projectTranscript, rootAgentEarlier } from '../src/host/views/chat-transcript';
import { buildDetail } from '../src/host/views/models';
import { claudeAgentReplay, codexAgentReplay, longCommandOutput } from './fixtures/agent-drilldown';
import type { AgentReplay } from './fixtures/agent-drilldown';
import { call, claudeSource, fixtureEvents, fixtureEvidence, instant, prompt, response, result } from './fixtures/session';

function session(): Session {
  const records = [
    prompt('u1', 'Fix it', 0),
    response('a1', 'u1', 10, [call('Bash', 'c1', { command: 'ls' }), call('Edit', 'c2', { file_path: 'a.ts', old_string: 'x', new_string: 'y' })]),
    result('r1', 'c1', 15, undefined, 'a1'),
    response('a2', 'r1', 30, 'All done', 'end_turn'),
  ];
  return reduceSession([fixtureEvidence(claudeSource(), records)], instant + 60)!.session;
}

const patch = '@@ -1,1 +1,1 @@\n-x\n+y\n';

test('tool activity folds into one block between prompt and reply with outcome and diff state', () => {
  const s = session();
  const tool = s.lanes[0]!.rows.find(row => row.kind === 'tool' && row.label === 'Edit');
  const action: FileAction = { id: 'f1', laneId: s.lanes[0]!.id, rowId: tool!.id, path: 'a.ts', label: 'Edit', kind: 'edit',
    status: 'requested', diff: patch, diffKind: 'hunks' };
  const detail = buildDetail(s, [s], { now: instant + 70, privateMode: false });
  const rows = projectTranscript(detail, [action], false);
  deepEqual(rows.map(row => row.role), ['user', 'tool', 'assistant']);
  const card = rows[1]!.card!;
  ok(card.entries!.length >= 2);
  ok(card.entries!.some(entry => entry.detail?.includes('Proposed change')));
  equal(card.diff?.length, 1);
  ok(card.diff![0]!.heading.startsWith('a.ts'));
  ok(rows[1]!.keys!.length >= 2);
});

test('private display hides diffs and output', () => {
  const s = session();
  const detail = buildDetail(s, [s], { now: instant + 70, privateMode: true });
  const rows = projectTranscript(detail, [], true);
  equal(rows.find(row => row.card)?.card?.diff, undefined);
});

test('an unresolved delegated agent keeps an observed position as a folded group', () => {
  const s = session();
  const main = s.lanes[0]!;
  const child = { ...main, id: 'child', title: 'Reviewer', parent: undefined, parentReason: 'Launch not recorded',
    rows: main.rows.map(row => ({ ...row, id: 'child-' + row.id, laneId: 'child' })) } as unknown as Lane;
  const withChild = { ...s, lanes: [main, child] };
  const detail = buildDetail(withChild, [withChild], { now: instant + 70, privateMode: false });
  const rows = projectTranscript(detail, [], false);
  const group = rows.filter(row => row.id.startsWith('agent:'));
  equal(group.length, 1);
  ok(group[0]!.card!.entries!.some(entry => entry.detail?.includes('Launch not recorded')));
});

test('full diff is offered only for an eligible recorded patch, otherwise the reason is shown', () => {
  const base = { id: 'a'.repeat(64), laneId: 'l', rowId: 'r', path: 'a.ts', label: 'Edit', kind: 'edit', status: 'applied' } as FileAction;
  equal(diffLink({ ...base, diff: patch, diffKind: 'hunks' }, false).request?.type, 'openDiff');
  ok(diffLink({ ...base }, false).reason);
  ok(diffLink({ ...base, diff: 'not a patch' }, false).reason);
  ok(diffLink({ ...base, diff: patch }, true).reason?.includes('private'));
});

test('agent group links reuse existing routes and show a reason when launch is unresolved', () => {
  const s = session();
  const main = s.lanes[0]!;
  const child = { ...main, id: 'child', title: 'Reviewer', parent: undefined, parentReason: 'Launch not recorded',
    rows: main.rows.map(row => ({ ...row, id: 'child-' + row.id, laneId: 'child' })) } as unknown as Lane;
  const withChild = { ...s, lanes: [main, child] };
  const detail = buildDetail(withChild, [withChild], { now: instant + 70, privateMode: false });
  const group = projectTranscript(detail, [], false).find(row => row.id.startsWith('agent:'))!;
  const links = group.card!.entries!.flatMap(entry => entry.links ?? []);
  deepEqual(links.map(link => link.label), ['Transcript', 'Files', 'Agent map', 'Launch evidence'].map((label, i) =>
    i === 0 && links[0]!.request ? 'Open transcript' : label));
  ok(links.find(link => link.label === 'Launch evidence')!.reason?.includes('Launch not recorded'));
});

test('a long history projects bounded output and wide tool output is clipped', () => {
  const rows: unknown[] = [prompt('u0', 'start', 0)];
  let parent = 'u0';
  for (let i = 1; i <= 700; i++) {
    const id = 'a' + i;
    rows.push(response(id, parent, i * 10, [call('Bash', 'c' + i, { command: 'x'.repeat(5000) })]));
    rows.push(result('r' + i, 'c' + i, i * 10 + 5, undefined, id));
    parent = 'r' + i;
  }
  rows.push(response('end', parent, 99999, 'done', 'end_turn'));
  const s = reduceSession([fixtureEvidence(claudeSource(), rows)], instant + 100000)!.session;
  const detail = buildDetail(s, [s], { now: instant + 100000, privateMode: false });
  const out = projectTranscript(detail, [], false);
  ok(out.length < 10);
  const fold = out.find(row => row.card)!.card!;
  ok(fold.entries!.length <= 40);
  ok(fold.message);
  for (const entry of fold.entries!) ok((entry.detail ?? '').length < 400);
});

test('a newly reconciled child row keeps its group position', () => {
  const s = session();
  const main = s.lanes[0]!;
  const mk = (resolved: boolean) => {
    const spawnRow = main.rows.find(row => row.kind === 'tool')!;
    const child = { ...main, id: 'child', title: 'Reviewer', rows: main.rows.map(row => ({ ...row, id: 'child-' + row.id, laneId: 'child' })),
      parent: resolved ? { sessionId: s.id, laneId: main.id, rowId: spawnRow.id, relation: 'agent' } : undefined,
      parentReason: resolved ? undefined : 'Launch not recorded' } as unknown as Lane;
    const x = { ...s, lanes: [main, child] };
    return projectTranscript(buildDetail(x, [x], { now: instant + 70, privateMode: false }), [], false);
  };
  const before = mk(false).map(row => row.id).filter(id => id.startsWith('agent:'));
  const after = mk(true).map(row => row.id).filter(id => id.startsWith('agent:'));
  deepEqual(after, before);
  equal(mk(true).filter(row => row.id.startsWith('agent:')).length, 1);
});

const drilldownOptions = { now: instant + 12_000, privateMode: false };
const mainScope = (s: Session) => ({ sessionId: s.id, laneId: s.lanes[0]!.id });

test('Claude replay keeps a verified pending block and opens two nested sibling histories independently', () => {
  const { root, children } = claudeAgentReplay();
  const pending = reduceSession([fixtureEvidence(...root)], drilldownOptions.now)!.session;
  const first = directAgentEdges([pending], mainScope(pending))[0]!;
  equal(first.pending, true);
  const waiting = projectAgentActivity([pending], first, drilldownOptions);
  equal(waiting.state, 'waiting');
  equal(waiting.rows.find(row => row.kind === 'delegatedPrompt')?.text, 'Review the export changes.');

  const recorded = reduceSession([root, ...children].map(entry => fixtureEvidence(...entry)), drilldownOptions.now)!.session;
  const sessions = [recorded];
  const edge = directAgentEdges(sessions, mainScope(recorded))[0]!;
  equal(edge.id, first.id);
  equal(edge.pending, undefined);
  const view = projectAgentActivity(sessions, edge, { ...drilldownOptions, issueEdge: child => child.id });
  deepEqual(view.rows.filter(row => row.kind === 'prompt' || row.kind === 'delegatedPrompt').map(row => row.text), ['Review the export changes.']);
  const blocks = view.rows.flatMap(row => row.children ?? []);
  deepEqual(blocks.map(child => child.label), ['Schema', 'Errors']);
  const nested = directAgentEdges(sessions, edge.target);
  deepEqual(nested.map(child => child.id), blocks.map(child => child.ref));

  const schema = projectAgentActivity(sessions, nested[0]!, { ...drilldownOptions, issueOutput: id => id });
  const read = schema.rows.find(row => row.tool?.input?.includes('schema.ts'))!;
  equal(read.tool?.input, 'schema.ts\nOffset 2\nLimit 5');
  equal(read.tool?.stdout?.length, agentOutputPageSize);
  equal(read.tool?.outputTruncated, undefined);
  equal(read.tool?.outputRef, read.id);
  equal(schema.rows.find(row => row.kind === 'final')?.text, 'Schema review completed.');
  ok(schema.rows.some(row => row.kind === 'commentary' && row.text?.includes('schema progress')));
  const expanded = projectAgentActivity(sessions, nested[0]!, { ...drilldownOptions, outputLimits: new Map([[read.id, 12_000]]) });
  equal(expanded.rows.find(row => row.id === read.id)?.tool?.stdout, longCommandOutput);

  const errors = projectAgentActivity(sessions, nested[1]!, drilldownOptions);
  equal(errors.rows.find(row => row.kind === 'delegatedPrompt')?.text, 'Inspect the errors.');
  equal(errors.rows.find(row => row.kind === 'prompt')?.text, 'Check how exports report errors.');
  equal(errors.finalMissing, true);
  ok(!JSON.stringify(errors).includes('Schema review completed.'));

  const privateView = projectAgentActivity(sessions, edge, { ...drilldownOptions, privateMode: true, issueEdge: child => child.id });
  equal(privateView.state, 'private');
  deepEqual(privateView.rows.flatMap(row => row.children ?? []).map(child => [child.label, child.ref]),
    blocks.map(child => ['Agent', child.ref]));
  ok(!JSON.stringify(privateView).includes('export changes'));
  ok(!JSON.stringify(privateView).includes('openTranscript'));
});

test('Codex replay scopes two launches to their exact turns and traverses two siblings and a deeper grandchild', async () => {
  const { root, run, children } = codexAgentReplay();
  const store = new SessionStore(undefined, () => drilldownOptions.now);
  for (const adapter of adapters) {
    const entries = [root, run, ...children].filter(([source]) => source.provider === adapter.id);
    store.setCatalog(adapter.id, adapter, new Map(entries.map(([source]) => [source.key, source])));
    for (const [source, records] of entries) {
      const events = fixtureEvents(source, records);
      store.ingest({ source, events, readerEpoch: 1, generation: 1, committed: events.length,
        reset: true, more: false, diagnostics: { malformed: 0, unknown: 0, oversized: 0 } });
    }
  }
  const sessions = await store.sessions();
  const main = sessions.find(session => session.id === sourceSessionId(root[0]))!;
  const codex = sessions.filter(session => session.id === sourceSessionId(run[0]));
  equal(codex.length, 1);
  const edges = directAgentEdges(sessions, mainScope(main));
  equal(edges.length, 2);
  const detail = buildDetail(main, sessions, drilldownOptions);
  const cards = projectTranscript(detail, main.files, false, { sessions, now: drilldownOptions.now, issueEdge: edge => edge.id })
    .flatMap(row => row.delegation ?? []);
  equal(cards.length, 2);
  const fresh = edges.find(edge => codex[0]?.lanes[0]?.turns.find(turn => turn.id === edge.target.turnId)?.nativeId === 'fresh-turn')!;
  const resumed = edges.find(edge => edge.id !== fresh.id)!;
  ok(fresh.target.turnId && resumed.target.turnId && fresh.target.turnId !== resumed.target.turnId);
  deepEqual(cards.map(card => card.links?.find(link => link.request?.type === 'goto')?.request), [fresh, resumed].map(edge => ({
    type: 'goto', session: edge.parent.sessionId, lane: edge.parent.laneId, row: edge.rowId,
  })));

  const current = projectAgentActivity(sessions, fresh, { ...drilldownOptions, issueEdge: edge => edge.id });
  deepEqual(current.rows.filter(row => row.kind === 'prompt' || row.kind === 'commentary' || row.kind === 'final').map(row => row.text),
    ['Fresh export checks', 'I will divide the checks.', 'Fresh checks passed.']);
  const childrenOfFresh = directAgentEdges(sessions, fresh.target);
  deepEqual(current.rows.flatMap(row => row.children ?? []).map(child => child.ref), childrenOfFresh.map(edge => edge.id));
  equal(childrenOfFresh.length, 2);
  const following = projectAgentActivity(sessions, resumed, drilldownOptions);
  deepEqual(following.rows.map(row => row.text), ['Resume the exported checks', 'Follow-up complete.']);
  equal(directAgentEdges(sessions, resumed.target).length, 0);

  for (const [index, edge] of childrenOfFresh.entries()) {
    const expected = index === 0 ? 'Test checks' : 'API checks';
    const child = projectAgentActivity(sessions, edge, drilldownOptions);
    equal(child.historyPartial, true);
    const ownTool = child.rows.find(row => row.kind === 'tool')?.tool;
    equal(ownTool?.input, 'npm test');
    equal(ownTool?.stdout, expected + ' output');
    equal(ownTool?.stderr, 'Recorded diagnostic');
    equal(ownTool?.exitCode, 0);
    equal(ownTool?.durationMs, 1_000);
    equal(child.rows.find(row => row.kind === 'message')?.text, expected + ' message');
    equal(child.rows.find(row => row.kind === 'final')?.text, expected + ' final');
    ok(!JSON.stringify(child).includes('Inherited parent instructions'));
    ok(!JSON.stringify(child).includes('Opaque message body'));
  }
  const deeper = directAgentEdges(sessions, childrenOfFresh[0]!.target);
  equal(deeper.length, 1);
  equal(projectAgentActivity(sessions, deeper[0]!, drilldownOptions).rows.find(row => row.kind === 'final')?.text, 'Deep checks final');
});

test('scope filtering precedes transcript paging and earlier activity is relative to the mounted anchor', () => {
  const { root, children } = claudeAgentReplay();
  const session = reduceSession([root, ...children].map(entry => fixtureEvidence(...entry)), drilldownOptions.now)!.session;
  const main = session.lanes[0]!;
  const reviewer = directAgentEdges([session], mainScope(session))[0]!;
  const edge = directAgentEdges([session], reviewer.target)[0]!;
  const schema = session.lanes.find(lane => lane.id === edge.target.laneId)!;
  const rows = (lane: Lane, count: number, prefix: string) => Array.from({ length: count }, (_, index) => ({
    id: prefix + index, laneId: lane.id, kind: 'assistant' as const, label: 'Message', text: prefix + index,
  }));
  main.rows.push(...rows(main, 1_520, 'main-tail-'));
  schema.rows.push(...rows(schema, 250, 'schema-tail-'));
  const initial = projectAgentActivity([session], edge, { ...drilldownOptions, limit: 100 });
  equal(initial.rows.length, 100);
  const anchor = initial.rows[0]!.id;
  schema.rows.push(...rows(schema, 120, 'new-schema-tail-'));
  const earlier = projectAgentActivity([session], edge, { ...drilldownOptions, limit: 200, startRow: anchor, earlierRows: 100 });
  equal(earlier.rows[0]?.id, 'schema-tail-50');
  equal(earlier.rows.filter(row => row.id === anchor).length, 1);
  ok(!earlier.rows.some(row => row.id.startsWith('main-tail-')));
  const snap = main.rows.find(row => row.id === 'main-tail-105')!;
  equal(rootAgentEarlier([session], mainScope(session), 1_500, snap.id), true);
  equal(rootAgentEarlier([session], mainScope(session), 3_000, snap.id), false);
  equal(rootAgentEarlier([session], mainScope(session), 1_500, 'removed-anchor'), false);
  const latest = buildDetail(session, [session], drilldownOptions);
  ok(!latest.rows.some(row => row.id === reviewer.rowId));
  const focused = buildDetail(session, [session], { ...drilldownOptions, focus: { lane: main.id, row: reviewer.rowId } });
  ok(focused.rows.some(row => row.id === reviewer.rowId && row.laneId === main.id));
  ok(focused.note?.includes('Newer events are outside this window'));
  const wrongLane = buildDetail(session, [session], { ...drilldownOptions, focus: { lane: schema.id, row: reviewer.rowId } });
  ok(!wrongLane.rows.some(row => row.id === reviewer.rowId));
});
