import { createHmac, randomBytes } from 'node:crypto';
import { ViewColumn, window } from 'vscode';
import type { Disposable, Uri, WebviewPanel } from 'vscode';
import { parsePanelRequest } from '../../shared/protocol';
import type { AgentBreadcrumb, AgentReader, HostMessage, PanelModel, PanelRequest, PanelTab, RelayCommand, UsageFilters } from '../../shared/protocol';
import { agentScopeKey } from './data';
import type { AgentGraph, LensData, RootAgentProjection } from './data';
import { agentIdentity, agentOutputPageSize, agentPageSize, agentRootPageSize, projectAgentActivity, rootAgentEarlier } from './chat-transcript';
import type { AgentEdge, AgentScope } from './chat-transcript';
import { providerLabels } from './models';
import { render, resourceRoots } from './html';

type Focus = { lane: string; row: string };
type FilesFocus = Extract<HostMessage, { type: 'panel' }>['files'];
export type ChatPanelRequest = Extract<PanelRequest, { type: `chat${string}` }>;
type AgentRequest = Extract<PanelRequest, { type: `agent${string}` }>;
export type PanelTarget =
  | { kind: 'chat'; key: string; id?: string; tab?: PanelTab; focus?: Focus; from?: string; files?: FilesFocus }
  | { kind: 'usage' }
  | { kind: 'tasks' };

export interface PanelActions {
  chat(key: string, id?: string, reader?: RootAgentProjection): Promise<PanelModel>;
  frozenHistoryStart(key: string): string | null | undefined;
  agentSource(scope: AgentScope): Promise<'readable' | 'missing' | 'unavailable'>;
  materializeAgent(scope: AgentScope, ancestors: readonly AgentScope[], current: () => boolean, verify: () => Promise<boolean>): Promise<void>;
  keepAgentHistory(key: string, path: readonly AgentScope[]): void;
  chatRequest(key: string, request: ChatPanelRequest, id?: string): void;
  sessionId(key: string): string | undefined;
  openSession(id: string, tab: PanelTab, focus?: Focus, from?: string): void;
  openFile(id: string): void;
  openDiff(id: string): void;
  openTranscript(session: string, lane: string): void;
  openParent(session: string, lane: string, from?: string): void;
  openSettings(): void;
  relay(command: RelayCommand, profile: string): void;
  visibility(visible: boolean): void;
}

interface Editor {
  key: string;
  panel: WebviewPanel;
  target: PanelTarget;
  ready: boolean;
  sequence: number;
  timer?: NodeJS.Timeout;
  tab?: PanelTab;
  focus?: Focus;
  detailFocus?: Focus;
  files?: FilesFocus;
  back?: string;
  usageFilters: UsageFilters;
  reader: ReaderState;
}

interface AgentFrame {
  edge: AgentEdge;
  limit: number;
  startRow?: string;
  earlierRows?: number;
  outputs: Map<string, number>;
  sourceSeen: boolean;
  attempted?: boolean;
}

interface ReaderOffers {
  edges: Map<string, AgentEdge>;
  ancestors: Map<string, number>;
  outputs: Map<string, string>;
  earlier: boolean;
  rootEarlier: boolean;
}

interface ReaderState {
  secret: Buffer;
  revision: number;
  selection: number;
  privateMode: boolean;
  rootId?: string;
  root?: AgentScope;
  rootLimit: number;
  loadEarlier: boolean;
  frames: AgentFrame[];
  offers: ReaderOffers;
  loading: boolean;
  unavailable: boolean;
  returnTo?: string;
}

function emptyOffers(): ReaderOffers {
  return { edges: new Map(), ancestors: new Map(), outputs: new Map(), earlier: false, rootEarlier: false };
}

function compatibleAgentEdge(offered: AgentEdge, observed: AgentEdge): boolean {
  return offered.id === observed.id && offered.relation === observed.relation && offered.rowId === observed.rowId
    && agentScopeKey(offered.parent) === agentScopeKey(observed.parent)
    && (agentScopeKey(offered.target) === agentScopeKey(observed.target)
      || offered.relation === 'agent' && offered.pending === true && !observed.pending
        && offered.target.sessionId === observed.target.sessionId);
}

const defaultUsage: UsageFilters = { range: '30', project: '', adapter: '' };
const refreshDelay = 100;

/** Editors own view state. Conversation and worker state live independently in the host. */
export class PanelView {
  static readonly viewType = 'agentLens.panel';
  private readonly editors = new Map<string, Editor>();

  constructor(private readonly extensionUri: Uri, private readonly data: LensData, private readonly actions: PanelActions) {}

  private key(target: PanelTarget): string {
    return target.kind === 'chat' ? target.key : target.kind;
  }

  show(target: PanelTarget): void {
    const key = this.key(target);
    const existing = this.editors.get(key);
    if (existing) {
      if (target.kind === 'chat') {
        existing.target = target;
        existing.tab = target.tab;
        existing.focus = target.focus;
        if (target.tab !== undefined) existing.detailFocus = target.tab === 'timeline' ? target.focus : undefined;
        existing.files = target.files;
        if (target.from && target.from !== key) existing.back = target.from;
      }
      this.reveal(existing);
      return;
    }
    const panel = window.createWebviewPanel(PanelView.viewType, this.title(target), ViewColumn.Active, {
      enableScripts: true, retainContextWhenHidden: true, localResourceRoots: resourceRoots(this.extensionUri),
    });
    this.attach(panel, target);
  }

  restore(panel: WebviewPanel, target: PanelTarget): void {
    const existing = this.editors.get(this.key(target));
    if (existing) {
      panel.dispose();
      return;
    }
    panel.webview.options = { enableScripts: true, localResourceRoots: resourceRoots(this.extensionUri) };
    this.attach(panel, target);
  }

  private reveal(editor: Editor): void {
    editor.panel.reveal(editor.panel.viewColumn ?? ViewColumn.Active, false);
    this.refresh(editor);
  }

  private attach(panel: WebviewPanel, target: PanelTarget): void {
    const key = this.key(target);
    const editor: Editor = { key, panel, target, ready: false, sequence: 0, usageFilters: defaultUsage, reader: {
      secret: randomBytes(32), revision: 0, selection: 0, privateMode: this.data.privateDisplay(), rootLimit: agentRootPageSize,
      loadEarlier: false, frames: [], offers: emptyOffers(), loading: false, unavailable: false,
    } };
    if (target.kind === 'chat') {
      editor.tab = target.tab;
      editor.focus = target.focus;
      editor.detailFocus = target.tab === 'timeline' ? target.focus : undefined;
      editor.files = target.files;
      if (target.from !== key) editor.back = target.from;
    }
    this.editors.set(key, editor);
    this.visibility();
    const listeners: Disposable[] = [
      panel.webview.onDidReceiveMessage((message: unknown) => this.handle(editor, message)),
      panel.onDidChangeViewState(() => {
        this.visibility();
        this.updatePins(editor);
        if (panel.visible) this.refresh(editor);
      }),
      panel.onDidDispose(() => {
        for (const listener of listeners) listener.dispose();
        clearTimeout(editor.timer);
        this.editors.delete(key);
        this.actions.keepAgentHistory(key, []);
        this.visibility();
        this.update();
      }),
    ];
    panel.webview.html = render(panel.webview, this.extensionUri, {
      title: 'Agent Lens', script: 'panel.js', styles: ['lens.css', 'panel.css', 'chat.css'],
      body: '<div id="root"></div><div id="live" class="visually-hidden" role="status" aria-live="polite"></div>',
    });
  }

  private visibility(): void {
    this.actions.visibility([...this.editors.values()].some(editor => editor.panel.visible));
  }

  private title(target: PanelTarget): string {
    switch (target.kind) {
      case 'usage': return 'Agent Lens: Usage';
      case 'tasks': return 'Agent Lens: Background tasks';
      case 'chat': return target.id ? 'Agent Lens: Session' : 'Agent Lens: New chat';
    }
  }

  private sessionId(editor: Editor): string | undefined {
    return editor.target.kind === 'chat' ? this.actions.sessionId(editor.key) ?? editor.target.id : undefined;
  }

  private handle(editor: Editor, message: unknown): void {
    const request = parsePanelRequest(message);
    if (!request || this.editors.get(editor.key) !== editor) return;
    switch (request.type) {
      case 'ready':
        editor.ready = true;
        this.refresh(editor);
        break;
      case 'chatDraft': case 'chatSend': case 'chatContinue': case 'chatInterrupt': case 'chatRetry': case 'chatChooseScope':
      case 'chatCardAction': case 'chatApproval':
        if (editor.target.kind === 'chat') this.actions.chatRequest(editor.key, request, this.sessionId(editor));
        break;
      case 'agentEnter': case 'agentJump': case 'agentBack': case 'agentClose': case 'agentEarlier': case 'agentOutput':
        if (editor.target.kind === 'chat' && editor.panel.visible) this.handleAgent(editor, request);
        break;
      case 'openFile': this.actions.openFile(request.id); break;
      case 'openDiff': this.actions.openDiff(request.id); break;
      case 'openTranscript': this.actions.openTranscript(request.session, request.lane); break;
      case 'openSession': this.actions.openSession(request.id, 'chat', undefined, editor.key); break;
      case 'openSessionView': this.actions.openSession(request.session, request.tab, undefined, editor.key); break;
      case 'goto': this.actions.openSession(request.session, 'timeline',
        request.lane || request.row ? { lane: request.lane, row: request.row } : undefined, editor.key); break;
      case 'openParent': this.actions.openParent(request.session, request.lane, editor.key); break;
      case 'panelBack': {
        const back = editor.back && this.editors.get(editor.back);
        editor.back = undefined;
        if (back) this.reveal(back);
        break;
      }
      case 'openSettings': this.actions.openSettings(); break;
      case 'usageFilters':
        editor.usageFilters = request.filters;
        this.refresh(editor);
        break;
      case 'relay': this.actions.relay(request.command, request.profile); break;
    }
  }

  /** The active editor's recorded session, for the Open parent command. */
  currentSession(): { id: string; key: string } | undefined {
    const editor = [...this.editors.values()].find(item => item.panel.active);
    const id = editor && this.sessionId(editor);
    return editor && id ? { id, key: editor.key } : undefined;
  }

  update(key?: string): void {
    const editors = key ? [this.editors.get(key)] : this.editors.values();
    for (const editor of editors) {
      if (!editor?.panel.visible || !editor.ready || editor.timer) continue;
      editor.timer = setTimeout(() => {
        editor.timer = undefined;
        this.refresh(editor);
      }, refreshDelay);
    }
  }

  private reference(editor: Editor, kind: string, id: string): string {
    return createHmac('sha256', editor.reader.secret).update(JSON.stringify([editor.reader.rootId, kind, id])).digest('hex');
  }

  private advanceReader(editor: Editor): void {
    editor.reader.revision++;
    editor.reader.offers = emptyOffers();
    editor.sequence++;
  }

  private updatePins(editor: Editor): void {
    const { root, frames } = editor.reader;
    this.actions.keepAgentHistory(editor.key, root && frames.length && editor.panel.visible && !editor.reader.unavailable
      ? [root, ...frames.map(frame => frame.edge.target)] : []);
  }

  private async sourcesFor(editor: Editor, graph: AgentGraph): Promise<boolean> {
    const { frames, selection } = editor.reader;
    if (!graph.root || graph.edges.length !== frames.length || graph.edges.some((edge, index) =>
      !compatibleAgentEdge(frames[index]!.edge, edge))) return false;
    const states = await Promise.all([graph.root, ...graph.edges.map(edge => edge.target)].map(scope => this.actions.agentSource(scope)));
    if (states[0] !== 'readable' || selection !== editor.reader.selection) return false;
    return frames.every((frame, index) => {
      const state = states[index + 1];
      frame.edge = graph.edges[index]!;
      if (state === 'readable') {
        frame.sourceSeen = true;
        return true;
      }
      return state === 'missing' && !frame.sourceSeen && index === states.length - 2;
    });
  }

  private postReader(editor: Editor, reader: AgentReader): void {
    if (!editor.ready) return;
    const message: HostMessage = { type: 'agentReader', reader };
    void editor.panel.webview.postMessage(message);
  }

  private placeholders(editor: Editor, offers: ReaderOffers): AgentBreadcrumb[] {
    const { frames } = editor.reader;
    const id = this.reference(editor, 'root', 'main');
    offers.ancestors.set(id, 0);
    return [{ id, label: frames[0]?.edge.relation === 'child' ? 'Main Codex' : 'Main Claude', ref: id }, ...frames.map(({ edge }, index) => {
      const ref = index === frames.length - 1 ? undefined : this.reference(editor, 'ancestor', edge.id);
      if (ref) offers.ancestors.set(ref, index + 1);
      return { id: edge.id, label: edge.relation === 'launch' ? 'Linked run' : 'Agent', ref };
    })];
  }

  private unavailableReader(editor: Editor, offers: ReaderOffers, state: 'sourceUnavailable' | 'private' | 'loading'): AgentReader {
    const { revision, privateMode, frames, returnTo } = editor.reader;
    const frame = frames.at(-1);
    if (!frame) return { revision, privateMode, returnTo };
    const provider = providerLabels[frame.edge.relation === 'agent' ? 'claude-code' : 'codex'];
    return { revision, privateMode, returnTo, popup: { id: frame.edge.id, state, rows: [],
      agent: { label: frame.edge.relation === 'launch' ? 'Linked run' : 'Agent', provider, status: 'Outcome unknown', tone: 'neutral' },
      breadcrumbs: this.placeholders(editor, offers) } };
  }

  /** Clear visible and parked reader content immediately, including editors that are hidden. */
  invalidateAgentReaders(sourceChanged = false): void {
    for (const editor of this.editors.values()) {
      if (editor.target.kind === 'chat') this.invalidateReader(editor, sourceChanged);
    }
  }

  /** A catalog change can revoke a source while its editor is parked. */
  verifyParkedAgentSources(): void {
    for (const editor of this.editors.values()) {
      const { rootId, frames, selection, unavailable } = editor.reader;
      if (!rootId || !frames.length || unavailable || editor.panel.visible) continue;
      void this.data.agentGraph(rootId, frames.map(frame => frame.edge.id)).then(graph => this.sourcesFor(editor, graph)).then(available => {
        if (!available && this.editors.get(editor.key) === editor && editor.reader.selection === selection) this.invalidateReader(editor, true);
      }).catch(() => undefined);
    }
  }

  private invalidateReader(editor: Editor, sourceChanged: boolean): void {
    const state = editor.reader;
    state.privateMode = this.data.privateDisplay();
    state.selection++;
    state.loading = false;
    state.unavailable = sourceChanged;
    state.rootLimit = agentRootPageSize;
    state.loadEarlier = false;
    for (const frame of state.frames) {
      frame.outputs.clear();
      frame.startRow = undefined;
      frame.earlierRows = undefined;
      frame.limit = agentPageSize;
      frame.attempted = false;
    }
    this.advanceReader(editor);
    if (sourceChanged) this.actions.keepAgentHistory(editor.key, []);
    const reply = this.unavailableReader(editor, state.offers, sourceChanged ? 'sourceUnavailable' : state.privateMode ? 'private' : 'loading');
    this.postReader(editor, { ...reply, invalidate: true });
    this.refresh(editor);
  }

  private handleAgent(editor: Editor, request: AgentRequest): void {
    const state = editor.reader;
    const rootId = this.sessionId(editor);
    if (request.revision !== state.revision || state.privateMode !== this.data.privateDisplay() || !rootId || rootId !== state.rootId) return;
    const frame = state.frames.at(-1);
    switch (request.type) {
      case 'agentEnter': {
        const offered = state.offers.edges.get(request.ref);
        if (offered) void this.enterAgent(editor, rootId, offered, request.revision).catch(() => undefined);
        break;
      }
      case 'agentBack':
        if (frame) this.returnAgent(editor, state.frames.length - 1);
        break;
      case 'agentClose':
        if (frame) this.returnAgent(editor, 0);
        break;
      case 'agentJump': {
        const level = state.offers.ancestors.get(request.ref);
        if (level !== undefined && level < state.frames.length) this.returnAgent(editor, level);
        break;
      }
      case 'agentEarlier':
        if (frame && state.offers.earlier) {
          frame.earlierRows = agentPageSize;
          frame.limit += agentPageSize;
        }
        else if (!frame && state.offers.rootEarlier) {
          state.rootLimit += agentRootPageSize;
          state.loadEarlier = true;
        } else break;
        this.advanceReader(editor);
        this.refresh(editor);
        break;
      case 'agentOutput': {
        const row = state.offers.outputs.get(request.ref);
        if (!frame || row === undefined || state.privateMode) break;
        frame.outputs.set(row, (frame.outputs.get(row) ?? agentOutputPageSize) + agentOutputPageSize);
        this.advanceReader(editor);
        this.refresh(editor);
        break;
      }
    }
  }

  private async enterAgent(editor: Editor, rootId: string, offered: AgentEdge, revision: number): Promise<void> {
    const state = editor.reader;
    const current = () => this.editors.get(editor.key) === editor && this.sessionId(editor) === rootId
      && state.privateMode === this.data.privateDisplay() && state.revision === revision;
    const path = state.frames.map(frame => frame.edge.id);
    const graph = await this.data.agentGraph(rootId, [...path, offered.id]);
    const edge = graph.edges.at(-1);
    if (!current() || graph.privateMode !== state.privateMode || !graph.root || graph.edges.length !== path.length + 1 || !edge
      || !compatibleAgentEdge(offered, edge)) return;
    const frame: AgentFrame = { edge, limit: agentPageSize, outputs: new Map(), sourceSeen: false };
    if (!await this.sourcesFor(editor, { ...graph, edges: graph.edges.slice(0, -1) }) || !current()) return;
    const access = await this.actions.agentSource(edge.target);
    if (!current()) return;
    frame.sourceSeen = access !== 'missing';
    state.root = graph.root;
    state.frames.push(frame);
    state.returnTo = undefined;
    state.unavailable = access === 'unavailable';
    state.selection++;
    this.advanceReader(editor);
    this.updatePins(editor);
    if (access === 'readable') {
      this.materializeSelection(editor, graph);
      this.postReader(editor, this.unavailableReader(editor, state.offers, 'loading'));
    }
    this.refresh(editor);
  }

  private materializeSelection(editor: Editor, graph: AgentGraph): void {
    const state = editor.reader;
    const frame = state.frames.at(-1);
    if (!graph.root || !frame?.sourceSeen || frame.attempted || state.unavailable) return;
    frame.attempted = true;
    state.loading = true;
    const { selection, rootId } = state;
    const path = graph.edges.map(edge => edge.id);
    const scope = frame.edge.target;
    const ancestors = [graph.root, ...graph.edges.slice(0, -1).map(item => item.target)];
    const active = () => this.editors.get(editor.key) === editor && this.sessionId(editor) === rootId && state.selection === selection
      && graph.privateMode === this.data.privateDisplay();
    const verify = async (): Promise<boolean> => {
      if (!rootId || !active()) return false;
      const fresh = await this.data.agentGraph(rootId, path);
      return fresh.edges.length === path.length && agentScopeKey(fresh.edges.at(-1)!.target) === agentScopeKey(scope)
        && await this.sourcesFor(editor, fresh) && active();
    };
    void this.actions.materializeAgent(scope, ancestors, active, verify).catch(() => undefined).finally(() => {
      if (active()) {
        state.loading = false;
        this.refresh(editor);
      }
    });
  }

  private returnAgent(editor: Editor, level: number): void {
    const state = editor.reader;
    state.returnTo = state.frames[level]?.edge.id;
    state.frames = state.frames.slice(0, level);
    state.selection++;
    state.loading = false;
    state.unavailable = false;
    this.advanceReader(editor);
    this.updatePins(editor);
    if (!level) this.postReader(editor, { revision: state.revision, privateMode: state.privateMode, returnTo: state.returnTo });
    this.refresh(editor);
  }

  private offerEdge(editor: Editor, offers: ReaderOffers, edge: AgentEdge): string {
    const ref = this.reference(editor, 'enter', edge.id);
    offers.edges.set(ref, edge);
    return ref;
  }

  private projectReader(editor: Editor, graph: AgentGraph | undefined, offers: ReaderOffers): AgentReader {
    const state = editor.reader;
    const frame = state.frames.at(-1);
    if (!frame) return { revision: state.revision, privateMode: state.privateMode, returnTo: state.returnTo, earlier: offers.rootEarlier };
    if (!graph?.root || graph.edges.length !== state.frames.length || state.unavailable) {
      return this.unavailableReader(editor, offers, 'sourceUnavailable');
    }
    const crumbs = this.placeholders(editor, offers);
    const visited = new Set([graph.root, ...graph.edges.map(edge => edge.target)].map(agentScopeKey));
    for (const [index, edge] of graph.edges.entries()) {
      crumbs[index + 1]!.label = agentIdentity(graph.sessions, edge, graph.now, graph.privateMode).label;
    }
    const activity = projectAgentActivity(graph.sessions, frame.edge, {
      now: graph.now, privateMode: graph.privateMode, loading: state.loading,
      limit: frame.limit, startRow: frame.startRow, earlierRows: frame.earlierRows, outputLimits: frame.outputs,
      issueEdge: edge => visited.has(agentScopeKey(edge.target)) ? undefined : this.offerEdge(editor, offers, edge),
      issueOutput: row => {
        const ref = this.reference(editor, 'output ' + frame.edge.id, row);
        offers.outputs.set(ref, row);
        return ref;
      },
    });
    offers.earlier = activity.earlier === true;
    frame.startRow = activity.rows.find(row => !row.synthetic)?.id ?? frame.startRow;
    frame.earlierRows = undefined;
    return { revision: state.revision, privateMode: state.privateMode, returnTo: state.returnTo,
      popup: { ...activity, id: frame.edge.id, breadcrumbs: crumbs } };
  }

  private async chatModel(editor: Editor, id: string | undefined, current: () => boolean): Promise<{
    model: PanelModel; reader: AgentReader; offers: ReaderOffers;
  } | undefined> {
    const state = editor.reader;
    const graph = id ? await this.data.agentGraph(id, state.frames.map(frame => frame.edge.id)) : undefined;
    if (!current() || graph?.privateMode !== undefined && graph.privateMode !== state.privateMode) return undefined;
    state.root = graph?.root;
    if (state.frames.length) {
      const available = graph && await this.sourcesFor(editor, graph);
      if (!current()) return undefined;
      if (!available && !state.unavailable) {
        this.invalidateReader(editor, true);
        return undefined;
      }
      if (available && state.unavailable) {
        state.unavailable = false;
        this.updatePins(editor);
      }
      if (available && graph) {
        this.updatePins(editor);
        this.materializeSelection(editor, graph);
      }
    }
    const offers = emptyOffers();
    const rootOffers = state.frames.length ? emptyOffers() : offers;
    const snapshot = this.actions.frozenHistoryStart(editor.key);
    const model = await this.actions.chat(editor.key, id, {
      limit: state.rootLimit, snapshotStartRow: snapshot ?? undefined, detailFocus: editor.detailFocus,
      loadEarlier: () => current() && state.loadEarlier,
      issueEdge: edge => graph?.root && graph.root.sessionId === edge.parent.sessionId && graph.root.laneId === edge.parent.laneId
        ? this.offerEdge(editor, rootOffers, edge) : undefined,
    });
    if (!current() || model.mode !== 'chat' || model.chat.privateMode !== state.privateMode) return undefined;
    if (rootOffers === offers) {
      const visible = new Set(model.chat.rows.flatMap(row => row.delegation?.ref ? [row.delegation.ref] : []));
      for (const ref of offers.edges.keys()) if (!visible.has(ref)) offers.edges.delete(ref);
      offers.rootEarlier = snapshot !== null && !!graph?.root
        && rootAgentEarlier(graph.sessions, graph.root, state.rootLimit, snapshot);
    }
    return { model, offers, reader: this.projectReader(editor, graph, offers) };
  }

  private refresh(editor: Editor): void {
    if (!editor.panel.visible || !editor.ready) return;
    const state = editor.reader;
    const id = this.sessionId(editor);
    if (editor.target.kind === 'chat' && state.privateMode !== this.data.privateDisplay()) {
      this.invalidateReader(editor, false);
      return;
    }
    if (state.rootId !== id) {
      state.rootId = id;
      state.frames = [];
      state.selection++;
      state.loading = false;
      state.unavailable = false;
      state.rootLimit = agentRootPageSize;
      state.loadEarlier = false;
      state.returnTo = undefined;
      this.advanceReader(editor);
      this.updatePins(editor);
    }
    const sequence = ++editor.sequence;
    const current = () => sequence === editor.sequence && this.editors.get(editor.key) === editor && this.sessionId(editor) === id
      && (editor.target.kind !== 'chat' || state.privateMode === this.data.privateDisplay());
    const result = editor.target.kind === 'chat' ? this.chatModel(editor, id, current)
      : (editor.target.kind === 'usage' ? this.data.usage(editor.usageFilters) : this.data.tasks())
        .then(model => ({ model, reader: undefined, offers: undefined }));
    void result.then(reply => {
      if (!reply || !current()) return;
      const { model, reader, offers } = reply;
      if (model.mode === 'chat') editor.panel.title = 'Agent Lens: ' + model.chat.title;
      const message: HostMessage = { type: 'panel', model, tab: editor.tab, focus: editor.focus, files: editor.files,
        back: Boolean(editor.back && this.editors.has(editor.back)), reader };
      if (offers) state.offers = offers;
      state.loadEarlier = false;
      state.returnTo = undefined;
      editor.tab = undefined;
      editor.focus = undefined;
      editor.files = undefined;
      return editor.panel.webview.postMessage(message);
    }).catch(() => undefined);
  }

  dispose(): void {
    for (const editor of this.editors.values()) editor.panel.dispose();
  }
}
