import { describe, expect, it } from 'vitest';
import { ESLint } from 'eslint';
import { resolve } from 'node:path';

/**
 * THE IMPORT BANS HOLD WHERE THEY ARE SAID TO — each one proven by linting a
 * real violation at a real path.
 *
 * Flat config does not merge a rule's options across the blocks that match a
 * file: the LAST block wins outright. With every ban on the one rule
 * `no-restricted-imports`, two of them were silently erased for months — the
 * "no HTTP in domain code" ban on every store file (the layering block
 * replaced it) and the `getDb` ban on every money service (the HTTP block
 * replaced that). `eslint --print-config` showed it; nothing failed, because
 * nothing ever attempted the forbidden import (28 Sep 2026).
 *
 * The lesson this repo already paid for once with the ledger triggers: a test
 * that never attempts the forbidden thing does not test the prohibition. So
 * each case below IS the forbidden thing, plus one control that must stay
 * allowed — a ban that fires everywhere is as useless as one that fires nowhere.
 */

const ROOT = resolve(__dirname, '..');
const eslint = new ESLint({ cwd: ROOT });

/** The rules that fire on `code` when it sits at `file`. */
async function firedAt(file: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: resolve(ROOT, file) });
  return result.messages
    .filter((message) => message.ruleId?.endsWith('no-restricted-imports'))
    .map((message) => message.ruleId as string);
}

const HTTP =
  "import { BadRequestException } from '@nestjs/common';\nexport const x = BadRequestException;\n";

describe('the import bans, each attempted', () => {
  it('keeps HTTP out of a STORE — the ban the layering block used to erase', async () => {
    expect(await firedAt('src/store/kyc.store.ts', HTTP)).toContain(
      '@typescript-eslint/no-restricted-imports',
    );
  });

  it('keeps a store from importing a feature module (layering)', async () => {
    const code =
      "import { KycService } from '../modules/compliance/kyc.service';\nexport const x = KycService;\n";
    expect(await firedAt('src/store/kyc.store.ts', code)).toContain('no-restricted-imports');
  });

  it('keeps getDb out of a MONEY SERVICE — the ban the HTTP block used to erase', async () => {
    const code = "import { getDb } from '../../database/db';\nexport const x = getDb;\n";
    expect(await firedAt('src/modules/payments/transactions.service.ts', code)).toContain(
      '@typescript-eslint/no-restricted-imports',
    );
  });

  it('keeps HTTP out of a money service too', async () => {
    expect(await firedAt('src/modules/payments/transactions.service.ts', HTTP)).toContain(
      '@typescript-eslint/no-restricted-imports',
    );
  });

  it('keeps the commission seam pure — no database, no HTTP', async () => {
    const db = "import { getDb } from '../../database/db';\nexport const x = getDb;\n";
    expect(await firedAt('src/modules/ib/commission.ts', db)).not.toEqual([]);
    expect(await firedAt('src/modules/ib/commission.ts', HTTP)).not.toEqual([]);
  });

  it('still allows a TYPE-only getDb import — only the global singleton is banned', async () => {
    const code =
      "import type { getDb } from '../../database/db';\nexport type Db = ReturnType<typeof getDb>;\n";
    expect(await firedAt('src/modules/payments/transactions.service.ts', code)).toEqual([]);
  });

  it('keeps the identity CORE from importing the KYC layer — the process that fills it', async () => {
    const service =
      "import { KycService } from '../compliance/kyc.service';\nexport const x = KycService;\n";
    const store = "import { KycStore } from '../../store/kyc.store';\nexport const x = KycStore;\n";
    expect(await firedAt('src/modules/profile/client-profile.service.ts', service)).toContain(
      'no-restricted-imports',
    );
    expect(await firedAt('src/modules/profile/client-profile.service.ts', store)).toContain(
      'no-restricted-imports',
    );
    expect(
      await firedAt('src/modules/client-identity/client-identity.service.ts', store),
    ).toContain('no-restricted-imports');
  });

  it('keeps the layering ban on the core’s store file — the core ban must not erase it', async () => {
    const code =
      "import { KycService } from '../modules/compliance/kyc.service';\nexport const x = KycService;\n";
    const other =
      "import { IbService } from '../modules/ib/ib.service';\nexport const x = IbService;\n";
    expect(await firedAt('src/store/client-identity.store.ts', code)).toContain(
      'no-restricted-imports',
    );
    expect(await firedAt('src/store/client-identity.store.ts', other)).toContain(
      'no-restricted-imports',
    );
  });

  it('lets the core use what is its own — the users store', async () => {
    const code =
      "import { UsersStore } from '../../store/users.store';\nexport const x = UsersStore;\n";
    expect(await firedAt('src/modules/profile/client-profile.service.ts', code)).toEqual([]);
  });

  it('still lets a CONTROLLER throw HTTP — the transport edge is where it belongs', async () => {
    expect(await firedAt('src/modules/compliance/kyc.controller.ts', HTTP)).toEqual([]);
  });
});
