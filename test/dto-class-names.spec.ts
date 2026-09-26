import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/*
 * SWAGGER NAMES A SCHEMA AFTER ITS CLASS, so two classes with one name become ONE
 * schema in the contract. Every endpoint that uses either is then documented with
 * whichever class registered first, and that depends on module load order: the
 * contract can flip between two regenerations with no code change at all.
 *
 * It happened (26 Sep 2026). The admin's `OpenWalletDto` (`userId` + currency, the
 * body of `POST /admin/wallets`) and the portal's self-service `OpenWalletDto`
 * (currency only, `POST /wallet`) merged, and the contract said a client opening
 * their own wallet must send a `userId`. Both frontends generate their API types
 * from that contract, so the error does not stay in the docs.
 *
 * So every class exported from a file that uses `@nestjs/swagger` must carry a
 * name no other such class has. The fix for a failure is a RENAME of one of the
 * pair; an exemption would re-open exactly this.
 */

const SRC = join(__dirname, '..', 'src');

/** Class name → the files (relative to src/) that export a class of that name. */
function swaggerClasses(): Map<string, string[]> {
  const byName = new Map<string, string[]>();
  for (const rel of readdirSync(SRC, { recursive: true, encoding: 'utf8' })) {
    if (!rel.endsWith('.ts') || rel.endsWith('.spec.ts')) continue;
    const text = readFileSync(join(SRC, rel), 'utf8');
    if (!text.includes("from '@nestjs/swagger'")) continue;
    // Line-anchored, so a class named inside a doc comment (` *   export class …`)
    // is not a definition.
    for (const [, name] of text.matchAll(/^export (?:abstract )?class (\w+)/gm)) {
      byName.set(name, [...(byName.get(name) ?? []), rel]);
    }
  }
  return byName;
}

describe('Swagger schema names are unique', () => {
  const classes = swaggerClasses();

  it('no two classes share a name — the contract would merge them into one schema', () => {
    const repeated = [...classes]
      .filter(([, files]) => files.length > 1)
      .map(([name, files]) => `${name}: ${files.join(' and ')}`);
    expect(repeated, 'rename one of each pair; Swagger keeps ONE schema per name').toEqual([]);
  });

  it('actually sees the classes it guards', () => {
    // A scan that finds nothing passes the rule above vacuously.
    expect(classes.get('OpenWalletDto')).toEqual([
      join('modules', 'admin', 'dto', 'requests', 'money.dto.ts'),
    ]);
    expect(classes.get('OpenOwnWalletDto')).toEqual([
      join('modules', 'wallet', 'dto', 'open-wallet.dto.ts'),
    ]);
    expect(classes.size).toBeGreaterThan(300);
  });
});
