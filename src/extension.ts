import { homedir } from 'node:os';
import { commands, Uri, window, workspace } from 'vscode';
import type { ExtensionContext } from 'vscode';
import { statusTerminal } from './host/accounts/terminal';
import { profileKey } from './host/accounts/profiles';
import { adapters } from './host/adapters/registry';
import type { Provider } from './host/adapters/types';
import { RootObservation } from './host/discovery/observation';
import { configureRoots } from './host/discovery/roots';
import type { RootConfiguration } from './host/discovery/roots';
import { registerFileActions } from './host/files/actions';
import { RelayManager } from './host/limits/manager';
import type { RelayProfile } from './host/limits/manager';
import { refreshGate } from './host/limits/refresh';
import { claudeTaskRoot } from './host/sessions/delegation';
import { defaultSignalSettings, parseSignalSettings } from './host/sessions/signals';
import type { SignalSettings } from './host/sessions/signals';
import { SessionStore } from './host/sessions/store';
import { alertText, ContextAlerts } from './host/views/alerts';
import { LensData } from './host/views/data';
import type { ProfileInfo } from './host/views/data';
import { PanelView } from './host/views/panel';
import { SidebarView } from './host/views/sidebar';
import { StatusView } from './host/views/status';
import type { SourceView } from './shared/protocol';

export function activate(context: ExtensionContext): SessionStore {
  let configuration = new Map<Provider, RootConfiguration>();
  let observers = new Map<Provider, RootObservation[]>();
  let sidebarVisible = false;
  let panelVisible = false;
  let modelUpdate: NodeJS.Timeout | undefined;
  const taskRoot = claudeTaskRoot(process.env.LOCALAPPDATA);
  const store = new SessionStore(taskRoot);
  let signalSettings: SignalSettings = defaultSignalSettings;
  let alertsEnabled = false;
  const alerts = new ContextAlerts(Date.now());

  /** Signal settings are machine scoped. Workspace and repository values are never read. */
  function configured(name: string): unknown {
    const inspected = workspace.getConfiguration('agentLens').inspect<unknown>(name);
    return inspected?.globalValue ?? inspected?.defaultValue;
  }

  function readSignalSettings(): void {
    signalSettings = parseSignalSettings({
      loopThreshold: configured('signals.loopThreshold'), checkIgnore: configured('signals.checkIgnore'),
      checkCommands: configured('signals.checkCommands'), warnPercent: configured('context.warnPercent'),
      criticalPercent: configured('context.criticalPercent'),
    });
    store.setSignalSettings(signalSettings);
    const enabled = configured('context.alerts') === true;
    // Switching alerts on starts from now, so earlier samples stay historical.
    if (enabled && !alertsEnabled) alerts.reset(Date.now());
    alertsEnabled = enabled;
  }
  readSignalSettings();

  function privateMode(): boolean {
    return workspace.getConfiguration('agentLens').get<boolean>('privateDisplay', false) === true;
  }

  function profiles(): ProfileInfo[] {
    return [...configuration].flatMap(([provider, config]) => config.roots
      .filter(root => root.profile)
      .map(root => ({ provider, id: root.profile!.id, label: root.profile!.label, home: root.profile!.home })));
  }

  function relayProfiles(): RelayProfile[] {
    return (configuration.get('claude-code')?.roots ?? [])
      .filter(root => root.profile)
      .map(root => ({ id: root.profile!.id, label: root.profile!.label, home: root.profile!.home }));
  }

  function sources(): SourceView[] {
    return adapters.map(adapter => {
      const config = configuration.get(adapter.id);
      const statuses = (observers.get(adapter.id) ?? []).map(observer => observer.status);
      const available = statuses.some(status => status.state === 'available');
      const partial = config?.rejected || statuses.some(status => status.partial || status.state !== 'available');
      let state = 'Missing source';
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

  const relay = new RelayManager(context.globalStorageUri.fsPath, Uri.joinPath(context.extensionUri, 'dist', 'relay', 'relay.js').fsPath,
    context.globalState, () => refreshViews());
  const data = new LensData({
    sessions: () => store.sessions(),
    usageTotals: () => store.ledger.totals(),
    limitSamples: () => store.limitSamples(),
    now: Date.now,
    privateMode,
    profiles,
    userHome: homedir(),
    relay: id => relay.snapshots(id),
    relayViews: () => relay.views(),
    sources,
    refresh: () => refreshGate(),
    thresholds: () => ({ warnPercent: signalSettings.warnPercent, criticalPercent: signalSettings.criticalPercent }),
  });
  const status = new StatusView('agentLens.openUsage');

  function visibility(): void {
    const visible = sidebarVisible || panelVisible;
    for (const roots of observers.values()) {
      for (const observer of roots) observer.setVisible(visible);
    }
    relay.setVisible(visible);
  }

  const panel = new PanelView(context.extensionUri, data, {
    prepare: id => store.materialize(id),
    openFile: id => void commands.executeCommand('agentLens.files.open', id),
    openDiff: id => void commands.executeCommand('agentLens.files.diff', id),
    openTranscript: (session, lane) => {
      if (privateMode()) {
        void window.showInformationMessage('Transcripts are hidden in private display mode.');
        return;
      }
      const source = store.transcriptSource(session, lane);
      if (!source) {
        void window.showInformationMessage('This transcript is no longer available.');
        return;
      }
      void commands.executeCommand('vscode.open', Uri.file(source.path));
    },
    openParent: (session, lane) => void openParent(session, lane),
    openSettings: () => void commands.executeCommand('workbench.action.openSettings', '@ext:salehshakib.agent-lens'),
    relay: (command, profile) => void relay.command(command, profile),
    visibility: visible => {
      panelVisible = visible;
      visibility();
    },
  });
  const sidebar = new SidebarView(context.extensionUri, data, {
    visibility: visible => {
      sidebarVisible = visible;
      visibility();
    },
    openSession: (id, mode) => panel.show({ kind: 'session', id, tab: mode === 'map' ? 'map' : 'timeline' }),
    openParent: id => void openParent(id, ''),
    openUsage: () => panel.show({ kind: 'usage' }),
    openTasks: () => panel.show({ kind: 'tasks' }),
    relay: (command, profile) => void relay.command(command, profile),
    accountStatus: key => openAccountStatus(key),
  });

  /** Open the parent row of a lane. Several launches of a resumed Codex thread open a small menu, newest first. */
  async function openParent(sessionId: string, laneId: string): Promise<void> {
    const info = await data.parent(sessionId, laneId);
    if (info.state === 'root') {
      void window.showInformationMessage('This session has no parent.');
      return;
    }
    if (info.state === 'unresolved') {
      void window.showInformationMessage('The parent is not available. ' + (info.reason ?? 'It could not be resolved.'));
      return;
    }
    let picked = info.targets[0];
    if (info.targets.length > 1) {
      const choice = await window.showQuickPick(info.targets.map(target => ({
        label: target.label, description: target.at === undefined ? 'time unknown' : new Date(target.at).toLocaleString(), target,
      })), { placeHolder: 'This thread was launched more than once. Choose the launch to open.' });
      picked = choice?.target;
    }
    if (picked) panel.show({ kind: 'session', id: picked.sessionId, tab: 'timeline', focus: { lane: picked.laneId, row: picked.rowId } });
  }

  function showAlerts(): void {
    if (!alertsEnabled) return;
    void data.contextCandidates().then(candidates => {
      for (const alert of alerts.next(candidates)) {
        void window.showWarningMessage(alertText(alert), 'Open Agent map').then(choice => {
          if (choice) panel.show({ kind: 'session', id: alert.sessionId, tab: 'map' });
        });
      }
    }).catch(() => undefined);
  }

  function refreshViews(): void {
    sidebar.update();
    panel.update();
    showAlerts();
    void store.sessions().then(sessions => status.update(data.liveCount(sessions), data.gauges().main)).catch(() => undefined);
  }

  function updateModel(): void {
    modelUpdate ??= setTimeout(() => {
      modelUpdate = undefined;
      refreshViews();
    }, 100);
  }

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
    relay.setProfiles(relayProfiles());
    observers = new Map([...next].map(([id, config]) => [id, config.roots.map(root => {
      const observer = new RootObservation(root, {
        onChange: () => {
          store.setCatalog(root.key, root.adapter, observer.catalog);
          updateModel();
        },
        onBatch: batch => {
          store.ingest(batch);
          updateModel();
        },
      });
      observer.setVisible(sidebarVisible || panelVisible);
      observer.start();
      return observer;
    })]));
    refreshViews();
  }

  async function chooseProfile(): Promise<string | undefined> {
    const choices = relayProfiles();
    if (choices.length <= 1) return choices[0]?.id;
    const picked = await window.showQuickPick(choices.map(item => ({ label: item.label, id: item.id })), { placeHolder: 'Choose a Claude Code profile' });
    return picked?.id;
  }

  /** Types the official status command into a terminal. The user presses Enter; nothing runs here. */
  function openAccountStatus(key: string): void {
    if (!workspace.isTrusted) {
      void window.showInformationMessage('Trust this workspace to open a terminal for the official account status.');
      return;
    }
    const profile = profiles().find(item => profileKey(item.provider, item.id) === key);
    const adapter = adapters.find(item => item.id === profile?.provider);
    if (!profile || !adapter) return;
    const request = statusTerminal(adapter, profile);
    const terminal = window.createTerminal({ name: request.name, env: request.env });
    terminal.sendText(request.text, false);
    terminal.show();
  }

  async function chooseAccount(): Promise<string | undefined> {
    const choices = profiles();
    if (choices.length <= 1) return choices[0] && profileKey(choices[0].provider, choices[0].id);
    const picked = await window.showQuickPick(choices.map(item => ({
      label: item.label, description: adapters.find(adapter => adapter.id === item.provider)?.label, key: profileKey(item.provider, item.id),
    })), { placeHolder: 'Choose an account profile' });
    return picked?.key;
  }

  registerFileActions(context, id => store.file(id), () => [
    ...[...configuration.values()].flatMap(config => config.roots.map(root => root.boundary)),
    ...(taskRoot ? [taskRoot] : []),
  ]);
  context.subscriptions.push(
    window.registerWebviewViewProvider(SidebarView.viewType, sidebar),
    commands.registerCommand('agentLens.openUsage', () => panel.show({ kind: 'usage' })),
    commands.registerCommand('agentLens.openTasks', () => panel.show({ kind: 'tasks' })),
    commands.registerCommand('agentLens.openParent', () => {
      const id = panel.currentSession();
      if (!id) void window.showInformationMessage('Open a session in Agent Lens first.');
      else void openParent(id, '');
    }),
    commands.registerCommand('agentLens.openSignalSettings',
      () => void commands.executeCommand('workbench.action.openSettings', '@ext:salehshakib.agent-lens')),
    commands.registerCommand('agentLens.showAccounts', () => commands.executeCommand('agentLens.sessions.focus')),
    commands.registerCommand('agentLens.accounts.openStatus', async () => {
      const key = await chooseAccount();
      if (key) openAccountStatus(key);
    }),
    commands.registerCommand('agentLens.relay.enable', async () => {
      const id = await chooseProfile();
      if (id) await relay.command('enable', id);
    }),
    commands.registerCommand('agentLens.relay.remove', async () => {
      const id = await chooseProfile();
      if (id) await relay.command('uninstall', id);
    }),
    workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('agentLens.agents')) refreshConfiguration();
      else if (event.affectsConfiguration('agentLens.privateDisplay')) refreshViews();
      else if (event.affectsConfiguration('agentLens.signals') || event.affectsConfiguration('agentLens.context')) {
        readSignalSettings();
        refreshViews();
      }
    }),
    { dispose: disposeObservers },
    { dispose: () => { relay.dispose(); panel.dispose(); status.dispose(); } },
  );
  refreshConfiguration();
  return store;
}
