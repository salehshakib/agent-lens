import { StatusBarAlignment, window } from 'vscode';
import type { StatusBarItem } from 'vscode';
import type { Provider } from '../adapters/types';
import type { Gauge } from '../limits/model';
import { providerQuota } from './data';

const providers: Provider[] = ['claude-code', 'codex'];

/** One status bar entry: live session count plus the main quota windows. Click opens Usage. */
export class StatusView {
  private readonly item: StatusBarItem;

  constructor(command: string) {
    this.item = window.createStatusBarItem('agentLens.status', StatusBarAlignment.Left, 50);
    this.item.name = 'Agent Lens';
    this.item.command = command;
  }

  update(live: number, gauges: readonly Gauge[]): void {
    const quotas = providers.map(provider => providerQuota(gauges, provider)).filter(item => item !== undefined);
    const lines = [live + (live === 1 ? ' live session' : ' live sessions'), ...quotas.map(item => item.tooltip)];
    this.item.text = '$(eye) ' + live + (quotas.length ? ' · ' + quotas.map(item => item.text).join(' · ') : '');
    this.item.tooltip = lines.join('\n') + '\nClick to open usage.';
    this.item.accessibilityInformation = { label: lines.join('. '), role: 'button' };
    this.item.show();
  }

  dispose(): void {
    this.item.dispose();
  }
}
