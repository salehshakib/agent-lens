import { join } from 'node:path';
import { window, workspace } from 'vscode';
import type { Memento } from 'vscode';
import type { RelayCommand, RelayView } from '../../shared/protocol';
import { formatAge } from '../../shared/format';
import { probeClaudeLimits, probeSamples, resolveClaude } from './claude-probe';
import { limitSamples, readSnapshots } from './claude-relay';
import type { RelaySnapshot } from './claude-relay';
import { latestSamples } from './model';
import type { LimitSample } from './model';
import type { RefreshState } from './refresh';
import { defaultPrecedencePaths, installRelay, onPath, relayDirectories, relayState, uninstallRelay } from './settings';

export interface RelayProfile {
  id: string;
  label: string;
  home: string;
}

interface Cache {
  installed: boolean;
  nodeMissing: boolean;
  snapshots: RelaySnapshot[];
  samples: LimitSample[];
}

const declinedKey = 'agentLens.relay.declined';
const probeIntervalMs = 10 * 60_000;

interface ProbeCache {
  attemptedAt: number;
  samples: LimitSample[];
}

/** Owns Claude limit probes and status-line relays for the configured profiles. */
export class RelayManager {
  private readonly cache = new Map<string, Cache>();
  private readonly probes = new Map<string, ProbeCache>();
  private profiles: RelayProfile[] = [];
  private timer?: NodeJS.Timeout;
  private busy = false;
  private claudeFound = false;
  private probeRunning = false;
  private probeError?: string;
  private disposed = false;

  constructor(
    private readonly storage: string,
    private readonly relayScript: string,
    private readonly state: Memento,
    private readonly changed: () => void,
    private readonly now: () => number = Date.now,
  ) {}

  setProfiles(profiles: readonly RelayProfile[]): void {
    for (const profile of this.profiles) {
      if (profiles.some(next => next.id === profile.id && next.home === profile.home)) continue;
      this.cache.delete(profile.id);
      this.probes.delete(profile.id);
    }
    this.profiles = [...profiles];
    void this.poll();
  }

  /** Poll while a view is visible. The relay writes one small file per Claude session. */
  setVisible(visible: boolean): void {
    clearInterval(this.timer);
    this.timer = undefined;
    if (!visible || this.disposed) return;
    this.timer = setInterval(() => void this.poll(), 15_000);
    void this.poll();
  }

  dispose(): void {
    this.disposed = true;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  snapshots(profileId: string): { snapshots: RelaySnapshot[]; samples: LimitSample[] } {
    const cached = this.cache.get(profileId);
    const probed = this.probes.get(profileId);
    return { snapshots: cached?.snapshots ?? [], samples: [...cached?.samples ?? [], ...probed?.samples ?? []] };
  }

  refreshState(): RefreshState {
    return { claudeFound: this.claudeFound, profiles: this.profiles.length, running: this.probeRunning, error: this.probeError };
  }

  private autoProbe(): void {
    if (!this.timer || !this.claudeFound || this.probeRunning) return;
    const staleBefore = this.now() - probeIntervalMs;
    const profile = this.profiles.find(item => {
      const attempt = this.probes.get(item.id)?.attemptedAt;
      return (attempt === undefined || attempt <= staleBefore) &&
        this.snapshots(item.id).samples.every(sample => sample.at < staleBefore);
    });
    if (profile) void this.runProbe(profile, false);
  }

  private async runProbe(profile: RelayProfile, manual: boolean): Promise<void> {
    if (this.probeRunning || this.disposed) return;
    this.probeRunning = true;
    const entry = { attemptedAt: this.now(), samples: this.probes.get(profile.id)?.samples ?? [] };
    this.probes.set(profile.id, entry);
    this.changed();
    try {
      const result = await probeClaudeLimits(profile.home, join(this.storage, 'probe'), this.now)
        .catch(() => ({ ok: false as const, message: 'Could not run Claude Code from the limit refresh folder.' }));
      if (this.disposed || this.probes.get(profile.id) !== entry) return;
      this.probeError = result.ok ? undefined : result.message;
      if (result.ok) {
        entry.samples = latestSamples([...entry.samples, ...probeSamples(result, profile.id)]);
      } else if (manual) {
        void window.showWarningMessage('Could not refresh Claude limits for "' + profile.label + '". ' + result.message);
      }
    } finally {
      this.probeRunning = false;
      if (!this.disposed) this.changed();
    }
  }

  private declined(): string[] {
    const value = this.state.get<unknown>(declinedKey);
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  }

  views(): RelayView[] {
    const declined = this.declined();
    return this.profiles.map(profile => {
      const cached = this.cache.get(profile.id);
      const base = { profileId: profile.id, profile: profile.label };
      if (cached?.installed) {
        const newest = cached.snapshots.reduce((max, snapshot) => Math.max(max, snapshot.capturedAt), 0);
        return { ...base, state: 'installed' as const, detail: newest
          ? 'Relay enabled. Last data from Claude Code ' + formatAge(newest, this.now()) + '.'
          : 'Relay enabled. Waiting for Claude Code to send its next status update.' };
      }
      if (cached?.nodeMissing) {
        return { ...base, state: 'unavailable' as const,
          detail: 'The relay needs Node.js on PATH to show live Claude context fill.' };
      }
      if (declined.includes(profile.id)) {
        return { ...base, state: 'declined' as const,
          detail: 'The relay is off. You can enable it at any time to show live Claude context fill.' };
      }
      return { ...base, state: 'not-installed' as const,
        detail: 'Enable the optional status-line relay to show live Claude context fill.' };
    });
  }

  async poll(): Promise<void> {
    if (this.busy || this.disposed) return;
    this.busy = true;
    try {
      const [nodeFound, claude] = this.profiles.length > 0
        ? await Promise.all([onPath('node'), resolveClaude()])
        : [true, undefined];
      const nodeMissing = !nodeFound;
      let changed = this.claudeFound !== Boolean(claude);
      this.claudeFound = Boolean(claude);
      for (const profile of this.profiles) {
        const dirs = relayDirectories(this.storage, profile.home);
        const installed = await relayState({ home: profile.home, storage: this.storage }) === 'installed';
        const snapshots = installed ? await readSnapshots(dirs.snapshots) : [];
        if (!this.profiles.some(item => item.id === profile.id && item.home === profile.home)) continue;
        const next: Cache = { installed, nodeMissing, snapshots, samples: limitSamples(snapshots, profile.id) };
        const previous = this.cache.get(profile.id);
        if (!previous || previous.installed !== installed || previous.nodeMissing !== nodeMissing
          || JSON.stringify(previous.snapshots) !== JSON.stringify(snapshots)) changed = true;
        this.cache.set(profile.id, next);
      }
      if (changed && !this.disposed) this.changed();
    } finally {
      this.busy = false;
    }
    this.autoProbe();
  }

  private precedencePaths(): string[] {
    const folders = workspace.workspaceFolders?.map(folder => folder.uri.fsPath) ?? [];
    return [
      ...defaultPrecedencePaths(),
      ...folders.flatMap(folder => [join(folder, '.claude', 'settings.json'), join(folder, '.claude', 'settings.local.json')]),
    ];
  }

  async command(command: RelayCommand, profileId: string): Promise<void> {
    const profile = this.profiles.find(item => item.id === profileId);
    if (!profile) return;
    const locations = { home: profile.home, storage: this.storage };
    if (command === 'refresh') {
      await this.runProbe(profile, true);
      return;
    }
    if (command === 'decline') {
      await this.state.update(declinedKey, [...new Set([...this.declined(), profile.id])]);
      this.changed();
      return;
    }
    if (command === 'enable') {
      if (!await onPath('node')) {
        await window.showWarningMessage('Node.js was not found on PATH. The relay needs it to run, so nothing was changed.');
        await this.poll();
        return;
      }
      const choice = await window.showInformationMessage(
        'Enable the Agent Lens status-line relay for "' + profile.label + '"?',
        {
          modal: true,
          detail: 'Agent Lens will add one statusLine entry to this profile\'s Claude settings file. Claude Code will pass '
            + 'its limit and context numbers to a small script that saves only those numbers on this computer. '
            + 'Your current status line, if any, keeps running. You can remove the relay at any time and your previous '
            + 'setting is restored.',
        },
        'Enable relay',
      );
      if (choice !== 'Enable relay') return;
      const result = await installRelay({ ...locations, relayScript: this.relayScript, precedencePaths: this.precedencePaths() });
      await (result.ok ? window.showInformationMessage(result.message) : window.showWarningMessage(result.message));
      if (result.ok) await this.state.update(declinedKey, this.declined().filter(id => id !== profile.id));
    } else {
      const choice = await window.showInformationMessage(
        'Remove the Agent Lens status-line relay for "' + profile.label + '"?',
        { modal: true, detail: 'Your previous status line is restored if you have not changed it since.' },
        'Remove relay',
      );
      if (choice !== 'Remove relay') return;
      const result = await uninstallRelay(locations);
      await (result.ok ? window.showInformationMessage(result.message) : window.showWarningMessage(result.message));
    }
    await this.poll();
    this.changed();
  }
}
