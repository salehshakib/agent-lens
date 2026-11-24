import type { ChatApproval } from './protocol';

/** The controls exist only while the request is pending and nothing has paused it. */
export function approvalActionable(approval: ChatApproval): boolean {
  return approval.state === 'pending' && !approval.note;
}
