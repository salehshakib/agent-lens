import { ViewColumn, window } from 'vscode';
import type { Disposable, Uri, WebviewPanel } from 'vscode';
import { parsePanelRequest } from '../../shared/protocol';
import type { HostMessage, PanelModel, PanelRequest, PanelTab, RelayCommand, UsageFilters } from '../../shared/protocol';
import type { LensData } from './data';
import { render, resourceRoots } from './html';

type Focus = { lane: string; row: string };
type FilesFocus = Extract<HostMessage, { type: 'panel' }>['files'];
export type ChatPanelRequest = Extract<PanelRequest, { type: `chat${string}` }>;
export type PanelTarget =
  | { kind: 'chat'; key: string; id?: string; tab?: PanelTab; focus?: Focus; from?: string; files?: FilesFocus }
  | { kind: 'usage' }
  | { kind: 'tasks' };

export interface PanelActions {
  chat(key: string, id?: string, focus?: Focus): Promise<PanelModel>;
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
  files?: FilesFocus;
  back?: string;
  peerArrival?: boolean;
  usageFilters: UsageFilters;
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
        existing.files = target.files;
        if (target.from && target.from !== key) {
          existing.back = target.from;
          existing.peerArrival = true;
        }
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
    const editor: Editor = { key, panel, target, ready: false, sequence: 0, usageFilters: defaultUsage };
    if (target.kind === 'chat') {
      editor.tab = target.tab;
      editor.focus = target.focus;
      editor.files = target.files;
      if (target.from && target.from !== key) {
        editor.back = target.from;
        editor.peerArrival = true;
      }
    }
    this.editors.set(key, editor);
    this.visibility();
    const listeners: Disposable[] = [
      panel.webview.onDidReceiveMessage((message: unknown) => this.handle(editor, message)),
      panel.onDidChangeViewState(() => {
        this.visibility();
        if (panel.visible) this.refresh(editor);
      }),
      panel.onDidDispose(() => {
        for (const listener of listeners) listener.dispose();
        clearTimeout(editor.timer);
        this.editors.delete(key);
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
      case 'chatCardAction':
        if (editor.target.kind === 'chat') this.actions.chatRequest(editor.key, request, this.sessionId(editor));
        break;
      case 'openFile': this.actions.openFile(request.id); break;
      case 'openDiff': this.actions.openDiff(request.id); break;
      case 'openTranscript': this.actions.openTranscript(request.session, request.lane); break;
      case 'openSession': this.actions.openSession(request.id, 'chat', undefined, editor.key); break;
      case 'goto': this.actions.openSession(request.session, request.tab ?? 'timeline',
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

  private model(editor: Editor): Promise<PanelModel> {
    switch (editor.target.kind) {
      case 'usage': return this.data.usage(editor.usageFilters);
      case 'tasks': return this.data.tasks();
      case 'chat': return this.actions.chat(editor.key, this.sessionId(editor), editor.target.focus);
    }
  }

  private refresh(editor: Editor): void {
    if (!editor.panel.visible || !editor.ready) return;
    const sequence = ++editor.sequence;
    void this.model(editor).then(model => {
      if (sequence !== editor.sequence || this.editors.get(editor.key) !== editor) return;
      if (model.mode === 'chat') editor.panel.title = 'Agent Lens: ' + model.chat.title;
      const back = Boolean(editor.back && this.editors.has(editor.back));
      const message: HostMessage = { type: 'panel', model, tab: editor.tab, focus: editor.focus, files: editor.files,
        back, peerArrival: back && editor.peerArrival };
      editor.tab = undefined;
      editor.focus = undefined;
      editor.files = undefined;
      editor.peerArrival = undefined;
      return editor.panel.webview.postMessage(message);
    }).catch(() => undefined);
  }

  dispose(): void {
    for (const editor of this.editors.values()) editor.panel.dispose();
  }
}
