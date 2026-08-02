import { v4 as uuidv4 } from 'uuid';

// FR-ADM-03: rejection of a withdrawal or verification request is accompanied
// by "a reason from a configurable list". This store is that list.
export type RejectionContext = 'kyc' | 'withdrawal';

export interface RejectionReason {
  id: string;
  context: RejectionContext;
  label: string;
  createdAt: Date;
}

const reasons = new Map<string, RejectionReason>();

const seed = (context: RejectionContext, labels: string[]) => {
  for (const label of labels) {
    const id = uuidv4();
    reasons.set(id, { id, context, label, createdAt: new Date() });
  }
};

seed('kyc', [
  'Identity document is blurry or unreadable',
  'Identity document is expired',
  'Selfie does not match the identity document',
  'Proof of address is older than 3 months',
  'Proof of address does not match the declared address',
  'Personal information does not match the documents',
  'Document appears altered or tampered with',
]);

seed('withdrawal', [
  'Beneficiary details do not match the account holder',
  'Insufficient verified balance',
  'Account verification (KYC) incomplete',
  'Suspicious activity — additional verification required',
]);

export const RejectionReasonsStore = {
  findAll(context?: RejectionContext): RejectionReason[] {
    const all = [...reasons.values()];
    return context ? all.filter((r) => r.context === context) : all;
  },

  findById(id: string): RejectionReason | undefined {
    return reasons.get(id);
  },

  create(context: RejectionContext, label: string): RejectionReason {
    const id = uuidv4();
    const reason: RejectionReason = { id, context, label, createdAt: new Date() };
    reasons.set(id, reason);
    return reason;
  },

  update(id: string, label: string): RejectionReason | undefined {
    const reason = reasons.get(id);
    if (!reason) return undefined;
    const updated = { ...reason, label };
    reasons.set(id, updated);
    return updated;
  },

  delete(id: string): boolean {
    return reasons.delete(id);
  },
};
