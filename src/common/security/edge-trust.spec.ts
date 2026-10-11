import { describe, expect, it } from 'vitest';
import type { Request } from 'express';
import {
  UntrustedProxyObserver,
  edgeFactsOf,
  isPrivatePeer,
  proxyMarkersOf,
  type EdgeFacts,
} from './edge-trust';

function request(headers: Record<string, string>): Request {
  return { headers } as unknown as Request;
}

/** What Caddy hands the API for a request Cloudflare forwarded while UNTRUSTED. */
const BEHIND_UNKNOWN_CDN = request({
  'x-oxshare-peer': '104.22.40.137',
  'x-oxshare-peer-trusted': 'false',
  'x-oxshare-forwarded-chain': '94.187.15.248',
  'cdn-loop': 'cloudflare; loops=1',
  'cf-connecting-ip': '94.187.15.248',
});
/** A plain browser request, as Caddy forwards it: its own `Via` is always there. */
const DIRECT = request({
  'x-oxshare-peer': '213.204.85.249',
  'x-oxshare-peer-trusted': 'false',
  'x-oxshare-forwarded-chain': '',
  via: '1.1 Caddy',
});
const BEHIND_TRUSTED_CDN = request({
  'x-oxshare-peer': '104.22.40.137',
  'x-oxshare-peer-trusted': 'true',
  'x-oxshare-forwarded-chain': '94.187.15.248',
  'cdn-loop': 'cloudflare; loops=1',
});
const BRIDGE = request({
  'x-oxshare-peer': '10.8.0.2',
  'x-oxshare-peer-trusted': 'false',
  'x-oxshare-forwarded-chain': '1.2.3.4',
});

function feed(observer: UntrustedProxyObserver, req: Request, times: number, now = 0) {
  let last = null;
  for (let i = 0; i < times; i += 1) {
    const facts: EdgeFacts = edgeFactsOf(req, undefined);
    last = observer.observe(facts, proxyMarkersOf(req, facts), now) ?? last;
  }
  return last;
}

describe('the watch on a proxy nobody declared', () => {
  it('reports the 11 Oct 2026 shape: a quarter of public traffic forwarded by an untrusted peer', () => {
    const observer = new UntrustedProxyObserver();
    feed(observer, DIRECT, 140);
    const verdict = feed(observer, BEHIND_UNKNOWN_CDN, 60);
    expect(verdict).toMatchObject({ forwarded: 60, sample: 200, examplePeer: '104.22.40.137' });
    expect(verdict?.exampleMarkers).toContain('cdn-loop');
  });

  it('is silent once the proxy is trusted, and for direct traffic', () => {
    const observer = new UntrustedProxyObserver();
    expect(feed(observer, BEHIND_TRUSTED_CDN, 300)).toBeNull();
    expect(feed(observer, DIRECT, 300)).toBeNull();
  });

  it('is not raised by a few callers decorating their own requests', () => {
    const observer = new UntrustedProxyObserver();
    feed(observer, DIRECT, 170);
    expect(feed(observer, BEHIND_UNKNOWN_CDN, 30)).toBeNull();
  });

  it('leaves our own machines out of the sample, so the bridge cannot dilute or raise it', () => {
    const observer = new UntrustedProxyObserver();
    expect(feed(observer, BRIDGE, 1000)).toBeNull();
    feed(observer, DIRECT, 140);
    feed(observer, BRIDGE, 5000);
    expect(feed(observer, BEHIND_UNKNOWN_CDN, 60)).not.toBeNull();
    expect(isPrivatePeer('172.18.0.5')).toBe(true);
    expect(isPrivatePeer('172.68.151.111')).toBe(false);
  });

  it('says a standing problem once an hour, not once a sample', () => {
    const observer = new UntrustedProxyObserver();
    expect(feed(observer, BEHIND_UNKNOWN_CDN, 200, 0)).not.toBeNull();
    expect(feed(observer, BEHIND_UNKNOWN_CDN, 200, 60_000)).toBeNull();
    expect(feed(observer, BEHIND_UNKNOWN_CDN, 200, 3_700_000)).not.toBeNull();
  });

  it('draws no conclusion where Caddy is not in the path', () => {
    const observer = new UntrustedProxyObserver();
    expect(
      feed(observer, request({ 'x-forwarded-for': '1.2.3.4', 'cdn-loop': 'x' }), 500),
    ).toBeNull();
  });
});
