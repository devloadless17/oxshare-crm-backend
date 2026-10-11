import type { Request } from 'express';

/**
 * Notices a proxy in front of us that nobody told Caddy about.
 *
 * ## The failure this is for
 *
 * On 11 Oct 2026 Cloudflare's proxy was switched on for the API's domain. No
 * deploy, no restart, no error: from that minute every client behind
 * Cloudflare arrived from Cloudflare's address, shared one rate-limit budget,
 * and real sign-ups were refused with "try again in 27 minutes". The
 * `proxy-depth.ts` watch said nothing, and could not have: Caddy discards the
 * forwarding list of a peer it does not trust and hands this process one
 * address either way, so the SHAPE that watch counts never changed.
 *
 * ## What Caddy tells us now
 *
 * The Caddyfile trusts a proxy by ADDRESS (`trusted_proxies`), and
 * `active-api.caddy` passes three facts with every request, overwriting
 * anything a caller sent under the same names:
 *
 *   X-OxShare-Peer             the machine that connected to Caddy
 *   X-OxShare-Peer-Trusted     `true` when that machine is a trusted proxy
 *   X-OxShare-Forwarded-Chain  the X-Forwarded-For the request ARRIVED with
 *
 * A browser sends no forwarding headers. So a request from an UNTRUSTED peer
 * that carries them is one of two things: a caller decorating their own
 * request, or a proxy we do not know about. One request cannot tell them
 * apart; a standing share of real traffic can. That share is what this counts.
 *
 * ## It reports, and changes nothing
 *
 * Like `proxy-depth.ts`: believing the header would hand the trust boundary to
 * whoever writes it. The remedy is a person adding the proxy's ranges to
 * `trusted_proxies`, and this names the peer and the headers to recognise it by.
 */

export const EDGE_HEADERS = {
  peer: 'x-oxshare-peer',
  peerTrusted: 'x-oxshare-peer-trusted',
  forwardedChain: 'x-oxshare-forwarded-chain',
} as const;

/**
 * Headers only a proxy adds. `X-Forwarded-For` is read from Caddy's copy of it
 * (the chain), because the live header has already been replaced.
 */
const PROXY_MARKERS = [
  'cdn-loop',
  'via',
  'forwarded',
  'cf-connecting-ip',
  'true-client-ip',
  'x-real-ip',
  'fastly-client-ip',
  'x-amz-cf-id',
  'x-azure-clientip',
] as const;

export interface EdgeFacts {
  /** The address every control keys on, as `client-ip.ts` resolved it. */
  address: string | null;
  /** `null` when Caddy said nothing: local development, or a probe that skipped it. */
  peerTrusted: boolean | null;
  peer: string | null;
  forwardedChain: string;
}

function one(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value.join(', ') : (value ?? '')).trim();
}

export function edgeFactsOf(req: Request, address: string | undefined): EdgeFacts {
  const trusted = one(req.headers[EDGE_HEADERS.peerTrusted]).toLowerCase();
  return {
    address: address ?? null,
    peerTrusted: trusted === 'true' ? true : trusted === 'false' ? false : null,
    peer: one(req.headers[EDGE_HEADERS.peer]) || null,
    forwardedChain: one(req.headers[EDGE_HEADERS.forwardedChain]),
  };
}

/** The proxy markers this request carries, by header name. */
export function proxyMarkersOf(req: Request, facts: EdgeFacts): string[] {
  const seen: string[] = PROXY_MARKERS.filter((name) => one(req.headers[name]) !== '');
  if (facts.forwardedChain !== '') seen.unshift('x-forwarded-for');
  return seen;
}

/**
 * Our own machines: the bridge on the WireGuard tunnel, a container on the
 * compose network. They are not the public's traffic and are left out of the
 * sample, or the bridge's steady stream would dilute any share to nothing.
 */
export function isPrivatePeer(peer: string): boolean {
  const ip = peer.replace(/^::ffff:/i, '').toLowerCase();
  return (
    /^(10\.|127\.|192\.168\.|169\.254\.)/.test(ip) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ||
    ip === '::1' ||
    /^f[cd][0-9a-f]{2}:/.test(ip) ||
    /^fe[89ab][0-9a-f]:/.test(ip)
  );
}

/** Public requests to look at before drawing a conclusion. */
const SAMPLE_SIZE = 200;
/**
 * The share of a sample that must arrive forwarded by an untrusted peer.
 *
 * Far below `proxy-depth.ts`'s 90%, on purpose. A DNS change reaches clients
 * gradually, so the share climbs from nothing over hours, and the clients
 * already moved are refused the whole time: waiting for nine in ten would have
 * reported 11 Oct an afternoon late. The cost of the low bar is that somebody
 * sending a quarter of all traffic with a forged header can raise this — and
 * somebody sending a quarter of all traffic is worth a look anyway.
 */
const SHARE = 0.25;
/** How often the same standing verdict is repeated. */
const REPEAT_MS = 3_600_000;

export interface UntrustedProxyVerdict {
  /** Of the sample, how many arrived forwarded by a peer Caddy does not trust. */
  forwarded: number;
  sample: number;
  /** One such peer and what it sent, to recognise the proxy by. */
  examplePeer: string;
  exampleMarkers: string[];
}

export class UntrustedProxyObserver {
  private seen = 0;
  private forwarded = 0;
  private examplePeer = '';
  private exampleMarkers: string[] = [];
  /** `null` = never reported, as in `ProxyDepthObserver`. */
  private lastReport: number | null = null;

  observe(
    facts: EdgeFacts,
    markers: string[],
    now: number = Date.now(),
  ): UntrustedProxyVerdict | null {
    // Nothing from Caddy, or one of our own machines: not the public's traffic.
    if (facts.peerTrusted === null || !facts.peer || isPrivatePeer(facts.peer)) return null;

    this.seen += 1;
    if (!facts.peerTrusted && markers.length > 0) {
      this.forwarded += 1;
      this.examplePeer = facts.peer;
      this.exampleMarkers = markers;
    }
    if (this.seen < SAMPLE_SIZE) return null;

    const verdict: UntrustedProxyVerdict | null =
      this.forwarded >= this.seen * SHARE
        ? {
            forwarded: this.forwarded,
            sample: this.seen,
            examplePeer: this.examplePeer,
            exampleMarkers: this.exampleMarkers,
          }
        : null;

    this.seen = 0;
    this.forwarded = 0;

    if (verdict === null) {
      this.lastReport = null;
      return null;
    }
    if (this.lastReport !== null && now - this.lastReport < REPEAT_MS) return null;
    this.lastReport = now;
    return verdict;
  }
}

/** What to tell somebody, in the terms they will have to act in. */
export function untrustedProxySummary(verdict: UntrustedProxyVerdict): string {
  return (
    `${verdict.forwarded} of the last ${verdict.sample} public requests were forwarded by a ` +
    `machine Caddy does not trust (for example ${verdict.examplePeer}, sending ` +
    `${verdict.exampleMarkers.join(', ')}). That is what a CDN or load balancer put in front of ` +
    'the API looks like. Every client behind it is being counted as ONE address: they share one ' +
    'rate-limit budget (real sign-ups and sign-ins are refused), the admin network allowlist ' +
    "judges the proxy's address, and the audit trail names it. Add that proxy's published " +
    'address ranges to `trusted_proxies` in the Caddyfile and release. GET /health/edge shows ' +
    'what the API resolves for whoever asks.'
  );
}
