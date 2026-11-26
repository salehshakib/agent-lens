import type { AgentActivityRow, AgentBreadcrumb, AgentDelegation, AgentPopup, AgentReader, ChatRow, HostMessage, PanelRequest } from '../../src/shared/protocol';

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function get<T extends Element = HTMLElement>(selector: string, root: ParentNode = document): T {
  const element = root.querySelector<T>(selector);
  check(element, `Missing ${selector}`);
  return element;
}

const ref = (character: string) => character.repeat(64);

function delegation(id: string, label: string, key: string): AgentDelegation {
  return { id, label, ref: ref(key), provider: 'Claude Code', status: 'Running', tone: 'live' };
}

function send(message: HostMessage): void {
  window.dispatchEvent(new MessageEvent('message', { data: message }));
}

async function replay(): Promise<void> {
  const posts: PanelRequest[] = [];
  Object.assign(window, { acquireVsCodeApi: () => ({
    postMessage: (request: PanelRequest) => posts.push(request), getState: () => undefined, setState: () => undefined,
  }) });
  await import('../../src/webview/panel.js');

  const reviewer = delegation('reviewer', 'Reviewer', 'a');
  const child = delegation('schema', 'Schema', 'b');
  const sibling = delegation('errors', 'Errors', 'c');
  const rootCrumb: AgentBreadcrumb = { id: 'main', label: 'Main Claude', ref: ref('d') };
  const reviewerCrumb: AgentBreadcrumb = { id: reviewer.id, label: reviewer.label };
  const activity: AgentActivityRow[] = [
    { id: 'prompt', kind: 'prompt', label: 'Prompt', text: 'Review changes' },
    { id: 'spawn-1', kind: 'tool', label: 'Agent', children: [child],
      tool: { input: 'Inspect schema', stdout: 'SCRUBBED OUTPUT', outputRef: ref('e') } },
    { id: 'spawn-2', kind: 'tool', label: 'Agent', children: [sibling], tool: { input: 'Inspect errors' } },
  ];
  const reviewerPopup: AgentPopup = { id: reviewer.id, agent: reviewer, state: 'ready', rows: activity,
    breadcrumbs: [rootCrumb, reviewerCrumb] };
  const childPopup = (agent: AgentDelegation, state: AgentPopup['state'], rows: AgentActivityRow[] = []): AgentPopup => ({
    id: agent.id, agent, state, rows,
    breadcrumbs: [rootCrumb, { ...reviewerCrumb, ref: ref('f') }, { id: agent.id, label: agent.label }],
  });
  const chatRows: ChatRow[] = [
    ...Array.from({ length: 60 }, (_, index): ChatRow => ({ id: 'before-' + index, role: 'assistant', text: 'Root transcript ' + index })),
    { id: 'launch', role: 'tool', text: 'Agent launched', delegation: reviewer },
    { id: 'after', role: 'assistant', text: 'Still working' },
  ];
  const sendChat = (reader: AgentReader, rows = chatRows) => send({ type: 'panel', reader, model: { mode: 'chat', chat: {
    key: 'main', title: 'Main Claude', provider: 'Claude Code', rows, draft: 'Original draft', revision: 0, state: 'working',
    canSend: true, canContinue: false, canInterrupt: true, canRetry: false, canChooseScope: false, privateMode: reader.privateMode,
  } } });
  const reader = (revision: number, popup?: AgentPopup, extra: Partial<AgentReader> = {}) =>
    send({ type: 'agentReader', reader: { revision, popup, privateMode: false, ...extra } });
  sendChat({ revision: 0, privateMode: false, earlier: true });

  const root = get('.chat-pane');
  const scroll = get('.chat-scroll', root);
  const draft = get<HTMLTextAreaElement>('textarea', root);
  draft.value = 'Unsent typed draft';
  draft.dispatchEvent(new InputEvent('input', { inputType: 'insertText' }));
  const launch = get('button[data-agent="reviewer"]', root);
  launch.focus();
  scroll.scrollTop = 160;
  const savedScroll = scroll.scrollTop;
  launch.click();
  const enter = posts.at(-1);
  check(enter?.type === 'agentEnter' && enter.revision === 0 && enter.ref === reviewer.ref, 'Root must enter by offered reference');
  reader(1, reviewerPopup);
  const dialog = get<HTMLDialogElement>('dialog[open]');
  check(dialog.matches(':modal'), 'Reader must be a native modal');
  check(document.activeElement === get('h2', dialog), 'Open must focus the heading');
  check(root.isConnected && draft.value === 'Unsent typed draft' && scroll.scrollTop === savedScroll, 'Root, draft and scroll must survive open');
  const readerScroll = get('.agent-popup-scroll', dialog);
  readerScroll.focus();
  readerScroll.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
  check(dialog.contains(document.activeElement), 'Tab must remain inside the modal');
  const tool = () => get<HTMLDetailsElement>('[data-row="spawn-1"] details', dialog);
  get('summary', tool()).click();
  get('summary', tool()).focus();
  get('[data-key="output:spawn-1"]', dialog).click();
  check(posts.at(-1)?.type === 'agentOutput', 'Output paging must use the reader route');
  const expanded = { ...reviewerPopup, rows: activity.map(row => row.id === 'spawn-1'
    ? { ...row, tool: { ...row.tool, stdout: 'SCRUBBED OUTPUT\nMore retained' } } : row) };
  reader(2, expanded);
  check(tool().open && document.activeElement === get('summary', tool()), 'Live output must preserve open disclosures and focus');

  get('button[data-agent="schema"]', dialog).click();
  const childEnter = posts.at(-1);
  check(childEnter?.type === 'agentEnter' && childEnter.ref === child.ref, 'Child must enter by its own offer');
  reader(3, childPopup(child, 'ready', [{ id: 'message', kind: 'message', label: 'Agent message', text: 'Schema reviewed' }]));
  check(document.querySelectorAll('dialog[open]').length === 1 && get('dialog[open]') === dialog, 'Nested navigation must reuse one modal');
  check(get('h2', dialog).textContent === 'Schema', 'The selected child must have its own heading');
  get('[data-key="agent-back"]', dialog).click();
  check(posts.at(-1)?.type === 'agentBack', 'Back must use scoped navigation');
  reader(4, expanded, { returnTo: child.id });
  check(document.activeElement === get('button[data-agent="schema"]', dialog) && tool().open, 'Back must restore spawn focus and fold');
  get('button[data-agent="errors"]', dialog).click();
  reader(5, childPopup(sibling, 'waiting'));
  check(dialog.textContent?.includes('Waiting for transcript'), 'Pending sibling must keep its waiting state');

  sendChat({ revision: 5, privateMode: false, popup: childPopup(sibling, 'waiting') }, [...chatRows,
    { id: 'approval', role: 'tool', text: '', approval: { id: ref('1'), toolName: 'Test', preview: 'Bounded input', state: 'pending' } },
  ]);
  check(!get('.agent-popup-approval', dialog).hidden, 'Approval waiting must be visible in the popup');
  get('[data-key="agent-approval"]', dialog).click();
  check(!dialog.open && document.activeElement?.closest('.chat-approval'), 'Approvals must return focus to the root card');
  reader(6, undefined, { returnTo: reviewer.id });

  launch.focus();
  const beforeEscape = scroll.scrollTop;
  launch.click();
  reader(7, expanded);
  const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  draft.dispatchEvent(escape);
  check(!dialog.open && escape.defaultPrevented && document.activeElement === launch && scroll.scrollTop === beforeEscape,
    'Escape must close and return focus without scrolling the root');
  check(!posts.some(request => request.type === 'chatInterrupt'), 'Escape in the reader must leave the turn running');
  reader(8);
  launch.click();
  reader(9, expanded);
  const bounds = dialog.getBoundingClientRect();
  check(Math.abs(bounds.left - 8) <= 1 && Math.abs(bounds.top - 8) <= 1, 'A 375px split must leave an 8px modal margin');
  const backdrop = { clientX: bounds.left - 2, clientY: bounds.top - 2, bubbles: true };
  dialog.dispatchEvent(new PointerEvent('pointerdown', backdrop));
  dialog.dispatchEvent(new MouseEvent('click', backdrop));
  check(!dialog.open && document.activeElement === launch, 'Backdrop must close and restore launch focus');

  reader(10);
  launch.click();
  reader(11, expanded);
  get('summary', tool()).click();
  check(dialog.textContent?.includes('SCRUBBED OUTPUT'), 'Recorded output should have rendered before invalidation');
  const neutral = { ...reviewer, label: 'Agent' };
  reader(12, { ...reviewerPopup, agent: neutral, state: 'private', rows: [],
    breadcrumbs: [rootCrumb, { id: neutral.id, label: neutral.label }] }, { privateMode: true, invalidate: true });
  check(dialog.open && dialog.textContent?.includes('Activity hidden in private display'), 'Private display must preserve the modal shell');
  check(!root.querySelector('[data-agent="reviewer"]') && !draft.value, 'Invalidation must purge previously rendered root content');
  reader(11, expanded);
  check(!dialog.textContent?.includes('SCRUBBED OUTPUT'), 'A stale response must not restore private evidence');

  reader(13, undefined, { privateMode: true });
  sendChat({ revision: 14, privateMode: false, earlier: true });
  const liveLaunch = get('button[data-agent="reviewer"]', root);
  liveLaunch.click();
  const feed = (prefix: string, length: number): AgentActivityRow[] => Array.from({ length }, (_, index) => ({
    id: prefix + index, kind: 'message', label: 'Agent message', text: 'Recorded event ' + index,
  }));
  const live = feed('live-', 90);
  const note: AgentActivityRow = { id: 'scope-note', kind: 'notice', label: 'Launch unresolved', synthetic: true };
  reader(15, { ...reviewerPopup, rows: [...live, note], earlier: true });
  readerScroll.scrollTop = 200;
  readerScroll.dispatchEvent(new Event('scroll'));
  const anchor = get('[data-row="live-4"]', readerScroll).getBoundingClientRect().top;
  const next = [...live, ...feed('new-', 1), note];
  reader(15, { ...reviewerPopup, rows: next, earlier: true });
  check(get('.agent-popup-jump', dialog).textContent === 'Jump to latest (1 new)', 'Live arrivals must count ahead of a synthetic notice');
  get('[data-key="agent-earlier"]', dialog).click();
  const earlier = posts.at(-1);
  check(earlier?.type === 'agentEarlier' && earlier.revision === 15, 'Earlier paging must use the current reader revision');
  const paged = { ...reviewerPopup, rows: [...feed('older-', 15), ...next] };
  reader(16, paged);
  check(Math.abs(get('[data-row="live-4"]', readerScroll).getBoundingClientRect().top - anchor) < 1, 'Earlier and live updates must preserve the reader anchor');
  check(get('.agent-popup-jump', dialog).textContent === 'Jump to latest (1 new)', 'Older rows must not bump unread count');
  get('[data-key="agent-back"]', dialog).click();
  check(!dialog.open && document.activeElement === liveLaunch && posts.at(-1)?.type === 'agentBack', 'First-level Back must close and restore focus');
  reader(17, paged);
  check(!dialog.open && posts.at(-1)?.type === 'agentClose', 'An in-flight model update must not reopen a dismissed modal');

  reader(18);
  liveLaunch.click();
  reader(19, expanded);
  get('button[data-agent="schema"]', dialog).click();
  reader(20, childPopup(child, 'ready'));
  const parent = [...dialog.querySelectorAll<HTMLButtonElement>('nav button')].find(button => button.textContent === 'Reviewer');
  check(parent, 'Parent breadcrumb must be independently reachable');
  parent.click();
  const jump = posts.at(-1);
  check(jump?.type === 'agentJump' && jump.ref === ref('f'), 'Breadcrumb must use its own offered path reference');
  reader(21, expanded, { returnTo: child.id });
  reader(22, { ...expanded, state: 'sourceUnavailable' }, { invalidate: true });
  check(dialog.open && dialog.textContent?.includes('Source unavailable'), 'Source loss must retain the dialog and Back');
  check(!dialog.textContent?.includes('SCRUBBED OUTPUT') && !dialog.querySelector('button[data-agent="schema"]'),
    'Source loss must clear prior tool and child controls');
}

void replay().then(() => 'passed', (error: unknown) => String(error)).then(result => {
  const node = document.createElement('output');
  node.id = 'replay-result';
  node.textContent = result;
  document.body.append(node);
});
