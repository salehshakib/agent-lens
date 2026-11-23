import type { RelayView } from '../shared/protocol';
import { api, button, el } from './dom';

/** Consent and status card for the Claude status-line relay. Nothing changes until the user presses Enable relay. */
export function relayCard(item: RelayView): HTMLElement {
  const send = (command: 'enable' | 'decline' | 'uninstall') => () => api.postMessage({ type: 'relay', command, profile: item.profileId });
  const actions = item.state === 'not-installed'
    ? [button('Enable relay', send('enable'), { cls: 'primary' }), button('Not now', send('decline'))]
    : item.state === 'declined' ? [button('Enable relay', send('enable'), { cls: 'primary' })]
      : item.state === 'installed' ? [button('Remove relay', send('uninstall'))] : [];
  return el('div', { cls: 'relay', attrs: { 'data-state': item.state } },
    el('strong', { text: 'Claude Code · ' + item.profile }),
    el('p', { text: item.detail }),
    actions.length ? el('div', { cls: 'actions' }, ...actions) : undefined);
}
