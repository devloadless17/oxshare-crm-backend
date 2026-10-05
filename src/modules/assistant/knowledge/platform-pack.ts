/**
 * What the assistant knows about OXShare — the KnowledgeSource for v1.
 *
 * WRITTEN FOR CLIENTS, NOT FOR US. The model repeats the words it is given, so
 * this file uses only what a client SEES and DOES on screen, in plain words.
 * An earlier version described how money moves behind the scenes ("online and
 * offline methods", "sent to the provider and back", "credited after
 * confirmation", minimums and fees), and the assistant repeated it to clients
 * word for word (owner's report, 4 Oct 2026).
 *
 * RULES FOR EDITING THIS FILE:
 * - Client words only. Never: provider, gateway, online/offline method,
 *   redirect, webhook, confirmation, sync, KYC, compliance, IB, ledger.
 * - English only in the body. Arabic names live in the glossary at the end,
 *   marked for Arabic answers: inline, the model copied them into English
 *   answers ("Reset passwords" (إعادة تعيين كلمات المرور), owner, 5 Oct 2026).
 * - Stable facts only. Numbers that change (minimums, fees, limits, which
 *   methods exist, how long things take) are NOT written here: they differ by
 *   country and over time, and a stale number said confidently is worse than
 *   none.
 * - Write each fact once, as the portal actually behaves. When a flow changes,
 *   change it here in the same commit.
 * - Keep it short. It is sent with every question (as a cached prefix). When it
 *   outgrows that, move it behind retrieval: `KnowledgeSource` is that seam.
 * - Re-run `npm run assistant:eval` after any change.
 *
 * The paths in brackets are the pages the assistant may link to
 * (`PORTAL_LINKS`); the portal shows each as a button.
 */
export const PLATFORM_PACK = `
# OXShare, as clients see it

OXShare is an online broker. Clients trade forex, gold and other markets on MetaTrader 5 (MT5), and use their OXShare account area to manage money, trading accounts and their profile.

## Pages
- Dashboard [/dashboard]: balances, accounts and recent activity at a glance.
- Wallet [/wallet]: the client's main balance. Deposits arrive here, and withdrawals are paid from here.
- Deposit [/deposit]: add money. Its History tab [/deposit?tab=history] lists past deposits.
- Withdraw [/withdraw]: take money out. Its History tab [/withdraw?tab=history] lists each request.
- Transfer [/transfer]: move money between the wallet and a trading account, either way. Its History tab [/transfer?tab=history] lists past transfers.
- Statement [/transactions]: every movement of money.
- Trading accounts [/accounts]: open and manage MT5 accounts.
- Partner programme [/partner]: earn by inviting other people.
- Platforms [/platforms]: download MT5 for a computer (Desktop terminal), for iPhone and iPad, or for Android. If a download is not available yet, the client's account manager can send it.
- Profile [/profile]: personal details, documents, password.
- Verification [/kyc]: verify your identity.
- The bell at the top shows updates, such as a deposit that has arrived.

## Getting started
1. Create an account and confirm your email with the code we send.
2. Verify your identity: your personal details, a photo of your ID (passport, national ID or driving licence), a proof of address (a recent utility bill or bank statement) and a selfie. Photos must be clear, complete and not expired.
3. Our team reviews it, and you get an email and a notification. If something needs replacing, only that item is asked for again.
4. Once verified: deposit, open a live trading account, move money into it, and start trading in MT5.

Verification is needed before depositing, withdrawing, transferring, opening a live account or joining the partner programme. A demo account (practice money) needs no verification.
Verified personal details cannot be changed from the account area; support can correct them.

## Deposits
- Go to Deposit, choose a payment method, enter the amount and follow the steps on screen.
- Some methods ask you to upload a receipt after you pay.
- Your deposit shows in Deposit > History, and you get a notification when it reaches your wallet.
- If a deposit has not arrived yet, check History before paying again, so you do not pay twice.
- Only when the client asks about crypto (USDT): send on exactly the network shown on screen, to the address shown. Sending on a different network can lose the money.

## Withdrawals
- Money in a trading account is first moved back to the wallet with Transfer, then withdrawn.
- Go to Withdraw, choose how you want to receive the money, enter the amount and your details, and submit.
- Our team reviews each request, and you can follow it in Withdraw > History. If a request is declined, the reason is shown and the money stays in your wallet.

## Trading accounts (MT5)
- A live account uses real money and needs verification. A demo account uses practice money.
- When an account is opened, its MT5 login details are sent to you by email. Passwords are never shown in the account area.
- Forgot your MT5 password: open the account in Trading accounts and choose Reset passwords. New passwords are emailed to you.
- To fund a live account, use Transfer to move money from your wallet into it.
- Leverage is chosen when you open the account. To change it later, contact support.

## Partner programme
- Apply on the Partner page. We review every application and email you the decision.
- Approved partners get a personal link. People who sign up through it are linked to you, and you earn from their trading. Your earnings show on the Partner page.
- For rates and terms, contact our partnerships team.

## Using MT5
- Download MT5 from Platforms, then log in with the details from your email.
- To place a trade: choose the market, the size (in lots), Buy or Sell, and if you like a Stop Loss and Take Profit.
- Your open trades are in the Trade tab, and closed trades in History.
- If your margin falls too low, MT5 warns you (a margin call) and may close trades automatically (a stop out).

## Arabic names: use ONLY in Arabic answers, never in English ones
Dashboard = لوحة التحكم · Wallet = المحفظة · Deposit = إيداع · Withdraw = سحب · Transfer = تحويل · Statement = كشف الحساب · Trading accounts = حسابات التداول · Partner programme = برنامج الشركاء · Platforms = المنصات · Profile = الملف الشخصي · Verification = التحقق من الهوية · History tab = السجل · Reset passwords = إعادة تعيين كلمات المرور · Desktop terminal = منصة سطح المكتب
`.trim();

/**
 * The only paths the assistant may link to. The portal shows a link to one of
 * these as a button and refuses every other target, so a link a client tricked
 * the model into writing becomes plain text.
 */
export const PORTAL_LINKS = [
  '/dashboard',
  '/wallet',
  '/deposit',
  '/withdraw',
  '/transfer',
  '/transactions',
  '/accounts',
  '/partner',
  '/platforms',
  '/profile',
  '/kyc',
] as const;
