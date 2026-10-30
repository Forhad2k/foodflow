import { ApprovalStatus } from '@prisma/client';
import { DomainError } from '../common/errors/domain-error';

/** Restaurant approval workflow. Pure, so the admin and owner endpoints share one definition. */
export type ApprovalAction = 'approve' | 'reject' | 'suspend' | 'reinstate' | 'resubmit';

const S = ApprovalStatus;
const TABLE: Record<ApprovalAction, { from: ApprovalStatus; to: ApprovalStatus; actor: 'ADMIN' | 'OWNER'; reason: boolean }> = {
  approve: { from: S.PENDING, to: S.APPROVED, actor: 'ADMIN', reason: false },
  reject: { from: S.PENDING, to: S.REJECTED, actor: 'ADMIN', reason: true },
  suspend: { from: S.APPROVED, to: S.SUSPENDED, actor: 'ADMIN', reason: true },
  reinstate: { from: S.SUSPENDED, to: S.APPROVED, actor: 'ADMIN', reason: false },
  resubmit: { from: S.REJECTED, to: S.PENDING, actor: 'OWNER', reason: false },
};

export function applyApprovalAction(from: ApprovalStatus, action: ApprovalAction, reason?: string): ApprovalStatus {
  const rule = TABLE[action];
  if (from !== rule.from) {
    throw new DomainError('INVALID_APPROVAL_TRANSITION', `Cannot ${action} a restaurant that is ${from}`, 409, { from, action });
  }
  if (rule.reason && !reason?.trim()) throw new DomainError('REASON_REQUIRED', `A reason is required to ${action}`, 422);
  return rule.to;
}

export interface ReadinessFacts {
  activeZones: number;
  hourWindows: number;
  availableItems: number;
  cuisines: number;
}

/** What an owner must set up before a restaurant can go live. Empty array = ready. */
export function missingForApproval(f: ReadinessFacts): string[] {
  const missing: string[] = [];
  if (f.cuisines < 1) missing.push('Choose at least one cuisine');
  if (f.activeZones < 1) missing.push('Add at least one active delivery zone');
  if (f.hourWindows < 1) missing.push('Set opening hours');
  if (f.availableItems < 1) missing.push('Add at least one available menu item');
  return missing;
}
