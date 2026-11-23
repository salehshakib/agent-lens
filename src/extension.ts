import { homedir } from 'node:os';
import { window, workspace } from 'vscode';
import type { ExtensionContext } from 'vscode';
import { adapters } from './host/adapters/registry';
import type { Provider } from './host/adapters/types';
import { RootObservation } from './host/discovery/observation';
import { configureRoots } from './host/discovery/roots';
import type { RootConfiguration } from './host/discovery/roots';
import { registerFileActions } from './host/files/actions';
import { claudeTaskRoot } from './host/sessions/delegation';
import { SessionStore } from './host/sessions/store';
import { SourcesView } from './host/views/sources';
import type { SourceStatus } from './shared/sources';

export function activate(context: ExtensionContext): SessionStore {
  let configuration = new Map<Provider, RootConfiguration>();
  let observers = new Map<Provider, RootObservation[]>();
  let visible = false;
  let modelUpdate: NodeJS.Timeout | undefined;
  const taskRoot = claudeTaskRoot(process.env.LOCALAPPDATA);
  const store = new SessionStore(taskRoot);

  function updateModel(): void {
    modelUpdate ??= setTimeout(() => {
      modelUpdate = undefined;
      void store.sessions().catch(() => undefined);
    }, 100);
  }

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
    clearTimeout(modelUpdate);
    modelUpdate = undefined;
    store.clear();
  }
  function refreshConfiguration() {
    const settings = workspace.getConfiguration('agentLens').inspect<unknown>('agents');
    const next = configureRoots(adapters, settings?.globalValue ?? settings?.defaultValue, homedir(), process.env);
    disposeObservers();
    configuration = next;
    observers = new Map([...next].map(([id, config]) => [id, config.roots.map(root => {
      const observer = new RootObservation(root, {
        onChange: () => {
          store.setCatalog(root.key, root.adapter, observer.catalog);
          updateModel();
          view.update();
        },
        onBatch: batch => {
          store.ingest(batch);
          updateModel();
        },
      });
      observer.setVisible(visible);
      observer.start();
      return observer;
    })]));
    view.update();
  }
  registerFileActions(context, id => store.file(id), () => [
    ...[...configuration.values()].flatMap(config => config.roots.map(root => root.boundary)),
    ...(taskRoot ? [taskRoot] : []),
  ]);
  context.subscriptions.push(
    window.registerWebviewViewProvider('agentLens.sessions', view),
    workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('agentLens.agents')) refreshConfiguration();
    }),
    { dispose: disposeObservers },
  );
  refreshConfiguration();
  return store;
}
