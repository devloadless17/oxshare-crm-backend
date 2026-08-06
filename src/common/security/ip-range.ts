/**
 * "Is this address inside this range?" — pure, no Nest, no database.
 *
 * An office is a range, not an address, so an allowlist that only stored single
 * IPs would be unusable in practice and someone would work around it by adding
 * twenty rows or by turning the feature off. CIDR is the notation operations
 * teams already hold their firewall rules in.
 *
 * Hand-rolled rather than a dependency, because the whole of it is bit
 * arithmetic and the alternative is trusting an unaudited package with the
 * decision of who may reach the admin panel of a money system.
 *
 * IPv4 AND IPv6. Both are needed and this was found by running the thing: a
 * browser on localhost arrives as `::1`, and an IPv4-only matcher would mean
 * nobody could add a first rule covering themselves — or worse, rules added
 * from an IPv4 network would lock out an administrator whose ISP hands them
 * IPv6. Everything is compared as a BigInt so one code path serves both.
 *
 * FAILS CLOSED, everywhere. Anything unparseable — a malformed stored rule, an
 * address we cannot read, an IPv6 form we do not handle — returns `false`
 * rather than throwing or guessing. A rule nobody can interpret must never be
 * the reason someone is let in.
 */

/** Every notation accepted in a stored rule. */
export type IpRule = string;

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** Address families, kept apart: a v4 rule must never match a v6 address. */
type Family = 4 | 6;

/** An IPv4 address as a 32-bit value, or null if it is not one. */
function ipv4ToBig(ip: string): bigint | null {
  const match = IPV4.exec(ip.trim());
  if (!match) return null;

  let value = 0n;
  for (let i = 1; i <= 4; i++) {
    const octet = Number(match[i]);
    // Rejects 256, and also '01' style padding, which some parsers read as octal.
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    if (match[i].length > 1 && match[i].startsWith('0')) return null;
    value = value * 256n + BigInt(octet);
  }
  return value;
}

/**
 * An IPv6 address as a 128-bit value, or null.
 *
 * Handles `::` compression and a trailing IPv4 part (`::ffff:1.2.3.4`), because
 * both turn up in practice — the second is exactly what a dual-stack socket
 * hands back for an IPv4 caller.
 */
function ipv6ToBig(ip: string): bigint | null {
  let text = ip.trim().toLowerCase();
  if (text === '') return null;

  // A zone index (`fe80::1%eth0`) identifies an interface, not a host.
  const zone = text.indexOf('%');
  if (zone >= 0) text = text.slice(0, zone);

  // A trailing dotted quad becomes two more hextets.
  const lastColon = text.lastIndexOf(':');
  const tail = text.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = ipv4ToBig(tail);
    if (v4 === null) return null;
    const high = (v4 >> 16n) & 0xffffn;
    const low = v4 & 0xffffn;
    text = `${text.slice(0, lastColon + 1)}${high.toString(16)}:${low.toString(16)}`;
  }

  const halves = text.split('::');
  if (halves.length > 2) return null;

  const parse = (part: string): bigint[] | null => {
    if (part === '') return [];
    const groups: bigint[] = [];
    for (const piece of part.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(piece)) return null;
      groups.push(BigInt(parseInt(piece, 16)));
    }
    return groups;
  };

  const head = parse(halves[0] ?? '');
  const rest = halves.length === 2 ? parse(halves[1]) : [];
  if (head === null || rest === null) return null;

  let groups: bigint[];
  if (halves.length === 2) {
    const missing = 8 - head.length - rest.length;
    if (missing < 1) return null; // `::` must stand for at least one group
    groups = [...head, ...Array<bigint>(missing).fill(0n), ...rest];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;

  return groups.reduce((acc, group) => (acc << 16n) | group, 0n);
}

/** The ::ffff:0:0/96 block — IPv4 wearing an IPv6 spelling (RFC 4291). */
const V4_MAPPED_PREFIX = 0xffffn << 32n;
// /96 — everything above the low 32 bits, which are the embedded IPv4 address.
const V4_MAPPED_MASK = (1n << 128n) - (1n << 32n);

/**
 * Parse an address in either family.
 *
 * An IPv4-MAPPED IPv6 address is reported as IPv4, because that is what it is:
 * `::ffff:192.168.1.5` and `192.168.1.5` are the same host, and a dual-stack
 * socket picks the spelling for reasons the operator writing the rule neither
 * knows nor should have to. One rule must cover both.
 */
function addressToBig(ip: string): { value: bigint; family: Family } | null {
  const v4 = ipv4ToBig(ip);
  if (v4 !== null) return { value: v4, family: 4 };

  const v6 = ipv6ToBig(ip);
  if (v6 === null) return null;
  if ((v6 & V4_MAPPED_MASK) === V4_MAPPED_PREFIX) {
    return { value: v6 & 0xffffffffn, family: 4 };
  }
  return { value: v6, family: 6 };
}

/**
 * Whether a rule is well-formed. Used to reject bad input at the edge, so an
 * unusable rule cannot reach the table and sit there matching nothing.
 */
export function isValidRule(rule: IpRule): boolean {
  return parseRule(rule) !== null;
}

interface ParsedRule {
  network: bigint;
  mask: bigint;
  family: Family;
  prefix: number;
}

function parseRule(rule: IpRule): ParsedRule | null {
  const trimmed = rule.trim();
  if (trimmed === '') return null;

  const [addressPart, prefixPart, ...rest] = trimmed.split('/');
  if (rest.length > 0) return null;

  const parsed = addressToBig(addressPart);
  if (parsed === null) return null;
  const { value: address, family } = parsed;
  const width = family === 4 ? 32 : 128;

  // A bare address is an exact host — the same as /32 or /128, spelled the way
  // a person would type it.
  const prefix = prefixPart === undefined ? width : Number(prefixPart);
  if (prefixPart !== undefined) {
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > width) return null;
    if (prefixPart.length > 1 && prefixPart.startsWith('0')) return null;
  }

  // BigInt arithmetic, so there is no sign bit to get wrong and /0 is expressible
  // without the shift-by-width no-op that trips the 32-bit version.
  const all = (1n << BigInt(width)) - 1n;
  const mask = prefix === 0 ? 0n : (all << BigInt(width - prefix)) & all;

  // Normalise: 10.0.0.5/24 means the 10.0.0.0/24 network. Storing the host bits
  // would make two spellings of one rule compare unequal.
  return { network: address & mask, mask, family, prefix };
}

/** True when `ip` falls inside `rule`. False for anything unparseable. */
export function ipMatchesRule(ip: string, rule: IpRule): boolean {
  const parsed = parseRule(rule);
  if (!parsed) return false;

  const address = addressToBig(ip);
  if (address === null) return false;
  // A v4 rule must never match a v6 address, or `0.0.0.0/0` would admit the
  // entire IPv6 internet as well.
  if (address.family !== parsed.family) return false;

  return (address.value & parsed.mask) === parsed.network;
}

/** True when `ip` matches any rule. An EMPTY list matches nothing. */
export function ipMatchesAny(ip: string | undefined, rules: readonly IpRule[]): boolean {
  if (!ip) return false;
  return rules.some((rule) => ipMatchesRule(ip, rule));
}

/**
 * Whether a rule admits every address of its family — a `/0`.
 *
 * Worth its own predicate because such a rule is *valid*, *canonical*, and
 * catastrophic: `0.0.0.0/0` on the allowlist means the list is non-empty, so
 * `IpAllowlistGuard` reports the feature as enforcing and the admin panel shows
 * a green "Enforced — 1 rule" shield, while every address on the internet is
 * admitted. That is strictly worse than an empty list, which at least says
 * plainly that the protection is off.
 *
 * It is also easy to reach by accident rather than by typo: `10.0.0.1/0` is a
 * plausible thing to type when `/8` was meant, and it canonicalises to
 * `0.0.0.0/0` — so the check must run on the CANONICAL form, not the input.
 *
 * Turning RBAC-08 off is a legitimate thing to want. The honest way is to
 * remove every rule, which the panel labels as switching the protection off.
 */
export function matchesEverything(rule: IpRule): boolean {
  return parseRule(rule)?.prefix === 0;
}

/**
 * The canonical spelling of a rule, for storage and comparison.
 * Returns null when the rule is invalid.
 */
export function canonicaliseRule(rule: IpRule): string | null {
  const parsed = parseRule(rule);
  if (!parsed) return null;

  if (parsed.family === 4) {
    const octets = [24n, 16n, 8n, 0n].map((shift) => (parsed.network >> shift) & 0xffn);
    return `${octets.join('.')}/${parsed.prefix}`;
  }

  const groups: string[] = [];
  for (let i = 7n; i >= 0n; i--) {
    groups.push(((parsed.network >> (i * 16n)) & 0xffffn || 0n).toString(16));
  }
  return `${groups.join(':')}/${parsed.prefix}`;
}
