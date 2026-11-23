import { ViewColumn, window } from 'vscode';
import type { Disposable, Uri, WebviewPanel } from 'vscode';
import { parsePanelRequest } from '../../shared/protocol';
import type { HostMessage, PanelModel, PanelTab, RelayCommand, UsageFilters } from '../../shared/protocol';
import type { LensData } from './data';
import { render, resourceRoots } from './html';

export type PanelTarget =
  | { kind: 'session'; id: string; tab: PanelTab }
  | { kind: 'usage' }
  | { kind: 'tasks' };

export interface PanelActions {
  /** Load the full history of a session before it is shown. */
  prepare(id: string): Promise<unknown>;
  openFile(id: string): void;
  openDiff(id: string): void;
  openTranscript(session: string, lane: string): void;
  relay(command: RelayCommand, profile: string): void;
  visibility(visible: boolean): void;
}

const defaultUsage: UsageFilters = { range: '30', project: '', adapter: '' };
const refreshDelay = 250;

/** One editor tab that shows a session, the usage summary or the background tasks. */
export class PanelView {
  private panel?: WebviewPanel;
  private ready = false;
  private target?: PanelTarget;
  private pendingTab?: PanelTab;
  private usageFilters = defaultUsage;
  private sequence = 0;
  private timer?: NodeJS.Timeout;

  constructor(private readonly extensionUri: Uri, private readonly data: LensData, private readonly actions: PanelActions) {}

  show(target: PanelTarget): void {
    this.target = target;
    this.pendingTab = target.kind === 'session' ? target.tab : undefined;
    if (this.panel) {
      this.panel.title = this.title();
      this.panel.reveal(this.panel.viewColumn ?? ViewColumn.Active, false);
      this.refresh();
      return;
    }
    const panel = window.createWebviewPanel('agentLens.panel', this.title(), ViewColumn.Active, {
      enableScripts: true, retainContextWhenHidden: false, localResourceRoots: resourceRoots(this.extensionUri),
    });
    this.panel = panel;
    this.ready = false;
    this.actions.visibility(true);
    const listeners: Disposable[] = [
      panel.webview.onDidReceiveMessage((message: unknown) => {
        if (this.panel !== panel) return;
        this.handle(message);
      }),
      panel.onDidChangeViewState(() => {
        if (this.panel !== panel) return;
        this.actions.visibility(panel.visible);
        if (panel.visible) this.refresh();
      }),
      panel.onDidDispose(() => {
        for (const listener of listeners) listener.dispose();
        clearTimeout(this.timer);
        this.timer = undefined;
        if (this.panel !== panel) return;
        this.panel = undefined;
        this.ready = false;
        this.sequence++;
        this.actions.visibility(false);
      }),
    ];
    panel.webview.html = render(panel.webview, this.extensionUri, {
      title: 'Agent Lens', script: 'panel.js', styles: ['lens.css', 'panel.css'],
      body: '<div id="root"></div><div id="live" class="visually-hidden" role="status" aria-live="polite"></div>',
    });
  }

  private title(): string {
    switch (this.target?.kind) {
      case 'usage': return 'Agent Lens: Usage';
      case 'tasks': return 'Agent Lens: Background tasks';
      default: return 'Agent Lens: Session';
    }
  }

  private handle(message: unknown): void {
    const request = parsePanelRequest(message);
    if (!request) return;
    switch (request.type) {
      case 'ready':
        this.ready = true;
        this.refresh();
        break;
      case 'openFile': this.actions.openFile(request.id); break;
      case 'openDiff': this.actions.openDiff(request.id); break;
      case 'openTranscript': this.actions.openTranscript(request.session, request.lane); break;
      case 'openSession': this.show({ kind: 'session', id: request.id, tab: 'timeline' }); break;
      case 'usageFilters':
        this.usageFilters = request.filters;
        this.refresh();
        break;
      case 'relay': this.actions.relay(request.command, request.profile); break;
    }
  }

  /** Throttled refresh for store changes. */
  update(): void {
    if (!this.panel?.visible || !this.ready || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.refresh();
    }, refreshDelay);
  }

  private async model(target: PanelTarget): Promise<PanelModel> {
    switch (target.kind) {
      case 'usage': return this.data.usage(this.usageFilters);
      case 'tasks': return this.data.tasks();
      case 'session':
        await this.actions.prepare(target.id);
        return this.data.detail(target.id);
    }
  }

  refresh(): void {
    const panel = this.panel;
    const target = this.target;
    if (!panel?.visible || !this.ready || !target) return;
    const sequence = ++this.sequence;
    void this.model(target).then(model => {
      if (sequence !== this.sequence || this.panel !== panel) return;
      const message: HostMessage = { type: 'panel', model, ...(this.pendingTab ? { tab: this.pendingTab } : {}) };
      this.pendingTab = undefined;
      return panel.webview.postMessage(message);
    }).catch(() => undefined);
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.panel?.dispose();
  }
}
