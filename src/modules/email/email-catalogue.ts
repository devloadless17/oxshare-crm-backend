/**
 * EVERY email this platform sends — the one list (13 Oct 2026).
 *
 * The buyer's rule, after every partner was mailed "Funds added to your wallet"
 * for commission AND for rebate on every 30-minute run (up to 96 a day each):
 * an email goes out only when the person
 *
 *   - ASKED for it — a code, a reset link, their trading passwords;
 *   - must ACT on it — a KYC rejection, a re-verification;
 *   - must keep it as the RECORD of their money moving, or of a change to
 *     their access or verification — a deposit, a withdrawal, a manual credit,
 *     a changed password or sign-in address;
 *   - cannot get in without it — a welcome link, an admin invite.
 *
 * Everything else is the bell (`common/notifications/`). That is not
 * politeness. Brevo puts an Unsubscribe button on every email it relays,
 * transactional ones included, and one tap blocks EVERY later email to that
 * address — the deposit receipt and the password reset with it. And mail that
 * people ignore or file as junk teaches Gmail and iCloud to file ours as spam,
 * for everyone. Every unnecessary email spends the deliverability of the
 * necessary ones.
 *
 * `EmailService.send` takes a kind from this list, so an email cannot exist
 * without an entry saying why it matters. Before adding one, name what the
 * recipient must DO or KEEP; if nothing, it is a notification, not an email.
 * The kind also travels to Brevo as `X-Mailin-Tag`, so its logs and statistics
 * can be filtered per email.
 */
export const EMAIL_KINDS = {
  verification: {
    audience: 'client',
    why: 'asked for: the sign-up code and link that confirm the address',
  },
  'password-reset': { audience: 'client', why: 'asked for: the link that sets a new password' },
  welcome: {
    audience: 'client',
    why: 'cannot get in without it: a client staff created chooses their password here',
  },
  'email-changed': {
    audience: 'client',
    why: 'security: tells the OLD address that the sign-in address changed',
  },
  'password-changed': {
    audience: 'client',
    why: 'security: tells the owner the password changed, while they can still act',
  },
  'kyc-decision': {
    audience: 'client',
    why: 'verification changed: approval unlocks money, a rejection says what to fix',
  },
  'kyc-reverification': {
    audience: 'client',
    why: 'must act: the verification was returned and money is paused',
  },
  'kyc-details-corrected': {
    audience: 'client',
    why: 'verification changed: staff corrected a verified detail',
  },
  'partner-decision': {
    audience: 'client',
    why: 'a one-time decision on their partner application',
  },
  'deposit-outcome': {
    audience: 'client',
    why: 'money: a deposit credited, rejected, or failed at the provider — never an expired, unpaid link',
  },
  'wallet-credit': {
    audience: 'client',
    why: 'money: staff credited the wallet by hand, with the reason — never commission or rebate',
  },
  'withdrawal-decision': { audience: 'client', why: 'money: a withdrawal paid or declined' },
  'trading-account-opened': {
    audience: 'client',
    why: 'asked for: the only delivery of a new MT5 account’s passwords',
  },
  'trading-account-password-reset': {
    audience: 'client',
    why: 'asked for: the only delivery of the new MT5 passwords',
  },
  'admin-invite': { audience: 'staff', why: 'cannot get in without it: the invitation link' },
  'admin-password-reset': {
    audience: 'staff',
    why: 'cannot get in without it: the link another administrator issued',
  },
  'smtp-test': { audience: 'staff', why: 'asked for: proves the mail settings deliver' },
} as const satisfies Record<string, { audience: 'client' | 'staff'; why: string }>;

export type EmailKind = keyof typeof EMAIL_KINDS;
