import { Injectable, Logger } from '@nestjs/common';
import * as argon2 from 'argon2';
import * as bcrypt from 'bcryptjs';

/**
 * Password hashing — PLATFORM-CONVENTIONS R-3.4.
 *
 * argon2id for everything new, with a dual-read migration so nobody is forced
 * to reset a password they already have.
 *
 * Why move off bcrypt at all:
 *
 *  - The repo used `bcryptjs`, the PURE-JAVASCRIPT bcrypt, several times slower
 *    per hash than the native binding. That cost is paid on every login, so it
 *    pushes people toward lowering the cost factor — the opposite of the point.
 *  - bcrypt silently TRUNCATES at 72 bytes. A long passphrase is quietly weaker
 *    than the user believes, and nothing anywhere says so.
 *  - argon2id is memory-hard, which is what makes GPU and ASIC cracking
 *    expensive rather than merely slow. bcrypt's cost is CPU time alone.
 *
 * Retrofitting later would mean a forced password reset for every client, which
 * is a trust and support cost, not just an engineering one. Dual-read only works
 * while the user base is small enough to drain naturally.
 */
@Injectable()
export class PasswordService {
  private readonly logger = new Logger(PasswordService.name);

  /**
   * OWASP's baseline for argon2id: 19 MiB, 2 iterations, 1 degree of
   * parallelism.
   *
   * The parameters are stored INSIDE the hash string, so raising them later
   * applies to new and rehashed passwords without a migration and without
   * invalidating anything already stored.
   */
  private static readonly OPTIONS = {
    type: argon2.argon2id,
    memoryCost: 19_456,
    timeCost: 2,
    parallelism: 1,
  } as const;

  hash(plain: string): Promise<string> {
    return argon2.hash(plain, PasswordService.OPTIONS);
  }

  /**
   * Checks a password against a stored hash of EITHER algorithm.
   *
   * Returns whether it matched, and whether the stored hash should be replaced.
   * The caller decides when to write, because only it knows whether it is in a
   * context that may touch the database.
   */
  async verify(plain: string, stored: string): Promise<{ valid: boolean; needsRehash: boolean }> {
    // A bcrypt hash is recognisable by its prefix; argon2's begins `$argon2`.
    if (this.isBcrypt(stored)) {
      const valid = await bcrypt.compare(plain, stored);
      // Only rehash on a SUCCESSFUL verify: a failed attempt has not proved the
      // password, and rehashing from it would store a hash of the wrong thing.
      return { valid, needsRehash: valid };
    }

    try {
      const valid = await argon2.verify(stored, plain);
      // Parameters live in the hash, so this also picks up a future increase.
      return { valid, needsRehash: valid && argon2.needsRehash(stored, PasswordService.OPTIONS) };
    } catch (error) {
      // A malformed hash must fail closed, never throw into the login handler
      // where it would surface as a 500 and tell an attacker they found
      // something interesting.
      this.logger.error(
        `Unreadable password hash: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { valid: false, needsRehash: false };
    }
  }

  private isBcrypt(stored: string): boolean {
    return /^\$2[aby]?\$/.test(stored);
  }

  /** True when this hash is still on the old algorithm — used by tests and reporting. */
  isLegacy(stored: string): boolean {
    return this.isBcrypt(stored);
  }
}
