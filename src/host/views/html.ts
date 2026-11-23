import { randomBytes } from 'node:crypto';
import { Uri } from 'vscode';
import type { Webview } from 'vscode';

export interface Page {
  title: string;
  script: string;
  styles: readonly string[];
  /** Static markup owned by the extension, never provider text. */
  body: string;
}

export function resourceRoots(extensionUri: Uri): Uri[] {
  return [Uri.joinPath(extensionUri, 'media'), Uri.joinPath(extensionUri, 'dist', 'webview')];
}

/** Render a page with the section 14 policy: no default sources, no network, nonce script, local styles. */
export function render(webview: Webview, extensionUri: Uri, page: Page): string {
  const nonce = randomBytes(24).toString('base64');
  const script = webview.asWebviewUri(Uri.joinPath(extensionUri, 'dist', 'webview', page.script));
  const styles = page.styles.map(name => '<link rel="stylesheet" href="' +
    webview.asWebviewUri(Uri.joinPath(extensionUri, 'media', name)) + '">');
  return [
    '<!DOCTYPE html>',
    '<html lang="en"><head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; connect-src \'none\'; '
      + 'script-src \'nonce-' + nonce + '\'; style-src ' + webview.cspSource + ';">',
    ...styles,
    '<title>' + page.title + '</title></head>',
    '<body>' + page.body,
    '<script nonce="' + nonce + '" src="' + script + '"></script></body></html>',
  ].join('\n');
}
