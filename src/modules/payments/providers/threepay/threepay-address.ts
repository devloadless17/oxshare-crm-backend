import { createHash } from 'node:crypto';
import { keccak_256 } from '@noble/hashes/sha3';

/**
 * WHERE A USDT PAYOUT MAY GO — checked before any money moves (0174).
 *
 * A crypto payout cannot be recalled: an address with one wrong character is
 * money gone, and 3pay's own check only looks at the SHAPE ("T… for TRC20,
 * 0x… for ERC20"). So both networks' real checksums are verified here, at the
 * withdrawal door, where the client can still correct it:
 *
 *   TRC20 — Base58Check: version byte 0x41, then the first 4 bytes of
 *           SHA-256(SHA-256(payload)). One mistyped character fails it.
 *   ERC20 — 0x + 40 hex. A MIXED-case address carries an EIP-55 checksum in
 *           its capitals (Keccak-256, from `@noble/hashes`, which Node lacks),
 *           and one that does not match was mistyped. An all-lower or
 *           all-upper address carries no checksum and is accepted as written.
 *
 * Two kinds of valid address are refused anyway, because money sent to them is
 * lost for certain: the zero address, and the USDT token CONTRACT itself (a
 * client pasting the token's address instead of their wallet's is a known
 * mistake). A contract we cannot know about offline is not guessed at.
 *
 * Pure: no Nest, no network. `threepay-address.spec.ts` pins every branch
 * against real addresses.
 */

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** The USDT contracts on each network (3pay's guide, §01). */
const USDT_CONTRACT_TRC20 = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const USDT_CONTRACT_ERC20 = '0xdac17f958d2ee523a2206206994597c13d831ec7';

function base58Decode(text: string): Buffer | null {
  let value = 0n;
  for (const char of text) {
    const digit = BASE58.indexOf(char);
    if (digit < 0) return null;
    value = value * 58n + BigInt(digit);
  }
  let hex = value === 0n ? '' : value.toString(16);
  if (hex.length % 2 === 1) hex = `0${hex}`;
  let zeros = 0;
  while (zeros < text.length && text[zeros] === '1') zeros += 1;
  return Buffer.concat([Buffer.alloc(zeros), Buffer.from(hex, 'hex')]);
}

function sha256(data: Buffer): Buffer {
  return createHash('sha256').update(data).digest();
}

/** The problem with a TRC20 (Tron) address, or undefined when it can be paid. */
export function tronAddressIssue(input: string): string | undefined {
  const address = input.trim();
  if (!/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(address)) {
    return 'A TRC20 address starts with T and is 34 characters long.';
  }
  const bytes = base58Decode(address);
  if (!bytes || bytes.length !== 25 || bytes[0] !== 0x41) {
    return 'This is not a valid TRC20 address. Check it for a typing mistake.';
  }
  const payload = bytes.subarray(0, 21);
  const checksum = sha256(sha256(payload)).subarray(0, 4);
  if (!checksum.equals(bytes.subarray(21, 25))) {
    return 'This is not a valid TRC20 address. Check it for a typing mistake.';
  }
  if (payload.subarray(1).every((byte) => byte === 0)) {
    return 'This is the zero address. Money sent there is lost.';
  }
  if (address === USDT_CONTRACT_TRC20) {
    return 'This is the USDT token contract, not a wallet. Money sent there is lost.';
  }
  return undefined;
}

/** EIP-55: the address with each letter's case set by Keccak-256 of the lower-case hex. */
export function eip55(address: string): string {
  const hex = address.slice(2).toLowerCase();
  const hash = Buffer.from(keccak_256(hex)).toString('hex');
  let out = '0x';
  for (let i = 0; i < hex.length; i += 1) {
    out += Number.parseInt(hash[i], 16) >= 8 ? hex[i].toUpperCase() : hex[i];
  }
  return out;
}

/** The problem with an ERC20 (Ethereum) address, or undefined when it can be paid. */
export function evmAddressIssue(input: string): string | undefined {
  const address = input.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return 'An ERC20 address is 0x followed by 40 letters and digits (0–9, a–f).';
  }
  const body = address.slice(2);
  const mixed = body !== body.toLowerCase() && body !== body.toUpperCase();
  if (mixed && eip55(address) !== address) {
    return (
      'The capital letters in this address do not match its checksum, so it was probably ' +
      'mistyped. Copy it again from the wallet.'
    );
  }
  const lower = `0x${body.toLowerCase()}`;
  if (/^0x0{40}$/.test(lower)) return 'This is the zero address. Money sent there is lost.';
  if (lower === USDT_CONTRACT_ERC20) {
    return 'This is the USDT token contract, not a wallet. Money sent there is lost.';
  }
  return undefined;
}

/**
 * An EVM address in the one spelling that compares equal to 3pay's echo of it.
 * Case carries only the checksum, so lower case is the identity. A Tron
 * address is case-SENSITIVE (Base58) and is compared exactly as written.
 */
export function evmAddressKey(input: string): string {
  return input.trim().toLowerCase();
}
