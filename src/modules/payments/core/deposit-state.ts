/**
 * A deposit's state for its owner: what was CREDITED (a provider that credits
 * what arrived can differ from the ask), and the ask when it does (0174).
 */
export function depositStateOf(tx: {
  state: string;
  amount: string;
  requestedAmount: string | null;
  currency: string;
  needsAttention: boolean;
}): {
  state: string;
  amount: string;
  requestedAmount: string | null;
  currency: string;
  underReview: boolean;
} {
  return {
    state: tx.state,
    amount: tx.amount,
    requestedAmount: tx.requestedAmount,
    currency: tx.currency,
    // A person has it (money that arrived unconfirmed, a figure the provider
    // disputes): the client is told it is being checked, not "waiting".
    underReview: tx.state === 'pending' && tx.needsAttention,
  };
}
