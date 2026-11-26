import { createHmac, randomUUID } from 'node:crypto';
import { mkdir, opendir, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { commands, Uri, window, workspace } from 'vscode';
import type { ExtensionContext, WebviewPanel } from 'vscode';
import { statusTerminal } from './host/accounts/terminal';
import { profileKey } from './host/accounts/profiles';
import { adapters } from './host/adapters/registry';
import { isClaudeSessionId, officialResumeText, setChatPermissionMode, verifiedExecutable } from './host/adapters/claude-code/chat';
import { canCheckFast, claudeChatSettings } from './host/adapters/claude-code/chat-settings';
import type { ChatSettingCommand } from './host/adapters/claude-code/chat-settings';
import { minimumClaudeCodeVersion, supportsClaudeCodeVersion } from './host/adapters/claude-code/version';
import type { Adapter, Provider, Source } from './host/adapters/types';
import { parseChatInput, slashCatalog, slashSuggestions, terminalHandoffReason } from './host/chat/commands';
import { codexLinkedRuns, codexStartReason, unverifiedCodexRun } from './host/chat/codex-launch';
import { claimChatWriter } from './host/chat/ownership';
import { ChatSessions } from './host/chat/session';
import type { LocalChatRow } from './host/chat/session';
import type { ChatAttempt, ChatIdentity, ChatLaunch, ChatScope } from './host/chat/types';
import { accessError, inspectLocal, localPath, openLocalFile, pathKey } from './host/discovery/local-path';
import { RootObservation } from './host/discovery/observation';
import { SourceReader } from './host/discovery/reader';
import { configureRoots } from './host/discovery/roots';
import type { RootConfiguration } from './host/discovery/roots';
import { registerFileActions } from './host/files/actions';
import { profileEnv } from './host/limits/claude-probe';
import { RelayManager } from './host/limits/manager';
import type { RelayProfile } from './host/limits/manager';
import { refreshGate } from './host/limits/refresh';
import { safeText } from './host/privacy/projection';
import { claudeTaskRoot } from './host/sessions/delegation';
import { key as sessionKey, sourceSessionId } from './host/sessions/evidence';
import { resolveProject } from './host/sessions/project';
import { defaultSignalSettings, parseSignalSettings } from './host/sessions/signals';
import type { SignalSettings } from './host/sessions/signals';
import { SessionStore } from './host/sessions/store';
import type { RowRef, Session } from './host/sessions/types';
import { alertText, ContextAlerts } from './host/views/alerts';
import { compactChatCard, compactContextEvidence, projectChatCard } from './host/views/chat-cards';
import type { ChatCardTarget, InspectionCommand } from './host/views/chat-cards';
import { LensData } from './host/views/data';
import type { ProfileInfo } from './host/views/data';
import { namesFor, projectLabel, providerLabels } from './host/views/models';
import { PanelView } from './host/views/panel';
import type { ChatPanelRequest, PanelTarget } from './host/views/panel';
import { SidebarView } from './host/views/sidebar';
import { StatusView } from './host/views/status';
import { maxSearch } from './shared/protocol';
import type { ChatCard, ChatCardAction, ChatCardEntry, ChatView, PanelTab, SessionDetail, SourceView } from './shared/protocol';

type CommandTarget = ChatCardTarget
  | { kind: 'allProjects' | 'moreHistory' | 'historySearch' | 'chooseProject' | 'sendAsText' | 'openAllProjects' }
  | { kind: 'releaseTerminal' | 'openTerminal'; command: string }
  | { kind: 'applySetting'; setting: ChatSettingCommand; value: string }
  | { kind: 'continue'; session: string }
  | { kind: 'parked'; key: string }
  | { kind: 'codexOrigin'; origin: RowRef }
  | { kind: 'codexFollow'; target: RowRef; origin: RowRef; turn: string };

interface CommandGrant {
  row: string;
  target: CommandTarget;
  input?: ChatCardAction['input'];
}

const inspectionCommands = new Set<string>(['usage', 'context', 'agents', 'files', 'diff', 'tasks', 'status']);

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

  function newChat(preferredCwd?: string): void {
    const workspaces = workspaceChoices();
    const active = window.activeTextEditor?.document.uri;
    const activeFolder = active && workspace.getWorkspaceFolder(active);
    const preferred = preferredCwd && workspace.isTrusted && workspace.getWorkspaceFolder(Uri.file(preferredCwd))?.uri.scheme === 'file';
    const folder = preferred ? { cwd: preferredCwd } : workspaces.length === 1 ? workspaces[0]
      : workspaces.find(item => activeFolder && pathKey(item.cwd) === pathKey(activeFolder.uri.fsPath));
    const eligible = chatProfiles();
    const profile = eligible.find(item => item.id === 'default') ?? (eligible.length === 1 ? eligible[0] : undefined);
    const scope = folder?.cwd && profile ? { provider: profile.provider, profile: profile.id, home: profile.home, cwd: folder.cwd } : undefined;
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


  const actionSecret = randomUUID();
  const cardGrants = new Map<string, Map<string, CommandGrant>>();
  const runningCardActions = new Set<string>();
  let commandGeneration = 0;

  function commandScope(view: ChatView): string {
    return view.commandScope || 'Current conversation';
  }

  function handoffState(key: string) {
    const identity = chat.identity(key);
    const state = chat.commandState(key);
    return {
      trusted: workspace.isTrusted,
      exactSession: identity?.provider === 'claude-code' && isClaudeSessionId(identity.nativeId),
      approvedProfile: Boolean(identity && approvedProfile(identity)),
      localProject: Boolean(identity && workspace.getWorkspaceFolder(Uri.file(identity.cwd))?.uri.scheme === 'file'),
      owner: Boolean(state.owner),
      busy: state.busy,
    };
  }

  async function openOfficialTerminal(key: string, generation: number): Promise<string | undefined> {
    return chat.prepareTerminal(key, async launch => {
      if (process.platform !== 'win32') return 'The verified official terminal route requires Windows.';
      const systemRoot = process.env.SystemRoot;
      const shell = systemRoot && localPath(join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
      if (!shell) return 'Windows PowerShell is unavailable for the official terminal.';
      await inspectLocal(shell, 'file');
      const executable = await verifiedExecutable(AbortSignal.timeout(8_000));
      if (!supportsClaudeCodeVersion(executable.version)) return `The official terminal handoff requires Claude Code ${minimumClaudeCodeVersion} or newer.`;
      const text = officialResumeText(executable.path, launch.identity.nativeId);
      if (!text) return 'The official executable or exact session could not be verified.';
      const writer = await adapterFor(launch.identity.provider)?.chat?.checkWriter?.(launch.identity);
      if (privateMode() || generation !== commandGeneration) return 'The chat scope changed before the terminal could open.';
      const reason = terminalHandoffReason({ ...handoffState(key), busy: false, writer });
      if (reason) return reason;
      const env = { CLAUDE_CONFIG_DIR: profileEnv(launch.identity.home, {}).CLAUDE_CONFIG_DIR ?? null };
      const terminal = window.createTerminal({ name: 'Agent Lens: Official terminal', cwd: launch.identity.cwd,
        env, shellPath: shell, shellArgs: ['-NoLogo', '-NoProfile'] });
      terminal.sendText(text, false);
      terminal.show();
      return undefined;
    });
  }

  function resumeCard(key: string, command: LocalChatRow, scope: ChatScope | undefined, project: string | undefined,
    sessions: readonly Session[], label: string, action: (target: CommandTarget, name: string, input?: ChatCardAction['input']) => ChatCardAction): ChatCard {
    const actions = [action({ kind: 'historySearch' }, 'Search history', {
      label: 'Title or project', value: command.argument, maxLength: maxSearch,
    })];
    if (!command.allProjects) actions.push(action({ kind: 'allProjects' }, 'All projects'));
    if (!project || command.allProjects) actions.push(action({ kind: 'chooseProject' }, 'Choose workspace folder'));
    const names = namesFor(false);
    const filter = command.argument.toLowerCase();
    const matches = (title: string, path: string) => !filter || (title + '\n' + path).toLowerCase().includes(filter);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const entries: ChatCardEntry[] = [];
    if (!command.allProjects && !project) {
      return { title: 'Resume', scope: label, state: 'empty', message: 'Choose a workspace folder or browse All projects.', actions };
    }
    const projectCwd = command.resumeFolder?.cwd ?? scope?.cwd;
    for (const parked of chat.parked(key)) {
      const cwd = parked.scope?.cwd;
      if ((!command.allProjects && (!cwd || !projectCwd || pathKey(cwd) !== pathKey(projectCwd)))
        || !matches('New chat draft', cwd ?? '')) continue;
      entries.push({ title: 'New chat draft', detail: safeText(cwd, 160),
        actions: [action({ kind: 'parked', key: parked.key }, 'Open draft')] });
      if (entries.length >= 12) break;
    }
    const candidates = sessions.filter(session => (command.allProjects || session.project === project)
      && !session.parents.some(parent => parent.relation === 'child' || parent.relation === 'agent')
      && matches(names.session(session), session.cwd ?? projectLabel(session)));
    const group = (session: Session) => session.status === 'Live' || session.status === 'Waiting' || session.status === 'Writer present'
      ? 'Live' : session.updatedAt && session.updatedAt >= today.getTime() && session.updatedAt < tomorrow.getTime() ? 'Today' : 'Earlier';
    const groups = new Map(candidates.map(session => [session.id, group(session)]));
    const rank = ['Live', 'Today', 'Earlier'];
    candidates.sort((a, b) => rank.indexOf(groups.get(a.id)!) - rank.indexOf(groups.get(b.id)!)
      || (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    const limit = command.resumeLimit ?? 20;
    const available = profiles();
    for (const session of candidates.slice(0, limit)) {
      const identity = identityFor(session);
      const owningProfile = available.find(item => item.provider === session.provider && item.id === session.profile);
      const owned = identity && chat.keyFor(identity);
      const reason = !workspace.isTrusted ? 'Trust the workspace to continue.'
        : !identity ? 'Exact continuation is unavailable for this provider or profile.'
        : !workspace.getWorkspaceFolder(Uri.file(identity.cwd)) ? 'Open the recorded project in this workspace to continue.'
        : group(session) === 'Live' && !owned ? 'The recorded session has a live or waiting writer.'
        : undefined;
      const rowActions = [action({ kind: 'session', session: session.id }, 'Open conversation')];
      if (!reason) rowActions.push(action({ kind: 'continue', session: session.id }, 'Continue'));
      entries.push({
        title: names.session(session),
        detail: [groups.get(session.id), providerLabels[session.provider], owningProfile?.label ?? 'Profile unknown',
          safeText(session.cwd, 160) ?? projectLabel(session), session.status,
          session.updatedAt ? new Date(session.updatedAt).toLocaleString('en') : undefined, reason].filter(Boolean).join(' · '),
        actions: rowActions,
      });
    }
    if (candidates.length > limit && limit < 200) actions.push(action({ kind: 'moreHistory' }, 'Load older'));
    return {
      title: 'Resume', scope: command.allProjects ? 'All projects' : command.resumeFolder?.label ?? label,
      state: entries.length ? 'ready' : 'empty',
      message: entries.length ? undefined : 'No conversations match this project and search.',
      entries, actions,
    };
  }

  async function commandCards(key: string, id: string | undefined, view: ChatView, detail?: SessionDetail) {
    const rows = chat.localRows(key);
    const grants = new Map<string, CommandGrant>();
    const cards = new Map<string, ChatCard>();
    if (!rows.length || view.privateMode) return { cards, grants };
    const generation = commandGeneration;
    const scope = chat.scope(key);
    const sessions = await store.sessions();
    const session = id ? sessions.find(item => item.id === id) : undefined;
    const project = session?.project ?? (rows.some(row => row.command.name === 'resume') && scope
      ? (await resolveProject(scope.cwd)).key : undefined);
    const state = chat.commandState(key);
    const scopeStamp = chat.commandScopeStamp(key, id);
    const label = commandScope(view);
    const options = slashCatalog(state.capabilities, state.busy);
    const ownsProfile = scope && approvedProfile(scope);
    const cwd = scope?.cwd ?? session?.cwd;
    const refreshLimits = workspace.isTrusted && scope?.provider === 'claude-code' && ownsProfile && refreshGate(relay.refreshState()).enabled;
    const gauges = data.chatGauges(scope, session);
    const files = new Map(session?.files.map(file => [file.id, file]));
    for (const { id: row, command } of rows) {
      const action = (target: CommandTarget, label: string, input?: ChatCardAction['input']): ChatCardAction => {
        const boundTurn = target.kind === 'interrupt' || target.kind === 'releaseTerminal' || target.kind === 'openTerminal'
          || target.kind === 'applySetting' ? [state.owner, state.turn] : undefined;
        const boundRevision = target.kind === 'sendAsText' ? state.revision : undefined;
        const file = target.kind === 'file' || target.kind === 'diff' || target.kind === 'previewDiff'
          ? files.get(target.id) : undefined;
        const evidence = file
          ? [file.path, file.movePath, file.cwd, file.projectRoot, file.status, target.kind === 'file' ? undefined : file.diff]
          : target.kind === 'parent' ? detail?.agents.find(agent => agent.sessionId === target.session && agent.laneId === target.lane)?.parentInfo.targets
            : target.kind === 'transcript' ? store.transcriptSource(target.session, target.lane)?.key : undefined;
        const id = createHmac('sha256', actionSecret).update(JSON.stringify(
          [key, scope, session?.id, session?.profile, generation, row, command, target, evidence, boundTurn, boundRevision],
        )).digest('hex');
        grants.set(id, { row, target, input });
        return { id, label, input };
      };
      let card: ChatCard;
      if (command.scopeStamp !== scopeStamp) {
        card = { title: command.name ? '/' + command.name : 'Command', scope: 'Original conversation scope',
          state: 'changed', message: 'The project or profile changed. Submit the command again for the current scope.' };
      } else if (command.terminalName) {
        const gate = handoffState(key);
        const reason = terminalHandoffReason(gate, true);
        const canRelease = gate.owner && !gate.busy && gate.trusted && gate.exactSession && gate.approvedProfile && gate.localProject;
        card = { title: '/' + command.terminalName, scope: label, state: reason ? 'unavailable' : 'ready',
          message: reason ?? 'Open the official terminal, press Enter to resume, then enter /' + command.terminalName + '.',
          actions: canRelease ? [action({ kind: 'releaseTerminal', command: command.terminalName }, 'Release chat owner')]
            : !reason ? [action({ kind: 'openTerminal', command: command.terminalName }, 'Open official terminal')] : undefined };
      } else if (command.reason) {
        card = {
          title: command.name ? '/' + command.name : 'Command', scope: label,
          state: command.name ? 'unavailable' : 'denied', message: command.reason,
          entries: command.name ? undefined : slashSuggestions(command.argument, options).map(item => ({
            title: '/' + item.name, detail: item.description,
          })),
          actions: command.canSendAsText && view.canSend && state.revision === command.revision && state.capabilities?.literalText
            ? [action({ kind: 'sendAsText' }, 'Send as text')] : undefined,
        };
      } else if (inspectionCommands.has(command.name)) {
        const diff = command.diffId ? files.get(command.diffId) : undefined;
        card = projectChatCard(command.name as InspectionCommand, {
          scope: label, argument: command.argument, detail, usage: view.usage, loading: Boolean(id && !detail && session),
          privateMode: view.privateMode, now: Date.now(), gauges,
          context: session && detail ? data.chatContext(session, detail, scope, command.contextLane, state.compact)
            : state.compact && !command.contextLane ? compactContextEvidence('Main lane', state.compact) : undefined,
          contextLanes: detail?.lanes, selectedContextLane: command.contextLane ?? session?.lanes[0]?.id,
          status: { channel: view.state, reason: view.reason, owner: state.owner ? 'Agent Lens' : undefined,
            model: state.model ?? detail?.model, effort: state.capabilities?.effortActive ? undefined : detail?.effort,
            queued: 0, canInterrupt: view.canInterrupt },
          fileKind: command.fileKind, selectedDiff: diff ? { action: diff, title: diff.label } : undefined,
          refreshLimits, action,
        });
        if (command.diffId && !diff) card = { ...card, state: 'changed', message: 'This recorded change is no longer available.' };
      } else {
        switch (command.name) {
          case 'help': {
            const exact = options.find(item => item.route === 'Local'
              ? item.name === command.argument.toLowerCase() : item.name === command.argument);
            const entries = (exact ? [exact] : options).map(item => ({
              title: '/' + item.name + (item.arguments ? ' ' + item.arguments : ''),
              detail: [item.route, item.description, item.reason].filter(Boolean).join(' · '),
            }));
            card = { title: 'Help', scope: label, state: 'ready', entries,
              message: [
                command.argument && !exact ? 'No exact match. Similar entries: ' +
                  (slashSuggestions(command.argument, options).map(item => '/' + item.name).join(', ') || 'None') + '.' : '',
                state.capabilities?.version ? 'Provider catalog from version ' + state.capabilities.version + '.'
                  : 'Provider catalog is pending a verified chat connection.',
                state.owner ? 'Agent Lens owns the chat channel.' : 'No Agent Lens chat channel is open.',
              ].filter(Boolean).join(' ') };
            break;
          }
          case 'resume':
            card = resumeCard(key, command, scope, command.resumeFolder?.project ?? project, sessions, label, action);
            break;
          case 'model': case 'effort': case 'fast':
            const setting = command.name;
            const canSet = workspace.isTrusted && Boolean(scope && ownsProfile && workspace.getWorkspaceFolder(Uri.file(scope.cwd))
              && scope.provider === 'claude-code');
            card = claudeChatSettings(setting, label, command.argument, { model: state.model ?? detail?.model }, {
              requested: state.settings, capabilities: canSet ? state.capabilities : undefined, busy: state.busy,
              canStage: canSet && !state.owner, resolvedModel: state.resolvedModel, pending: command.result?.state === 'pending',
              status: command.result?.message,
              action: canSet ? (value, name, input) => action({ kind: 'applySetting', setting, value }, name, input) : undefined,
            });
            if (command.result?.message && command.result.state !== 'pending') {
              card = { ...card, ...(command.result.state === 'failed' ? { state: 'denied' } : {}),
                announcement: command.result.message };
            }
            break;
          case 'compact':
            card = compactChatCard(label, command.result?.state === 'completed' && command.result.compact
              ? { state: 'completed', measurement: command.result.compact }
              : command.result?.state === 'pending' ? { state: 'pending' } : { state: 'failed', reason: command.result?.message });
            break;
          case 'clear':
            card = { title: 'Clear', scope: label, state: 'ready', message: 'Opened a fresh tab. This conversation is still available.' };
            break;
          case 'codex': {
            const runs = command.codexMode === 'start' ? [] : codexLinkedRuns(session, sessions, command.argument, false);
            const reason = command.codexMode === 'follow' ? undefined
              : codexStartReason(cwd, profiles().some(item => item.provider === 'codex'), workspace.isTrusted);
            card = {
              title: command.codexMode === 'start' ? 'Start Codex run' : 'Linked Codex runs', scope: label,
              state: runs.length ? 'ready' : reason ? 'unavailable' : 'empty',
              message: [reason, command.codexMode === 'start' ? undefined : unverifiedCodexRun].filter(Boolean).join(' '),
              actions: command.codexMode === 'start' ? undefined : [action({ kind: 'openAllProjects' }, 'Open All projects')],
              entries: runs.map(run => ({
                title: run.title, detail: run.detail,
                actions: run.target ? [
                  action({ kind: 'codexFollow', target: run.target, origin: run.origin, turn: run.turn }, 'Open run'),
                  action({ kind: 'codexOrigin', origin: run.origin }, 'Open launch evidence'),
                ] : undefined,
              })),
            };
            break;
          }
          default:
            card = { title: 'Command', scope: label, state: 'unavailable', message: 'This action is unavailable.' };
        }
      }
      cards.set(row, command.actionIssue ? { ...card, state: 'changed', message: command.actionIssue } : card);
    }
    return { cards, grants };
  }

  async function runCardAction(key: string, id: string | undefined, request: Extract<ChatPanelRequest, { type: 'chatCardAction' }>): Promise<void> {
    const grant = cardGrants.get(key)?.get(request.id);
    if (!grant || runningCardActions.has(request.id)) return;
    runningCardActions.add(request.id);
    const issue = (actionIssue: string) => chat.updateLocal(key, grant.row, { actionIssue });
    try {
      const generation = commandGeneration;
      const scope = chat.scope(key);
      const model = await data.chat(key, id, scope, presentation => chat.view(key, presentation));
      if (model.mode !== 'chat') return;
      const { grants } = await commandCards(key, id, model.chat, model.session);
      const current = grants.get(request.id);
      if (privateMode() || commandGeneration !== generation || !current) {
        issue('The scope or evidence changed. Submit the command again.');
        return;
      }
      const { target, input, row } = current;
      if (input ? typeof request.input !== 'string' || request.input.length > input.maxLength || /[\r\n\u2028\u2029\0]/u.test(request.input)
        : request.input !== undefined) {
        issue('Enter a single line within the search limit.');
        return;
      }
      const command = chat.localRows(key).find(item => item.id === row)?.command;
      if (!command) return;
      const update = (change: Partial<LocalChatRow>) => chat.updateLocal(key, row, { ...change, actionIssue: undefined });
      switch (target.kind) {
        case 'releaseTerminal': {
          const reason = await chat.releaseForTerminal(key);
          if (reason) issue(reason);
          else update({});
          break;
        }
        case 'openTerminal': {
          const reason = await openOfficialTerminal(key, generation);
          if (reason) issue(reason);
          else update({});
          break;
        }
        case 'applySetting':
          await chat.applySetting(key, row, target.setting, target.value === ':custom' ? request.input ?? '' : target.value);
          break;
        case 'allProjects': update({ allProjects: true, resumeLimit: 20, resumeFolder: undefined }); break;
        case 'openAllProjects': await commands.executeCommand('agentLens.sessions.focus'); break;
        case 'moreHistory': update({ resumeLimit: (command.resumeLimit ?? 20) + 20 }); break;
        case 'historySearch': update({ argument: request.input!.trim(), resumeLimit: 20 }); break;
        case 'contextLane': update({ contextLane: target.lane }); break;
        case 'filterFiles':
          update({ fileKind: target.fileKind ?? command.fileKind, argument: request.input?.trim() ?? command.argument, diffId: undefined });
          break;
        case 'previewDiff': update({ diffId: target.id }); break;
        case 'backgroundTasks': update({ argument: 'background' }); break;
        case 'chooseProject': {
          const folders = workspaceChoices();
          const folder = folders.length === 1 ? folders[0]
            : await window.showQuickPick(folders, { placeHolder: 'Choose a workspace folder for history' });
          if (!folder) break;
          const project = await resolveProject(folder.cwd);
          if (commandGeneration === generation && chat.localRows(key).find(item => item.id === row)?.command === command) {
            update({ allProjects: false, resumeFolder: { cwd: folder.cwd, project: project.key,
              label: safeText(folder.label, 100) ?? 'Selected project' }, resumeLimit: 20 });
          }
          break;
        }
        case 'parked': panel.show({ kind: 'chat', key: target.key, tab: 'chat', from: key }); break;
        case 'session': case 'continue': await openSession(target.session, 'chat', undefined, key, target.kind === 'continue'); break;
        case 'parent': await openParent(target.session, target.lane, key); break;
        case 'transcript': openTranscript(target.session, target.lane); break;
        case 'view':
          if (target.view === 'allTasks' || (!id && target.view === 'tasks')) panel.show({ kind: 'tasks' });
          else if (!id && target.view === 'usage') panel.show({ kind: 'usage' });
          else if (id) panel.show({ kind: 'chat', key, id, tab: target.view,
            files: target.view === 'files' ? { search: safeText(command.argument, maxSearch) ?? '',
              kind: command.name === 'diff' ? 'changed' : command.fileKind ?? 'all' } : undefined });
          break;
        case 'file': case 'diff':
          if (!await commands.executeCommand('agentLens.files.' + (target.kind === 'file' ? 'open' : 'diff'), target.id)) {
            issue('The file or recorded diff is no longer available.');
          }
          break;
        case 'refreshLimits':
          if (workspace.isTrusted && scope && approvedProfile(scope) && refreshGate(relay.refreshState()).enabled) {
            await relay.command('refresh', scope.profile);
          }
          break;
        case 'interrupt': await chat.handle(key, { type: 'chatInterrupt' }); break;
        case 'sendAsText': await chat.sendAsText(key, command.revision); break;
        case 'codexFollow': {
          const sessions = await store.sessions();
          const run = codexLinkedRuns(sessions.find(item => item.id === id), sessions, command.argument, false)
            .find(item => item.target?.sessionId === target.target.sessionId && item.target.laneId === target.target.laneId
              && item.target.rowId === target.target.rowId && item.origin.rowId === target.origin.rowId
              && item.origin.laneId === target.origin.laneId && item.turn === target.turn);
          if (!run?.target || privateMode() || commandGeneration !== generation) issue('The linked run evidence is no longer available.');
          else await openSession(run.target.sessionId, 'timeline', { lane: run.target.laneId, row: run.target.rowId }, key);
          break;
        }
        case 'codexOrigin':
          await openSession(target.origin.sessionId, 'timeline', { lane: target.origin.laneId, row: target.origin.rowId }, key);
          break;
      }
    } catch {
      issue('Could not complete the action. Check the current scope and try again.');
    } finally {
      runningCardActions.delete(request.id);
    }
  }

  function openTranscript(session: string, lane: string): void {
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
  }

  function chatRequest(key: string, request: ChatPanelRequest, id?: string): void {
    if (request.type === 'chatInterrupt') { void chat.handle(key, request); return; }
    if (privateMode()) return;
    if (request.type === 'chatChooseScope') { void chooseScope(key); return; }
    if (request.type === 'chatCardAction') { void runCardAction(key, id, request); return; }
    chat.inspect(key);
    if (request.type !== 'chatSend') { void chat.handle(key, request); return; }
    const state = chat.commandState(key);
    const parsed = parseChatInput(request.text, state.capabilities, state.busy);
    if (parsed.kind === 'text' || parsed.kind === 'literal'
      || (parsed.kind === 'native' && parsed.route === 'Native' && !parsed.reason)) {
      void chat.handle(key, request);
      return;
    }
    if (parsed.kind === 'incomplete') return;
    const command = parsed.kind === 'local' ? parsed
      : parsed.kind === 'native' ? { name: safeText(parsed.name, 160) ?? 'Native command', argument: '', reason: parsed.reason,
        terminalName: parsed.route === 'Official terminal' && !parsed.reason ? parsed.name : undefined }
      : { name: '', argument: /^\/([A-Za-z0-9_.:-]+)/u.exec(request.text.trimStart())?.[1]?.slice(0, 160) ?? '',
        reason: parsed.reason, canSendAsText: parsed.canSendAsText };
    const preserve = command.name === 'codex' && parsed.kind === 'local' && parsed.codexMode === 'start'
      ? codexStartReason(chat.scope(key)?.cwd, profiles().some(profile => profile.provider === 'codex'), workspace.isTrusted)
      : undefined;
    if (!chat.local(key, request.revision, request.text, { ...command, scopeStamp: chat.commandScopeStamp(key, id) },
      Boolean(preserve || ('terminalName' in command && command.terminalName)))) return;
    if (command.name === 'fast' && command.argument === '' && !state.busy && canCheckFast(state.capabilities)) {
      const row = chat.localRows(key).at(-1)?.id;
      if (row) void chat.applySetting(key, row, 'fast', '');
    }
    if (command.name === 'clear' && !command.reason) {
      const cwd = chat.scope(key)?.cwd;
      if (cwd || !id) newChat(cwd);
      else void store.sessions().then(sessions => newChat(localPath(sessions.find(session => session.id === id)?.cwd ?? '')))
        .catch(() => newChat());
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
    chat: async (key, id, focus) => {
      if (id && !chat.scope(key) && exactSources(id, chatProvider).length === 1 && !chat.identity(key)) {
        await resolveSessionEditor(id);
      }
      chat.inspect(key);
      const scope = chat.scope(key);
      const reason = !scope ? id ? 'Continue requires an exact local session and its original chat profile.'
        : !workspaceChoices().length ? 'Open a local workspace folder to start a chat.'
          : !chatProfiles().length ? 'Enable a local chat profile to start a chat.' : 'Choose the workspace and profile for this chat.'
        : !workspace.isTrusted ? 'Trust this workspace to use chat.' : undefined;
      const model = await data.chat(key, id, scope, presentation => chat.view(key, presentation), reason, focus);
      if (model.mode !== 'chat') return model;
      const { cards, grants } = await commandCards(key, id, model.chat, model.session);
      if (grants.size) cardGrants.set(key, grants);
      else cardGrants.delete(key);
      return { ...model, chat: { ...model.chat,
        rows: model.chat.rows.map(row => cards.has(row.id) ? { ...row, card: cards.get(row.id) } : row) } };
    },
    chatRequest,
    sessionId: editorSession,
    openSession: (id, tab, focus, from) => void openSession(id, tab, focus, from),
    openFile: id => void commands.executeCommand('agentLens.files.open', id),
    openDiff: id => void commands.executeCommand('agentLens.files.diff', id),
    openTranscript,
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
    commands.registerCommand('agentLens.newChat', () => newChat()),
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
        commandGeneration++;
        chat.invalidate('Chat profiles changed. Check the original profile before continuing.');
        refreshConfiguration();
      }
      else if (event.affectsConfiguration('agentLens.privateDisplay')) {
        commandGeneration++;
        refreshViews();
      }
      else if (event.affectsConfiguration('agentLens.signals') || event.affectsConfiguration('agentLens.context')) {
        readSignalSettings();
        refreshViews();
      }
    }),
    workspace.onDidChangeWorkspaceFolders(event => {
      commandGeneration++;
      if (event.removed.length) chat.invalidate('The workspace folders changed. Check the original folder before continuing.');
      refreshViews();
    }),
    workspace.onDidGrantWorkspaceTrust(() => {
      commandGeneration++;
      refreshViews();
    }),
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
