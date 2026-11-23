import type { Disposable, Uri, WebviewView, WebviewViewProvider } from 'vscode';
import { parseSidebarRequest } from '../../shared/protocol';
import type { Filters, HostMessage, RelayCommand } from '../../shared/protocol';
import type { LensData } from './data';
import { render, resourceRoots } from './html';

export interface SidebarActions {
  visibility(visible: boolean): void;
  openSession(id: string, mode: 'chat' | 'map', start?: boolean): void;
  newChat(): void;
  openParent(id: string): void;
  openUsage(): void;
  openTasks(): void;
  relay(command: RelayCommand, profile: string): void;
  /** Open the official read-only status command for the profile with this key. */
  accountStatus(profile: string): void;
}

const emptyFilters: Filters = { search: '', adapter: '', project: '', warnings: false, profile: '' };

export class SidebarView implements WebviewViewProvider {
  static readonly viewType = 'agentLens.sessions';
  private view?: WebviewView;
  private ready = false;
  private filters = emptyFilters;
  private sequence = 0;

  constructor(private readonly extensionUri: Uri, private readonly data: LensData, private readonly actions: SidebarActions) {}

  resolveWebviewView(view: WebviewView): void {
    this.view = view;
    this.ready = false;
    this.actions.visibility(view.visible);
    const webview = view.webview;
    webview.options = { enableScripts: true, localResourceRoots: resourceRoots(this.extensionUri) };
    const listeners: Disposable[] = [
      webview.onDidReceiveMessage((message: unknown) => {
        if (this.view !== view) return;
        const request = parseSidebarRequest(message);
        if (!request) return;
        switch (request.type) {
          case 'ready':
            this.ready = true;
            this.update();
            break;
          case 'filter':
            this.filters = request.filters;
            this.update();
            break;
          case 'loadOlder':
            this.data.loadOlder(request.project);
            this.update();
            break;
          case 'newChat': this.actions.newChat(); break;
          case 'continueChat': this.actions.openSession(request.id, 'chat', true); break;
          case 'openSession': this.actions.openSession(request.id, 'chat'); break;
          case 'openMap': this.actions.openSession(request.id, 'map'); break;
          case 'openParent': this.actions.openParent(request.id); break;
          case 'openUsage': this.actions.openUsage(); break;
          case 'openTasks': this.actions.openTasks(); break;
          case 'relay': this.actions.relay(request.command, request.profile); break;
          case 'accountStatus': this.actions.accountStatus(request.profile); break;
        }
      }),
      view.onDidChangeVisibility(() => {
        if (this.view !== view) return;
        this.actions.visibility(view.visible);
        if (view.visible) this.update();
      }),
      view.onDidDispose(() => {
        for (const listener of listeners) listener.dispose();
        if (this.view !== view) return;
        this.view = undefined;
        this.ready = false;
        this.actions.visibility(false);
      }),
    ];
    webview.html = render(webview, this.extensionUri, {
      title: 'Agent Lens', script: 'sidebar.js', styles: ['lens.css', 'sidebar.css'],
      body: '<main id="root" aria-label="Agent Lens sessions"></main><div id="live" class="visually-hidden" role="status" aria-live="polite"></div>',
    });
  }

  update(): void {
    const view = this.view;
    if (!view?.visible || !this.ready) return;
    const sequence = ++this.sequence;
    void this.data.sidebar(this.filters).then(model => {
      if (sequence !== this.sequence || this.view !== view) return;
      const message: HostMessage = { type: 'sidebar', model };
      return view.webview.postMessage(message);
    }).catch(() => undefined);
  }
}
