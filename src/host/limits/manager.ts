import { join } from 'node:path';
import { window, workspace } from 'vscode';
import type { Memento } from 'vscode';
import type { RelayCommand, RelayView } from '../../shared/protocol';
import { formatAge } from '../../shared/format';
import { limitSamples, readSnapshots } from './claude-relay';
import type { RelaySnapshot } from './claude-relay';
import type { LimitSample } from './model';
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

/** Owns the Claude status-line relay for every Claude profile: consent, install, removal and snapshot cache. */
export class RelayManager {
  private readonly cache = new Map<string, Cache>();
  private profiles: RelayProfile[] = [];
  private timer?: NodeJS.Timeout;
  private busy = false;

  constructor(
    private readonly storage: string,
    private readonly relayScript: string,
    private readonly state: Memento,
    private readonly changed: () => void,
    private readonly now: () => number = Date.now,
  ) {}

  setProfiles(profiles: readonly RelayProfile[]): void {
    this.profiles = [...profiles];
    for (const id of [...this.cache.keys()]) if (!this.profiles.some(profile => profile.id === id)) this.cache.delete(id);
    void this.poll();
  }

  /** Poll while a view is visible. The relay writes one small file per Claude session. */
  setVisible(visible: boolean): void {
    clearInterval(this.timer);
    this.timer = undefined;
    if (!visible) return;
    void this.poll();
    this.timer = setInterval(() => void this.poll(), 15_000);
  }

  dispose(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  snapshots(profileId: string): { snapshots: RelaySnapshot[]; samples: LimitSample[] } {
    const cached = this.cache.get(profileId);
    return { snapshots: cached?.snapshots ?? [], samples: cached?.samples ?? [] };
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
          detail: 'The relay needs Node.js on PATH to run. Install Node.js to show Claude limits and context.' };
      }
      if (declined.includes(profile.id)) {
        return { ...base, state: 'declined' as const,
          detail: 'The relay is off. Claude limits and context are not shown. You can enable it at any time.' };
      }
      return { ...base, state: 'not-installed' as const,
        detail: 'Claude limits and context need a small status-line relay. Nothing is changed until you enable it.' };
    });
  }

  async poll(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      let changed = false;
      const nodeMissing = this.profiles.length > 0 && !await onPath('node');
      for (const profile of this.profiles) {
        const dirs = relayDirectories(this.storage, profile.home);
        const installed = await relayState({ home: profile.home, storage: this.storage }) === 'installed';
        const snapshots = installed ? await readSnapshots(dirs.snapshots) : [];
        const next: Cache = { installed, nodeMissing, snapshots, samples: limitSamples(snapshots, profile.id) };
        const previous = this.cache.get(profile.id);
        if (!previous || previous.installed !== installed || previous.nodeMissing !== nodeMissing
          || JSON.stringify(previous.snapshots) !== JSON.stringify(snapshots)) changed = true;
        this.cache.set(profile.id, next);
      }
      if (changed) this.changed();
    } finally {
      this.busy = false;
    }
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
      await window.showInformationMessage(
        'Refresh limits is not available yet. It waits for a verified check of the Claude usage report. '
        + 'Limits update from the status-line relay.');
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
