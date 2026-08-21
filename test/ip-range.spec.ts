import { describe, expect, it } from 'vitest';
import {
  canonicaliseRule,
  coversEverything,
  ipMatchesAny,
  ipMatchesRule,
  isValidRule,
  matchesEverything,
} from '../src/common/security/ip-range';
import { normalizeIp, trustedProxyHops } from '../src/common/security/client-ip';

/**
 * The matcher that decides who reaches the admin panel.
 *
 * Every case here is one where being wrong lets the wrong person in, or locks
 * the right person out. There is no cosmetic assertion in this file.
 */

describe('ipMatchesRule — single hosts', () => {
  it('matches an exact address', () => {
    expect(ipMatchesRule('203.0.113.7', '203.0.113.7')).toBe(true);
  });

  it('does not match a different address', () => {
    expect(ipMatchesRule('203.0.113.8', '203.0.113.7')).toBe(false);
  });

  it('treats a bare address as /32, not as a prefix', () => {
    // If a bare address were read as a network, `10.0.0.1` would admit the whole
    // of 10.0.0.0/8 — an entire private network instead of one machine.
    expect(ipMatchesRule('10.0.0.2', '10.0.0.1')).toBe(false);
  });
});

describe('ipMatchesRule — ranges', () => {
  it('matches inside a /24', () => {
    expect(ipMatchesRule('192.168.1.55', '192.168.1.0/24')).toBe(true);
  });

  it('refuses an address one octet outside a /24', () => {
    expect(ipMatchesRule('192.168.2.55', '192.168.1.0/24')).toBe(false);
  });

  it('handles the boundaries of a /24 exactly', () => {
    expect(ipMatchesRule('192.168.1.0', '192.168.1.0/24')).toBe(true);
    expect(ipMatchesRule('192.168.1.255', '192.168.1.0/24')).toBe(true);
    expect(ipMatchesRule('192.168.0.255', '192.168.1.0/24')).toBe(false);
    expect(ipMatchesRule('192.168.2.0', '192.168.1.0/24')).toBe(false);
  });

  it('handles a /31 and a /32', () => {
    expect(ipMatchesRule('10.1.1.0', '10.1.1.0/31')).toBe(true);
    expect(ipMatchesRule('10.1.1.1', '10.1.1.0/31')).toBe(true);
    expect(ipMatchesRule('10.1.1.2', '10.1.1.0/31')).toBe(false);
    expect(ipMatchesRule('10.1.1.1', '10.1.1.1/32')).toBe(true);
    expect(ipMatchesRule('10.1.1.2', '10.1.1.1/32')).toBe(false);
  });

  it('handles /0, which admits everything', () => {
    // Correct, and deliberately expressible at THIS layer — the matcher's job is
    // arithmetic, not policy. `matchesEverything` below is how the layer with a
    // policy opinion recognises it; `AdminIpAllowlistService.add` refuses it.
    expect(ipMatchesRule('8.8.8.8', '0.0.0.0/0')).toBe(true);
  });

  describe('coversEverything', () => {
    it('recognises two halves that together admit every address', () => {
      // `matchesEverything` catches one /0; this catches the same hole one
      // rule further apart — "Enforced — 2 rules" while admitting the internet.
      expect(coversEverything(['0.0.0.0/1', '128.0.0.0/1'])).toBe(true);
      expect(coversEverything(['::/1', '8000::/1'])).toBe(true);
      expect(coversEverything(['0.0.0.0/2', '64.0.0.0/2', '128.0.0.0/1'])).toBe(true);
    });

    it('does not fire on a list that leaves any address out', () => {
      expect(coversEverything(['0.0.0.0/1'])).toBe(false);
      expect(coversEverything(['10.0.0.0/8', '192.168.0.0/16'])).toBe(false);
      expect(coversEverything([])).toBe(false);
    });

    it('does not let one family stand in for the other', () => {
      // A v4 /0 plus a v6 /1 is not "everything": v6 still has a hole.
      expect(coversEverything(['0.0.0.0/0'])).toBe(true);
      expect(coversEverything(['::/1'])).toBe(false);
    });
  });

  describe('matchesEverything', () => {
    it('recognises a /0 in both families', () => {
      expect(matchesEverything('0.0.0.0/0')).toBe(true);
      expect(matchesEverything('::/0')).toBe(true);
    });

    it('recognises a /0 written with host bits set', () => {
      // The reason this reads the CANONICAL form rather than the input string:
      // `10.0.0.1/0` is a believable slip for `/8`, and it means `0.0.0.0/0`.
      expect(matchesEverything('10.0.0.1/0')).toBe(true);
      expect(matchesEverything('2001:db8::1/0')).toBe(true);
    });

    it('does not flag a merely broad rule', () => {
      // A corporate /8 is legitimate. Refusing breadth in general would be
      // over-reach; only "matches literally everything" is the lie.
      expect(matchesEverything('10.0.0.0/8')).toBe(false);
      expect(matchesEverything('0.0.0.0/1')).toBe(false);
      expect(matchesEverything('203.0.113.7')).toBe(false);
    });

    it('is false for anything unparseable, rather than throwing', () => {
      // A caller uses this to decide whether to REFUSE. Throwing here would turn
      // a validation path into a 500, and returning true would refuse valid input.
      expect(matchesEverything('not-an-address')).toBe(false);
      expect(matchesEverything('')).toBe(false);
      expect(matchesEverything('1.2.3.4/33')).toBe(false);
    });
  });

  it('handles a /8 without the sign bit going wrong', () => {
    // `0xffffffff << 24` is negative in JS. Get the shift wrong and this admits
    // nothing, or everything.
    expect(ipMatchesRule('10.255.255.255', '10.0.0.0/8')).toBe(true);
    expect(ipMatchesRule('11.0.0.1', '10.0.0.0/8')).toBe(false);
  });

  it('matches high addresses where the 32nd bit is set', () => {
    // Anything above 128.x.x.x has the top bit set, which is where signed
    // arithmetic quietly produces a negative number.
    expect(ipMatchesRule('255.255.255.254', '255.255.255.0/24')).toBe(true);
    expect(ipMatchesRule('200.100.50.25', '200.100.50.0/24')).toBe(true);
    expect(ipMatchesRule('200.100.51.25', '200.100.50.0/24')).toBe(false);
  });

  it('ignores host bits in a stored rule', () => {
    // 10.0.0.5/24 means the 10.0.0.0/24 network; a firewall would read it that
    // way, so storing it differently would surprise whoever typed it.
    expect(ipMatchesRule('10.0.0.99', '10.0.0.5/24')).toBe(true);
  });
});

describe('ipMatchesRule — fails closed', () => {
  const nonsense = [
    '',
    '   ',
    'not-an-ip',
    '10.0.0',
    '10.0.0.0.0',
    '256.1.1.1',
    '10.0.0.1/33',
    '10.0.0.1/-1',
    '10.0.0.1/abc',
    '10.0.0.1/24/24',
  ];

  it('refuses to match on a malformed rule rather than throwing or guessing', () => {
    for (const rule of nonsense) {
      expect(ipMatchesRule('10.0.0.1', rule)).toBe(false);
      expect(isValidRule(rule)).toBe(false);
    }
  });

  it('refuses a malformed address', () => {
    for (const ip of nonsense) {
      expect(ipMatchesRule(ip, '10.0.0.0/8')).toBe(false);
    }
  });

  it('rejects zero-padded octets instead of reading them as octal', () => {
    // `010` is 8 in octal. A parser that accepts padding can be fed a rule that
    // reads differently to the human who typed it and to the firewall beside it.
    expect(isValidRule('010.0.0.1')).toBe(false);
    expect(ipMatchesRule('010.0.0.1', '10.0.0.0/8')).toBe(false);
  });
});

describe('ipMatchesAny', () => {
  const rules = ['192.168.1.0/24', '203.0.113.7'];

  it('matches when any rule matches', () => {
    expect(ipMatchesAny('192.168.1.9', rules)).toBe(true);
    expect(ipMatchesAny('203.0.113.7', rules)).toBe(true);
  });

  it('does not match when none do', () => {
    expect(ipMatchesAny('8.8.8.8', rules)).toBe(false);
  });

  it('an EMPTY list matches nothing', () => {
    // The property the guard depends on to mean "not configured": an empty list
    // must never be read as "allow all" by the matcher itself. Whether an empty
    // list disables the feature is the guard's decision, made explicitly there.
    expect(ipMatchesAny('8.8.8.8', [])).toBe(false);
  });

  it('an unknown address matches nothing, even against a permissive list', () => {
    expect(ipMatchesAny(undefined, ['0.0.0.0/0'])).toBe(false);
  });
});

describe('canonicaliseRule', () => {
  it('spells a bare address as /32', () => {
    expect(canonicaliseRule('203.0.113.7')).toBe('203.0.113.7/32');
  });

  it('drops host bits so two spellings of one rule compare equal', () => {
    expect(canonicaliseRule('10.0.0.5/24')).toBe('10.0.0.0/24');
    expect(canonicaliseRule('10.0.0.99/24')).toBe('10.0.0.0/24');
  });

  it('round-trips the extremes', () => {
    expect(canonicaliseRule('0.0.0.0/0')).toBe('0.0.0.0/0');
    expect(canonicaliseRule('255.255.255.255/32')).toBe('255.255.255.255/32');
  });

  it('returns null for anything invalid', () => {
    expect(canonicaliseRule('nope')).toBeNull();
    expect(canonicaliseRule('10.0.0.1/33')).toBeNull();
  });
});

describe('normalizeIp', () => {
  it('reduces IPv4-mapped IPv6 to plain IPv4', () => {
    // Node hands back the mapped form on a dual-stack socket. An allowlist
    // holding `127.0.0.1` would otherwise never match the same caller.
    expect(normalizeIp('::ffff:127.0.0.1')).toBe('127.0.0.1');
    expect(normalizeIp('::FFFF:203.0.113.7')).toBe('203.0.113.7');
  });

  it('leaves a plain address alone', () => {
    expect(normalizeIp('203.0.113.7')).toBe('203.0.113.7');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeIp('  203.0.113.7  ')).toBe('203.0.113.7');
  });
});

describe('trustedProxyHops', () => {
  const withEnv = <T>(value: string | undefined, run: () => T): T => {
    const previous = process.env['TRUSTED_PROXY_HOPS'];
    if (value === undefined) delete process.env['TRUSTED_PROXY_HOPS'];
    else process.env['TRUSTED_PROXY_HOPS'] = value;
    try {
      return run();
    } finally {
      if (previous === undefined) delete process.env['TRUSTED_PROXY_HOPS'];
      else process.env['TRUSTED_PROXY_HOPS'] = previous;
    }
  };

  it('defaults to trusting no proxy', () => {
    // The safe default: read the socket address. Wrong behind a load balancer,
    // but wrong in the direction that fails closed rather than letting a caller
    // nominate their own IP.
    expect(withEnv(undefined, trustedProxyHops)).toBe(0);
    expect(withEnv('', trustedProxyHops)).toBe(0);
  });

  it('reads a configured hop count', () => {
    expect(withEnv('1', trustedProxyHops)).toBe(1);
    expect(withEnv('2', trustedProxyHops)).toBe(2);
  });

  it('refuses a value that cannot be a hop count', () => {
    for (const bad of ['-1', '1.5', 'one', 'true']) {
      expect(() => withEnv(bad, trustedProxyHops)).toThrow(/TRUSTED_PROXY_HOPS/);
    }
  });
});

describe('IPv6', () => {
  /*
   * Added after running the feature rather than after reading about it: a
   * browser on localhost arrives as `::1`, so an IPv4-only matcher meant nobody
   * could add a first rule covering themselves — and, worse, rules added from an
   * IPv4 office would lock out an administrator whose ISP hands them IPv6.
   */
  it('matches a full IPv6 address', () => {
    expect(ipMatchesRule('2001:db8::1', '2001:db8::1')).toBe(true);
    expect(ipMatchesRule('2001:db8::2', '2001:db8::1')).toBe(false);
  });

  it('matches inside an IPv6 range', () => {
    expect(ipMatchesRule('2001:db8:0:0:0:0:0:99', '2001:db8::/32')).toBe(true);
    expect(ipMatchesRule('2001:db9::1', '2001:db8::/32')).toBe(false);
  });

  it('handles loopback, the address localhost actually presents', () => {
    expect(ipMatchesRule('::1', '::1')).toBe(true);
    expect(ipMatchesRule('::1', '::/0')).toBe(true);
  });

  it('expands :: correctly wherever it appears', () => {
    expect(ipMatchesRule('2001:db8::', '2001:db8:0:0:0:0:0:0')).toBe(true);
    expect(ipMatchesRule('::ffff', '0:0:0:0:0:0:0:ffff')).toBe(true);
  });

  it('reads an IPv4-mapped address as IPv4, so one rule covers both spellings', () => {
    expect(ipMatchesRule('::ffff:192.168.1.5', '192.168.1.0/24')).toBe(true);
  });

  it('keeps the families apart', () => {
    // Without this, `0.0.0.0/0` would admit the entire IPv6 internet as well.
    expect(ipMatchesRule('2001:db8::1', '0.0.0.0/0')).toBe(false);
    expect(ipMatchesRule('8.8.8.8', '::/0')).toBe(false);
  });

  it('rejects malformed IPv6', () => {
    for (const bad of ['2001:db8::1::2', 'gggg::1', '2001:db8::/129', '::1/-1']) {
      expect(isValidRule(bad)).toBe(false);
      expect(ipMatchesRule('::1', bad)).toBe(false);
    }
  });

  it('ignores a zone index, which names an interface rather than a host', () => {
    expect(ipMatchesRule('fe80::1%eth0', 'fe80::/10')).toBe(true);
  });

  it('canonicalises to /128 for a bare address', () => {
    expect(canonicaliseRule('2001:db8::1')).toBe('2001:db8:0:0:0:0:0:1/128');
  });
});
