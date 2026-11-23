import { homedir } from 'node:os';
import { window, workspace } from 'vscode';
import type { ExtensionContext } from 'vscode';
import { adapters } from './host/adapters/registry';
import type { Provider } from './host/adapters/types';
import { RootObservation } from './host/discovery/observation';
import { configureRoots } from './host/discovery/roots';
import type { RootConfiguration } from './host/discovery/roots';
import { SourcesView } from './host/views/sources';
import type { SourceStatus } from './shared/sources';

export function activate(context: ExtensionContext): void {
  let configuration = new Map<Provider, RootConfiguration>();
  let observers = new Map<Provider, RootObservation[]>();
  let visible = false;

  function status(): SourceStatus[] {
    return adapters.map(adapter => {
      const config = configuration.get(adapter.id);
      const statuses = (observers.get(adapter.id) ?? []).map(observer => observer.status);
      const available = statuses.some(status => status.state === 'available');
      const partial = config?.rejected || statuses.some(status => status.partial || status.state !== 'available');
      let state: SourceStatus['state'] = 'Missing source';
      if (config?.disabled) state = 'Disabled';
      else if (available) state = partial ? 'Partial coverage' : 'Available';
      else if (statuses.some(status => status.state === 'scanning')) state = 'Scanning';
      else if (config?.rejected || statuses.some(status => status.state === 'rejected')) state = 'Source rejected';
      else if (statuses.some(status => status.state === 'unavailable')) state = 'Source unavailable';
      return {
        label: adapter.label,
        state,
        transcripts: statuses.reduce((total, status) => total + status.transcripts, 0),
        versions: [...new Set(statuses.flatMap(status => status.versions))].sort(),
      };
    });
  }

  const view = new SourcesView(context.extensionUri, status, shown => {
    visible = shown;
    for (const roots of observers.values()) {
      for (const observer of roots) observer.setVisible(shown);
    }
  });
  function disposeObservers() {
    for (const roots of observers.values()) {
      for (const observer of roots) observer.dispose();
    }
    observers.clear();
  }
  function refreshConfiguration() {
    const settings = workspace.getConfiguration('agentLens').inspect<unknown>('agents');
    const next = configureRoots(adapters, settings?.globalValue ?? settings?.defaultValue, homedir(), process.env);
    disposeObservers();
    configuration = next;
    observers = new Map([...next].map(([id, config]) => [id, config.roots.map(root => {
      const observer = new RootObservation(root, { onChange: () => view.update() });
      observer.setVisible(visible);
      observer.start();
      return observer;
    })]));
    view.update();
  }
  context.subscriptions.push(
    window.registerWebviewViewProvider('agentLens.sessions', view),
    workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('agentLens.agents')) refreshConfiguration();
    }),
    { dispose: disposeObservers },
  );
  refreshConfiguration();
}
