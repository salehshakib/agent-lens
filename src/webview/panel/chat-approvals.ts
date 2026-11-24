import type { ChatApproval, PanelRequest } from '../../shared/protocol';
import { approvalActionable } from '../../shared/approval-state';
import { button, clean, el } from '../dom';

/** Persistent rules (permission_suggestions) are not verified, so none are offered. */
export const rulesNote = 'Always allow rules: not available yet.';

const endText: Record<Exclude<ChatApproval['state'], 'pending'>, string> = {
  allowed: 'Allowed once.',
  denied: 'Denied.',
  expired: 'Timed out and denied.',
  closed: 'No longer pending. Denied or closed with the chat channel.',
  interrupted: 'Denied because the turn was interrupted.',
};

/** Inline permission card. It never takes focus by itself, so typing in the composer is not interrupted. */
export function renderApproval(approval: ChatApproval, post: (request: PanelRequest) => void): HTMLElement {
  const title = el('strong', { text: 'Permission needed: ' + approval.toolName });
  const box = el('section', { cls: 'chat-approval', attrs: { role: 'group', 'aria-label': 'Permission request for ' + clean(approval.toolName),
    'data-state': approval.state } }, title);
  if (approval.description) box.append(el('p', { cls: 'chat-approval-description', text: approval.description }));
  if (approval.preview) {
    box.append(el('pre', { cls: 'chat-approval-preview', attrs: { 'aria-label': 'Arguments, shortened and redacted', tabindex: 0 }, text: approval.preview }));
  }
  if (approvalActionable(approval)) {
    let sent = false;
    const decide = (decision: 'allow' | 'deny') => () => {
      if (sent) return;
      sent = true;
      for (const control of box.querySelectorAll('button')) control.disabled = true;
      post({ type: 'chatApproval', id: approval.id, decision });
    };
    box.append(el('div', { cls: 'chat-approval-actions' },
      button('Allow once', decide('allow'), { attrs: { 'data-key': 'allow' } }),
      button('Deny', decide('deny'), { attrs: { 'data-key': 'deny' } })));
    box.append(el('p', { cls: 'muted', text: rulesNote }));
  } else {
    box.append(el('p', { cls: 'muted', attrs: { role: 'status' },
      text: approval.state === 'pending' ? approval.note ?? '' : endText[approval.state] + (approval.note ? ' ' + approval.note : '') }));
  }
  return box;
}
