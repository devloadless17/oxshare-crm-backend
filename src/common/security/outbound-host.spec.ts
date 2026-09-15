import { describe, expect, it } from 'vitest';
import { assertPublicOutboundHost, isNonPublicAddress } from './outbound-host';

/**
 * The guard on every host an administrator can point this server at.
 *
 * The literal cases are the ones that matter most: `169.254.169.254` is the
 * cloud metadata address, and it is the single most valuable URL an attacker can
 * make a server fetch. The rest of the table exists because "private" has more
 * members than people remember — CGNAT, benchmarking space and the broadcast
 * range are all reachable from inside a network and all used to pass.
 */

const refusal = async (host: string, allowLoopback = false): Promise<string | null> => {
  try {
    await assertPublicOutboundHost(host, { subject: 'The Rival base URL', allowLoopback });
    return null;
  } catch (error) {
    return (error as Error).message;
  }
};

describe('addresses that are not on the public internet', () => {
  it.each([
    ['169.254.169.254', 'cloud metadata'],
    ['10.0.0.5', 'RFC 1918'],
    ['172.16.0.9', 'RFC 1918'],
    ['192.168.1.1', 'RFC 1918'],
    ['127.0.0.1', 'loopback'],
    ['0.0.0.0', 'unspecified, reaches localhost'],
    ['100.64.0.1', 'carrier-grade NAT'],
    ['255.255.255.255', 'broadcast'],
    ['::1', 'IPv6 loopback'],
    ['fe80::1', 'IPv6 link-local'],
    ['fd00::1', 'IPv6 unique local'],
  ])('%s is non-public (%s)', (ip) => {
    expect(isNonPublicAddress(ip)).toBe(true);
  });

  it.each([['8.8.8.8'], ['1.1.1.1'], ['93.184.216.34'], ['2606:4700::1111'], ['172.32.0.9']])(
    '%s is public',
    (ip) => {
      expect(isNonPublicAddress(ip)).toBe(false);
    },
  );
});

describe('a settings value pointing inside the network is refused', () => {
  it('refuses the cloud metadata endpoint', async () => {
    expect(await refusal('https://169.254.169.254/latest/meta-data/')).toMatch(
      /private or internal address/,
    );
  });

  it('refuses a private address, URL or bare', async () => {
    expect(await refusal('https://10.0.0.5/api')).toMatch(/private or internal/);
    expect(await refusal('10.0.0.5')).toMatch(/private or internal/);
  });

  it('refuses this server itself, and names it', async () => {
    expect(await refusal('http://127.0.0.1:6379')).toMatch(/this server itself \(127\.0\.0\.1\)/);
    expect(await refusal('localhost')).toMatch(/this server itself \(localhost\)/);
  });

  /** `new URL()` keeps the brackets; the matcher and the resolver both reject them. */
  it('handles a bracketed IPv6 literal', async () => {
    expect(await refusal('https://[::1]:443/x')).toMatch(/this server itself \(::1\)/);
  });

  it('allows loopback when development asks for it — Mailpit, and Rival beside the CRM', async () => {
    expect(await refusal('http://localhost:1025', true)).toBeNull();
  });

  it('accepts an ordinary public host', async () => {
    expect(await refusal('https://api.rival.example.com/v1')).toBeNull();
    expect(await refusal('smtp.gmail.com')).toBeNull();
  });

  it('refuses something that is not a host at all', async () => {
    expect(await refusal('not a host')).toMatch(/not a valid host/);
    expect(await refusal('')).toMatch(/not a valid host/);
  });

  /**
   * The case a literal-only check misses entirely.
   *
   * `localtest.me` is a real, publicly registered domain whose A record is
   * 127.0.0.1 — the standard trick for pointing a name at the machine doing the
   * looking. Anyone can register a name for any address, so a guard that only
   * inspects the string is defeated by one DNS record.
   *
   * Uses the real resolver on purpose. A stub would pin the code path and prove
   * nothing about whether resolution actually happens.
   */
  it('resolves a NAME and refuses it when it points somewhere private', async () => {
    expect(await refusal('localtest.me')).toMatch(/resolves to a private or internal address/);
  });

  /**
   * Documented policy, not an oversight: DNS is not this function's business, the
   * connection will fail on its own with a better error, and refusing to save a
   * setting because a resolver blinked would be an outage of our own making.
   */
  it('accepts a name that does not resolve, rather than inventing an outage', async () => {
    expect(await refusal('no-such-host.invalid')).toBeNull();
  });
});
