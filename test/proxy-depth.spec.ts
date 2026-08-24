import { describe, expect, it } from 'vitest';
import {
  ProxyDepthObserver,
  forwardedDepth,
  proxyDepthSummary,
} from '../src/common/security/proxy-depth';

/**
 * Noticing that `TRUSTED_PROXY_HOPS` has stopped matching the infrastructure.
 *
 * ## Why this needs to exist at all
 *
 * One number decides which `X-Forwarded-For` entry is believed, and the IP
 * allowlist, the rate limiter and the audit trail all key on the answer.
 * `main.ts` prints it at boot — but a boot line describes the moment it was
 * written, and the failure this is for happens months later: a CDN is put in
 * front of a domain that already had one proxy, by somebody who does not know
 * the variable exists. Nothing restarts and nothing errors.
 *
 * No database and no HTTP: every branch here is a decision about the shape of a
 * header, and the whole point is that it is cheap enough to run on the path of
 * every request.
 */

/** Feed the observer `count` requests that all carry `depth` forwarded entries. */
function drive(observer: ProxyDepthObserver, count: number, depth: number, hops: number, now = 0) {
  const verdicts: (string | null)[] = [];
  const header =
    depth === 0 ? undefined : Array.from({ length: depth }, (_, i) => `10.0.0.${i}`).join(', ');
  for (let i = 0; i < count; i += 1) verdicts.push(observer.observe(header, hops, now));
  return verdicts.filter((v) => v !== null);
}

describe('counting what X-Forwarded-For actually carries', () => {
  it('counts nothing when the header is absent', () => {
    expect(forwardedDepth(undefined)).toBe(0);
  });

  it('counts one entry per address, however the header was spelled', () => {
    // Node hands back an ARRAY when the header arrived more than once, and the
    // real list is all of them in order — a deployment where two proxies each
    // append their own header rather than extending one.
    expect(forwardedDepth('1.1.1.1')).toBe(1);
    expect(forwardedDepth('1.1.1.1, 2.2.2.2')).toBe(2);
    expect(forwardedDepth(['1.1.1.1', '2.2.2.2, 3.3.3.3'])).toBe(3);
  });

  it('does not count a trailing comma as a hop', () => {
    // A proxy that appends sloppily would otherwise inflate the depth on every
    // request and report a mismatch that is not there.
    expect(forwardedDepth('1.1.1.1, ')).toBe(1);
    expect(forwardedDepth(' , ')).toBe(0);
  });
});

describe('a standing disagreement, not a single odd request', () => {
  it('says nothing while the shape matches the configuration', () => {
    // One proxy in front, one entry appended, on every request. The healthy case
    // must be silent or the alert is worthless.
    expect(drive(new ProxyDepthObserver(), 1000, 1, 1)).toEqual([]);
  });

  it('says nothing before it has seen enough to be sure', () => {
    // 199 requests is not a conclusion. Reporting on the first odd request would
    // make this alert fire on any caller who prepends junk.
    expect(drive(new ProxyDepthObserver(), 199, 3, 1)).toEqual([]);
  });

  it('cannot be triggered by a caller forging a minority of requests', () => {
    /*
     * THE ATTACK THIS RESISTS. Anyone can put anything in X-Forwarded-For, so a
     * detector that believed one request would be steerable by the very party it
     * exists to defend against.
     */
    const observer = new ProxyDepthObserver();
    const header = '9.9.9.9, 8.8.8.8, 7.7.7.7';

    let reported = 0;
    for (let i = 0; i < 200; i += 1) {
      // One request in five is forged; four in five are the honest shape.
      const forged = i % 5 === 0;
      if (observer.observe(forged ? header : '10.0.0.1', 1, 0) !== null) reported += 1;
    }

    expect(reported).toBe(0);
  });

  it('reports DEEPER when a proxy was added and the setting was not raised', () => {
    // The CDN case: two entries arrive on every request, the setting still says
    // one, so every control reads our own proxy's address as the caller's.
    expect(drive(new ProxyDepthObserver(), 200, 2, 1)).toEqual(['too_low']);
  });

  it('reports SHALLOWER when configured for proxies that are not there', () => {
    // The dangerous direction: we trust further left than our infrastructure
    // reaches, so the caller supplies the address every control keys on.
    expect(drive(new ProxyDepthObserver(), 200, 1, 3)).toEqual(['too_high']);
  });

  it('treats a bare socket connection as shallower than a configured proxy', () => {
    // No header at all while the setting claims a proxy appends one.
    expect(drive(new ProxyDepthObserver(), 200, 0, 2)).toEqual(['too_high']);
  });
});

describe('it repeats rather than streams', () => {
  it('does not re-report a standing verdict within the hour', () => {
    const observer = new ProxyDepthObserver();

    // Four full samples, all disagreeing, one minute apart.
    const first = drive(observer, 200, 2, 1, 0);
    const later = [
      ...drive(observer, 200, 2, 1, 60_000),
      ...drive(observer, 200, 2, 1, 120_000),
      ...drive(observer, 200, 2, 1, 180_000),
    ];

    expect(first).toEqual(['too_low']);
    expect(later).toEqual([]);
  });

  it('reports again once the window has passed', () => {
    const observer = new ProxyDepthObserver();
    drive(observer, 200, 2, 1, 0);

    expect(drive(observer, 200, 2, 1, 3_600_001)).toEqual(['too_low']);
  });

  it('reports a NEW problem at once rather than waiting out the old window', () => {
    /*
     * The window has to be cleared by the condition resolving, not only by time.
     * Otherwise somebody fixes the hop count at 09:05, breaks it differently at
     * 09:10, and hears nothing until 10:00 — which is precisely when a person is
     * editing this setting and most likely to get it wrong twice.
     */
    const observer = new ProxyDepthObserver();

    drive(observer, 200, 2, 1, 0);
    // A healthy sample: the disagreement is gone.
    drive(observer, 200, 1, 1, 60_000);
    // And a different one appears, well inside the original hour.
    expect(drive(observer, 200, 1, 3, 120_000)).toEqual(['too_high']);
  });
});

describe('the message names the action', () => {
  it('tells a DEEPER deployment to raise the number', () => {
    const summary = proxyDepthSummary('too_low', 1);
    expect(summary).toMatch(/raise it/i);
    expect(summary).toContain('TRUSTED_PROXY_HOPS is 1');
  });

  it('tells a SHALLOWER deployment that the caller is choosing the address', () => {
    // The half that is an authentication bypass rather than a data-quality
    // problem, so the message has to say so rather than describe a mismatch.
    const summary = proxyDepthSummary('too_high', 3);
    expect(summary).toMatch(/caller/i);
    expect(summary).toMatch(/lower it/i);
  });
});
