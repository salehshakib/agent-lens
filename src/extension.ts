import { mkdir, opendir, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { commands, Uri, window, workspace } from 'vscode';
import type { ExtensionContext, WebviewPanel } from 'vscode';
import { statusTerminal } from './host/accounts/terminal';
import { profileKey } from './host/accounts/profiles';
import { adapters } from './host/adapters/registry';
import { isClaudeSessionId, setChatPermissionMode } from './host/adapters/claude-code/chat';
import type { Adapter, Provider, Source } from './host/adapters/types';
import { claimChatWriter } from './host/chat/ownership';
import { ChatSessions } from './host/chat/session';
import type { ChatAttempt, ChatIdentity, ChatLaunch, ChatScope } from './host/chat/types';
import { accessError, inspectLocal, localPath, openLocalFile, pathKey } from './host/discovery/local-path';
import { RootObservation } from './host/discovery/observation';
import { SourceReader } from './host/discovery/reader';
import { configureRoots } from './host/discovery/roots';
import type { RootConfiguration } from './host/discovery/roots';
import { registerFileActions } from './host/files/actions';
import { RelayManager } from './host/limits/manager';
import type { RelayProfile } from './host/limits/manager';
import { refreshGate } from './host/limits/refresh';
import { claudeTaskRoot } from './host/sessions/delegation';
import { key as sessionKey, sourceSessionId } from './host/sessions/evidence';
import { defaultSignalSettings, parseSignalSettings } from './host/sessions/signals';
import type { SignalSettings } from './host/sessions/signals';
import { SessionStore } from './host/sessions/store';
import type { Session } from './host/sessions/types';
import { alertText, ContextAlerts } from './host/views/alerts';
import { LensData } from './host/views/data';
import type { ProfileInfo } from './host/views/data';
import { PanelView } from './host/views/panel';
import type { ChatPanelRequest, PanelTarget } from './host/views/panel';
import { SidebarView } from './host/views/sidebar';
import { StatusView } from './host/views/status';
import type { PanelTab, SourceView } from './shared/protocol';

const catalogKey = /^[a-f0-9]{32}$/;
const chatProvider: Provider = 'claude-code';
let ownedChat: ChatSessions | undefined;

function adapterFor(provider: Provider): Adapter | undefined {
  return adapters.find(adapter => adapter.id === provider);
}

function recordedId(identity: ChatIdentity): string {
  const { provider, nativeId, home } = identity;
  return sessionKey(provider, /^[a-z]:[\\/]/i.test(home) ? home.replace(/\\/g, '/').toLowerCase() : home, nativeId.toLowerCase());
}

function recoverableAttempt(value: ChatAttempt): boolean {
  const scope = value?.identity;
  return Boolean(scope && scope.provider === chatProvider && typeof scope.profile === 'string'
    && localPath(scope.home) && localPath(scope.cwd) && isClaudeSessionId(scope.nativeId)
    && isClaudeSessionId(value.id) && typeof value.acknowledged === 'boolean'
    && (value.conversation === undefined || catalogKey.test(value.conversation) || isClaudeSessionId(value.conversation)));
}

async function recoveredAttempts(directory: string): Promise<ChatAttempt[]> {
  const attempts: ChatAttempt[] = [];
  try {
    await inspectLocal(directory, 'directory');
    const entries = await opendir(directory);
    let visited = 0;
    for await (const entry of entries) {
      if (++visited > 2048) break;
      const id = entry.name.endsWith('.json') ? entry.name.slice(0, -5) : undefined;
      if (!entry.isFile() || !isClaudeSessionId(id)) continue;
      try {
        const { handle, file } = await openLocalFile(join(directory, entry.name));
        try {
          if (file.size === 0n || file.size > 12_288n) continue;
          const data = Buffer.alloc(Number(file.size));
          const { bytesRead } = await handle.read(data, 0, data.length, 0);
          if (bytesRead !== data.length) continue;
          const attempt = JSON.parse(data.toString('utf8')) as ChatAttempt;
          if (recoverableAttempt(attempt) && attempt.id === id) attempts.push(attempt);
        } finally {
          await handle.close();
        }
      } catch {
        // A malformed or concurrently retired entry cannot supply recovery evidence.
      }
    }
  } catch {
    // A profile with no interrupted sends may have no journal directory.
  }
  return attempts;
}

async function persistAttempt(directory: string, attempt: ChatAttempt, remove: boolean): Promise<void> {
  const path = join(directory, attempt.id + '.json');
  if (remove) {
    await unlink(path).catch((error: unknown) => { if (accessError(error) !== 'missing') throw error; });
    return;
  }
  await mkdir(directory, { recursive: true });
  const pending = path + '.tmp';
  await writeFile(pending, JSON.stringify(attempt), { mode: 0o600, flag: 'wx' });
  await rename(pending, path);
}

export async function activate(context: ExtensionContext): Promise<SessionStore> {
  let configuration = new Map<Provider, RootConfiguration>();
  let observers = new Map<Provider, RootObservation[]>();
  let sidebarVisible = false;
  let panelVisible = false;
  let modelUpdate: NodeJS.Timeout | undefined;
  const taskRoot = claudeTaskRoot(process.env.LOCALAPPDATA);
  const store = new SessionStore(taskRoot);
  const attemptDirectory = join(context.globalStorageUri.fsPath, 'chat-attempts');
  const recoveries = await recoveredAttempts(attemptDirectory);
  const catalogEditors = new Map<string, string>();
  let prepareChain: Promise<unknown> = Promise.resolve();
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
  setChatPermissionMode(configured('chat.permissionMode'));

  function privateMode(): boolean {
    return workspace.getConfiguration('agentLens').get<boolean>('privateDisplay', false) === true;
  }

  function profiles(): ProfileInfo[] {
    return [...configuration].flatMap(([provider, config]) => config.roots
      .filter(root => root.profile)
      .map(root => ({ provider, id: root.profile!.id, label: root.profile!.label, home: root.profile!.home })));
  }

  function exactSources(id: string, provider: Provider): Source[] {
    return (observers.get(provider) ?? []).flatMap(observer => [...observer.catalog.values()]
      .filter(source => source.kind === 'transcript' && source.laneId === source.sessionId && sourceSessionId(source) === id));
  }

  function approvedProfile(scope: ChatScope): boolean {
    return profiles().some(profile => profile.provider === scope.provider && profile.id === scope.profile
      && pathKey(profile.home) === pathKey(scope.home));
  }

  function identityFor(session: Session): ChatIdentity | undefined {
    if (!canContinue(session) || !session.cwd || !session.profile) return undefined;
    const [source] = exactSources(session.id, session.provider);
    const cwd = localPath(session.cwd);
    if (!source || !cwd || source.profileId !== session.profile || !isClaudeSessionId(source.sessionId)
      || source.sessionId.toLowerCase() !== session.nativeId.toLowerCase()) return undefined;
    const identity = { provider: session.provider, profile: session.profile, home: source.home, cwd, nativeId: source.sessionId };
    return approvedProfile(identity) ? identity : undefined;
  }

  function canContinue(session: Session): boolean {
    return Boolean(adapterFor(session.provider)?.chat && session.profile && isClaudeSessionId(session.nativeId)
      && session.lanes[0]?.nativeId.toLowerCase() === session.nativeId.toLowerCase());
  }

  async function validateChat(launch: ChatLaunch, ownWorker?: boolean): Promise<string | undefined> {
    const scope = launch.identity;
    if (!workspace.isTrusted) return 'Trust this workspace to use chat.';
    if (workspace.getWorkspaceFolder(Uri.file(scope.cwd))?.uri.scheme !== 'file') {
      return 'Open the recorded folder in a trusted VS Code workspace to continue here.';
    }
    if (!approvedProfile(scope)) return 'The original profile is no longer configured.';
    try {
      await inspectLocal(scope.cwd, 'directory');
      await inspectLocal(scope.home, 'directory');
    } catch {
      return 'The workspace folder or profile home could not be verified as a local directory.';
    }
    const adapter = adapterFor(scope.provider)?.chat;
    if (!adapter) return 'Live chat is unavailable for this agent.';
    if (ownWorker) return;
    if (launch.resume) {
      const id = recordedId(scope);
      const candidates = exactSources(id, scope.provider);
      const source = candidates[0];
      if (candidates.length > 1) return 'Several transcript files match this session. Continue is unavailable.';
      if (!source || source.profileId !== scope.profile || source.sessionId !== scope.nativeId) {
        return 'The original session transcript is no longer available.';
      }
      try {
        await inspectLocal(source.path, 'file');
      } catch {
        return 'The original transcript could not be verified.';
      }
      const recorded = (await store.sessions()).find(session => session.id === id);
      if (!recorded?.cwd || pathKey(localPath(recorded.cwd) ?? '') !== pathKey(scope.cwd)) {
        return 'The session’s recorded working directory has changed or could not be verified.';
      }
      const writer = await adapter.checkWriter?.(scope);
      if (writer === 'present' || recorded.status === 'Live' || recorded.status === 'Waiting') {
        return 'This session may still be open in another client. Close that client before continuing.';
      }
      if (writer !== 'absent') return 'The session’s current writer could not be verified.';
    }
    // Settings and trust can change during the filesystem checks.
    if (!workspace.isTrusted || !approvedProfile(scope) || !workspace.getWorkspaceFolder(Uri.file(scope.cwd))) {
      return 'The trusted workspace or profile changed. Reopen the conversation to continue.';
    }
  }

  async function checkDelivery(attempt: ChatAttempt): Promise<'confirmed' | 'absent' | 'unknown'> {
    if (attempt.acknowledged) return 'confirmed';
    const { identity, id } = attempt;
    const adapter = adapterFor(identity.provider);
    const matches = exactSources(recordedId(identity), identity.provider);
    const source = matches[0];
    if (!adapter || matches.length !== 1 || !source || source.profileId !== identity.profile || !approvedProfile(identity)) return 'unknown';
    const reader = new SourceReader(adapter, source);
    let partial = false;
    try {
      for (let cycle = 0; cycle < 128; cycle++) {
        const batch = await reader.read(source);
        if (batch.events.some(event => event.kind === 'message' && event.role === 'user' && event.recordId === id)) return 'confirmed';
        partial ||= Boolean(batch.diagnostics.malformed || batch.diagnostics.oversized);
        if (!batch.more) {
          const info = await inspectLocal(source.path, 'file');
          if (partial || BigInt(batch.committed) !== info.size) return 'unknown';
          return await adapter.chat?.checkWriter?.(identity) === 'absent' ? 'absent' : 'unknown';
        }
      }
    } catch {
      return 'unknown';
    }
    return 'unknown';
  }

  const chat = new ChatSessions({
    adapter: provider => adapterFor(provider)?.chat,
    validate: validateChat,
    changed: key => panel.update(key),
    claim: launch => claimChatWriter(context.globalStorageUri.fsPath, launch),
    recoveries,
    checkDelivery,
    persist: (attempt, remove) => persistAttempt(attemptDirectory, attempt, remove),
  });
  ownedChat = chat;

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
    refresh: () => refreshGate(relay.refreshState()),
    thresholds: () => ({ warnPercent: signalSettings.warnPercent, criticalPercent: signalSettings.criticalPercent }),
    canContinue,
  });
  const status = new StatusView('agentLens.openUsage');

  function visibility(): void {
    const visible = sidebarVisible || panelVisible;
    for (const roots of observers.values()) {
      for (const observer of roots) observer.setVisible(visible);
    }
    relay.setVisible(visible);
  }

  function editorSession(key: string): string | undefined {
    const identity = chat.identity(key);
    if (!identity) return undefined;
    const id = recordedId(identity);
    catalogEditors.set(id, key);
    return id;
  }

  async function resolveSessionEditor(id: string): Promise<string> {
    const existing = catalogEditors.get(id);
    if (existing && chat.identity(existing)) return existing;
    // The M1 history reader keeps one selected materialization, so serialize these requests.
    const pending = prepareChain.then(() => store.materialize(id));
    prepareChain = pending.catch(() => undefined);
    const session = await pending.catch(() => undefined) ?? (await store.sessions()).find(item => item.id === id);
    const identity = session && identityFor(session);
    const key = identity ? chat.observe(identity, catalogEditors.get(id) ?? id) : catalogEditors.get(id) ?? id;
    catalogEditors.set(id, key);
    return key;
  }

  async function openSession(id: string, tab: PanelTab, focus?: { lane: string; row: string }, from?: string, start = false): Promise<void> {
    const key = await resolveSessionEditor(id);
    panel.show({ kind: 'chat', key, id, tab, focus, from });
    if (start) chatRequest(key, { type: 'chatContinue' });
  }

  function workspaceChoices() {
    return (workspace.workspaceFolders ?? []).flatMap(folder => {
      const cwd = folder.uri.scheme === 'file' ? localPath(folder.uri.fsPath) : undefined;
      return cwd ? [{ label: folder.name, cwd }] : [];
    });
  }

  function chatProfiles() {
    return profiles().filter(profile => profile.provider === chatProvider);
  }

  function newChat(): void {
    const workspaces = workspaceChoices();
    const active = window.activeTextEditor?.document.uri;
    const activeFolder = active && workspace.getWorkspaceFolder(active);
    const folder = workspaces.length === 1 ? workspaces[0]
      : workspaces.find(item => activeFolder && pathKey(item.cwd) === pathKey(activeFolder.uri.fsPath));
    const eligible = chatProfiles();
    const profile = eligible.find(item => item.id === 'default') ?? (eligible.length === 1 ? eligible[0] : undefined);
    const scope = folder && profile ? { provider: profile.provider, profile: profile.id, home: profile.home, cwd: folder.cwd } : undefined;
    panel.show({ kind: 'chat', key: chat.create(scope), tab: 'chat' });
  }

  async function chooseScope(key: string): Promise<void> {
    const folders = workspaceChoices();
    const folder = folders.length === 1 ? folders[0]
      : await window.showQuickPick(folders, { placeHolder: 'Choose the workspace folder for this chat' });
    if (!folder) return;
    const available = chatProfiles();
    const profile = available.length === 1 ? available[0]
      : (await window.showQuickPick(available.map(item => ({ label: item.label, profile: item })),
        { placeHolder: 'Choose the chat profile' }))?.profile;
    if (profile) chat.setScope(key, { provider: profile.provider, profile: profile.id, home: profile.home, cwd: folder.cwd });
  }

  function chatRequest(key: string, request: ChatPanelRequest): void {
    if (request.type === 'chatChooseScope') {
      void chooseScope(key);
    } else if (request.type === 'chatInterrupt' || !privateMode()) {
      void chat.handle(key, request);
    }
  }

  async function restoreEditor(webviewPanel: WebviewPanel, state: unknown): Promise<void> {
    const saved = typeof state === 'object' && state !== null ? state as Record<string, unknown> : {};
    const id = typeof saved.session === 'string' && catalogKey.test(saved.session) ? saved.session : undefined;
    let target: PanelTarget;
    if (saved.view === 'usage' || saved.view === 'tasks') {
      target = { kind: saved.view };
    } else {
      const recovery = typeof saved.chatKey === 'string' ? chat.recover(saved.chatKey) : undefined;
      if (recovery && id) catalogEditors.set(id, recovery);
      target = { kind: 'chat', key: recovery ?? (id ? await resolveSessionEditor(id) : chat.create()), id };
    }
    panel.restore(webviewPanel, target);
  }

  const panel = new PanelView(context.extensionUri, data, {
    chat: async (key, id) => {
      if (id && !chat.scope(key) && exactSources(id, chatProvider).length === 1 && !chat.identity(key)) {
        await resolveSessionEditor(id);
      }
      const scope = chat.scope(key);
      const reason = !scope ? id ? 'Continue requires an exact local session and its original chat profile.'
        : !workspaceChoices().length ? 'Open a local workspace folder to start a chat.'
          : !chatProfiles().length ? 'Enable a local chat profile to start a chat.' : 'Choose the workspace and profile for this chat.'
        : !workspace.isTrusted ? 'Trust this workspace to use chat.' : undefined;
      return data.chat(key, id, scope, presentation => chat.view(key, presentation), reason);
    },
    chatRequest,
    sessionId: editorSession,
    openSession: (id, tab, focus, from) => void openSession(id, tab, focus, from),
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
    openParent: (session, lane, from) => void openParent(session, lane, from),
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
    newChat,
    openSession: (id, mode, start) => void openSession(id, mode, undefined, undefined, start),
    openParent: id => void openParent(id, ''),
    openUsage: () => panel.show({ kind: 'usage' }),
    openTasks: () => panel.show({ kind: 'tasks' }),
    relay: (command, profile) => void relay.command(command, profile),
    accountStatus: key => openAccountStatus(key),
  });

  /** Open the parent row of a lane. Several launches of a resumed Codex thread open a small menu, newest first. */
  async function openParent(sessionId: string, laneId: string, from?: string): Promise<void> {
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
    if (picked) await openSession(picked.sessionId, 'timeline', { lane: picked.laneId, row: picked.rowId }, from);
  }

  function showAlerts(): void {
    if (!alertsEnabled) return;
    void data.contextCandidates().then(candidates => {
      for (const alert of alerts.next(candidates)) {
        void window.showWarningMessage(alertText(alert), 'Open Agent map').then(choice => {
          if (choice) void openSession(alert.sessionId, 'map');
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
    window.registerWebviewPanelSerializer(PanelView.viewType, { deserializeWebviewPanel: restoreEditor }),
    commands.registerCommand('agentLens.newChat', newChat),
    commands.registerCommand('agentLens.openUsage', () => panel.show({ kind: 'usage' })),
    commands.registerCommand('agentLens.openTasks', () => panel.show({ kind: 'tasks' })),
    commands.registerCommand('agentLens.openParent', () => {
      const active = panel.currentSession();
      if (!active) void window.showInformationMessage('Open a session in Agent Lens first.');
      else void openParent(active.id, '', active.key);
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
      if (event.affectsConfiguration('agentLens.chat.permissionMode')) setChatPermissionMode(configured('chat.permissionMode'));
      if (event.affectsConfiguration('agentLens.agents')) {
        chat.invalidate('Chat profiles changed. Check the original profile before continuing.');
        refreshConfiguration();
      }
      else if (event.affectsConfiguration('agentLens.privateDisplay')) refreshViews();
      else if (event.affectsConfiguration('agentLens.signals') || event.affectsConfiguration('agentLens.context')) {
        readSignalSettings();
        refreshViews();
      }
    }),
    workspace.onDidChangeWorkspaceFolders(event => {
      if (event.removed.length) chat.invalidate('The workspace folders changed. Check the original folder before continuing.');
      refreshViews();
    }),
    workspace.onDidGrantWorkspaceTrust(refreshViews),
    { dispose: disposeObservers },
    { dispose: () => { chat.dispose(); relay.dispose(); panel.dispose(); status.dispose(); } },
  );
  refreshConfiguration();
  return store;
}

export async function deactivate(): Promise<void> {
  await ownedChat?.dispose();
  ownedChat = undefined;
}
