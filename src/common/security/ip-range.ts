/**
 * "Is this address inside this range?" — pure, no Nest, no database.
 *
 * An office is a range, not an address, so an allowlist that only stored single
 * IPs would be unusable in practice and someone would work around it by adding
 * twenty rows or by turning the feature off. CIDR is the notation operations
 * teams already hold their firewall rules in.
 *
 * Hand-rolled rather than a dependency, because the whole of it is forty lines
 * of bit arithmetic and the alternative is trusting an unaudited package with
 * the decision of who may reach the admin panel of a money system.
 *
 * FAILS CLOSED, everywhere. Anything unparseable — a malformed stored rule, an
 * address we cannot read, an IPv6 form we do not handle — returns `false`
 * rather than throwing or guessing. A rule nobody can interpret must never be
 * the reason someone is let in.
 */

/** Every notation accepted in a stored rule. */
export type IpRule = string;

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** An IPv4 address as a 32-bit unsigned integer, or null if it is not one. */
function ipv4ToInt(ip: string): number | null {
  const match = IPV4.exec(ip.trim());
  if (!match) return null;

  let value = 0;
  for (let i = 1; i <= 4; i++) {
    const octet = Number(match[i]);
    // Rejects 256, and also '01' style padding, which some parsers read as octal.
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    if (match[i].length > 1 && match[i].startsWith('0')) return null;
    value = value * 256 + octet;
  }
  return value;
}

/**
 * Whether a rule is well-formed. Used to reject bad input at the edge, so an
 * unusable rule cannot reach the table and sit there matching nothing.
 */
export function isValidRule(rule: IpRule): boolean {
  return parseRule(rule) !== null;
}

interface ParsedRule {
  network: number;
  /** Mask as an integer; /32 is a single host. */
  mask: number;
}

function parseRule(rule: IpRule): ParsedRule | null {
  const trimmed = rule.trim();
  if (trimmed === '') return null;

  const [addressPart, prefixPart, ...rest] = trimmed.split('/');
  if (rest.length > 0) return null;

  const address = ipv4ToInt(addressPart);
  if (address === null) return null;

  // A bare address is an exact host — the same as /32, spelled the way a person
  // would type it.
  if (prefixPart === undefined) return { network: address, mask: 0xffffffff };

  const prefix = Number(prefixPart);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null;
  if (prefixPart.length > 1 && prefixPart.startsWith('0')) return null;

  // `<<` is signed in JS and /0 would shift by 32 (a no-op, not zero), so both
  // ends are handled explicitly rather than by arithmetic that looks right.
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;

  // Normalise: 10.0.0.5/24 means the 10.0.0.0/24 network. Storing the host bits
  // would make two spellings of one rule compare unequal.
  return { network: (address & mask) >>> 0, mask };
}

/** True when `ip` falls inside `rule`. False for anything unparseable. */
export function ipMatchesRule(ip: string, rule: IpRule): boolean {
  const parsed = parseRule(rule);
  if (!parsed) return false;

  const address = ipv4ToInt(ip);
  if (address === null) return false;

  return (address & parsed.mask) >>> 0 === parsed.network;
}

/** True when `ip` matches any rule. An EMPTY list matches nothing. */
export function ipMatchesAny(ip: string | undefined, rules: readonly IpRule[]): boolean {
  if (!ip) return false;
  return rules.some((rule) => ipMatchesRule(ip, rule));
}

/**
 * The canonical spelling of a rule, for storage and comparison.
 * Returns null when the rule is invalid.
 */
export function canonicaliseRule(rule: IpRule): string | null {
  const parsed = parseRule(rule);
  if (!parsed) return null;

  const octets = [24, 16, 8, 0].map((shift) => (parsed.network >>> shift) & 0xff);
  const prefix = parsed.mask === 0 ? 0 : 32 - Math.log2((~parsed.mask >>> 0) + 1);
  return `${octets.join('.')}/${prefix}`;
}
