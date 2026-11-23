import { randomBytes } from 'node:crypto';
import type { Disposable, Uri, WebviewView, WebviewViewProvider } from 'vscode';
import { Uri as ResourceUri } from 'vscode';
import { isReady } from '../../shared/sources';
import type { SourceMessage, SourceStatus } from '../../shared/sources';

export class SourcesView implements WebviewViewProvider {
  private view?: WebviewView;
  private ready = false;

  constructor(
    private readonly extensionUri: Uri,
    private readonly status: () => SourceStatus[],
    private readonly visibility: (visible: boolean) => void,
  ) {}

  resolveWebviewView(view: WebviewView): void {
    this.view = view;
    this.ready = false;
    this.visibility(view.visible);
    const webview = view.webview;
    const media = ResourceUri.joinPath(this.extensionUri, 'media');
    const scripts = ResourceUri.joinPath(this.extensionUri, 'dist', 'webview');
    webview.options = { enableScripts: true, localResourceRoots: [media, scripts] };

    const nonce = randomBytes(24).toString('base64');
    const script = webview.asWebviewUri(ResourceUri.joinPath(scripts, 'sources.js'));
    const stylesheet = webview.asWebviewUri(ResourceUri.joinPath(media, 'sources.css'));
    const listeners: Disposable[] = [
      webview.onDidReceiveMessage((message: unknown) => {
        if (this.view !== view || !isReady(message)) return;
        this.ready = true;
        this.update();
      }),
      view.onDidChangeVisibility(() => {
        if (this.view !== view) return;
        this.visibility(view.visible);
        if (view.visible) this.update();
      }),
      view.onDidDispose(() => {
        for (const listener of listeners) listener.dispose();
        if (this.view !== view) return;
        this.view = undefined;
        this.ready = false;
        this.visibility(false);
      }),
    ];
    webview.html = [
      '<!DOCTYPE html>',
      '<html lang="en"><head>',
      '<meta charset="utf-8">',
      '<meta name="viewport" content="width=device-width, initial-scale=1">',
      '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; connect-src \'none\'; '
        + 'script-src \'nonce-' + nonce + '\'; style-src ' + webview.cspSource + ';">',
      '<link rel="stylesheet" href="' + stylesheet + '">',
      '<title>Agent Lens Sources</title></head>',
      '<body><ul id="sources" aria-label="Local sources" aria-live="polite"></ul>',
      '<script nonce="' + nonce + '" src="' + script + '"></script></body></html>',
    ].join('\n');
  }

  update(): void {
    if (!this.view?.visible || !this.ready) return;
    const message: SourceMessage = { type: 'sources', providers: this.status() };
    void this.view.webview.postMessage(message);
  }
}
