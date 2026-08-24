/**
 * Notices when `TRUSTED_PROXY_HOPS` stops matching the infrastructure.
 *
 * ## The failure this is for
 *
 * One number decides which entry of `X-Forwarded-For` is believed, and THREE
 * controls key on the answer: the RBAC-08 network allowlist, the per-IP rate
 * limiter, and the audit trail. `main.ts` states the number on every boot for
 * that reason — but a boot line can only describe the moment it is written.
 *
 * The likeliest way this goes wrong is not a typo somebody would catch reading
 * the log. It is putting a CDN in front of a domain that already had one proxy
 * and not knowing this variable exists. Nothing restarts, nothing errors, and
 * the boot line from last month still says `1`. From then on every control
 * reads the CDN's address: one allowlist rule admits the world, the limiter
 * throttles every caller as one, and every audit row names the CDN.
 *
 * ## Why a SAMPLE and not a single request
 *
 * A caller can put anything in `X-Forwarded-For`, so no individual request
 * proves anything — a request carrying more entries than we expect is the
 * normal shape of somebody prepending junk.
 *
 * What a caller cannot do is change the shape of EVERY request. In a correctly
 * configured deployment the entry count equals the hop count on essentially all
 * of them, because ordinary clients send no `X-Forwarded-For` at all and our
 * own proxies each append exactly one. So the signal is the modal shape of a
 * few hundred requests, not any one of them:
 *
 *   consistently DEEPER than configured  → a proxy was added and this was not
 *                                          raised; we are reading our own
 *                                          infrastructure's address as if it
 *                                          were the client
 *   consistently SHALLOWER               → configured for more proxies than are
 *                                          actually in front, so we are reading
 *                                          left of what our infrastructure
 *                                          wrote, into text the CALLER chose
 *
 * The second is the security hole: it is what lets a caller pick their own
 * address and walk through an IP allowlist. The first is a correctness and
 * accountability failure rather than a spoofing one.
 *
 * ## It reports, and changes nothing
 *
 * Deliberately no auto-correction. Inferring the hop count from traffic is
 * exactly the "trust the header" mistake this codebase refuses in
 * `client-ip.ts` — a caller who can shift the inference can shift the trust
 * boundary. The number stays configuration; this only says when it has stopped
 * matching reality.
 */

/**
 * Requests to look at before drawing any conclusion.
 *
 * Large enough that a burst of forged headers cannot swing it, small enough
 * that a misconfiguration is reported within a few minutes of real traffic
 * rather than at the end of a day.
 */
const SAMPLE_SIZE = 200;

/**
 * The share of one sample that must agree before this is a fact about the
 * deployment rather than noise.
 *
 * High on purpose. At 90% a caller would have to supply nine of every ten
 * requests the process handles to fake a verdict — at which point they own the
 * traffic and the hop count is not the interesting problem.
 */
const AGREEMENT = 0.9;

/** How often the same standing verdict is repeated. */
const REPEAT_MS = 3_600_000;

export type ProxyDepthVerdict = 'too_low' | 'too_high';

/**
 * How many addresses `X-Forwarded-For` actually carries on this request.
 *
 * The header may arrive more than once, in which case Node hands back an array
 * and the real list is all of them in order. Empty entries are dropped — a
 * trailing comma is not a hop.
 */
export function forwardedDepth(header: string | string[] | undefined): number {
  if (header === undefined) return 0;
  const parts = Array.isArray(header) ? header : [header];
  return parts
    .flatMap((part) => part.split(','))
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0).length;
}

/**
 * Counts the shape of recent requests and reports a standing disagreement.
 *
 * One instance per process, held by the middleware. Pure arithmetic over three
 * integers — it is on the path of every request, so it does no allocation per
 * request beyond splitting a header that is usually absent.
 */
export class ProxyDepthObserver {
  private seen = 0;
  private deeper = 0;
  private shallower = 0;
  /**
   * `null` means never reported, which is NOT the same as reported at zero.
   *
   * Initialising this to a number makes the very first verdict fall inside a
   * repeat window that no report ever opened — so the first time a deployment
   * is misconfigured, the alarm stays silent for an hour. A "have I said this
   * yet" question deserves an absent value, not a sentinel that happens to be a
   * valid timestamp.
   */
  private lastReport: number | null = null;

  /**
   * Record one request; returns a verdict only when there is one worth saying.
   *
   * `null` on almost every call — mid-sample, or a sample that agreed with the
   * configuration, or a verdict already reported within the repeat window.
   */
  observe(
    header: string | string[] | undefined,
    hops: number,
    now: number = Date.now(),
  ): ProxyDepthVerdict | null {
    const depth = forwardedDepth(header);

    this.seen += 1;
    if (depth > hops) this.deeper += 1;
    else if (depth < hops) this.shallower += 1;

    if (this.seen < SAMPLE_SIZE) return null;

    const threshold = this.seen * AGREEMENT;
    const verdict: ProxyDepthVerdict | null =
      this.deeper >= threshold ? 'too_low' : this.shallower >= threshold ? 'too_high' : null;

    this.seen = 0;
    this.deeper = 0;
    this.shallower = 0;

    if (verdict === null) {
      /*
       * Agreed. The window is cleared so that a problem appearing later is
       * reported at once rather than waiting out a timer started by an earlier,
       * unrelated one — the same rule the commission queue's alarm follows.
       */
      this.lastReport = null;
      return null;
    }

    if (this.lastReport !== null && now - this.lastReport < REPEAT_MS) return null;
    this.lastReport = now;
    return verdict;
  }
}

/** What to tell somebody, in the terms they will have to act in. */
export function proxyDepthSummary(verdict: ProxyDepthVerdict, hops: number): string {
  if (verdict === 'too_low') {
    return (
      `TRUSTED_PROXY_HOPS is ${hops}, but almost every request arrives with more ` +
      'X-Forwarded-For entries than that — which is what it looks like when a proxy or CDN was ' +
      `put in front and this was not raised. The IP allowlist, the rate limiter and the audit ` +
      `trail are all reading an address belonging to our own infrastructure rather than to the ` +
      `caller. Raise it by one for each proxy in front of this process.`
    );
  }

  return (
    `TRUSTED_PROXY_HOPS is ${hops}, but almost every request arrives with FEWER ` +
    'X-Forwarded-For entries than that, so the address being trusted is further left than our ' +
    'own infrastructure reaches — into text the caller supplied. A caller can therefore choose ' +
    'the address the IP allowlist and the rate limiter see. Lower it to the number of reverse ' +
    'proxies actually in front of this process.'
  );
}
