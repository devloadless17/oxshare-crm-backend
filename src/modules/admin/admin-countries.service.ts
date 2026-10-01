import { Inject, Injectable } from '@nestjs/common';
import { DRIZZLE_DB } from '../../database/database.module';
import type { Db } from '../../database/db';
import { FieldValidationError } from '../../common/errors/domain-errors';
import { countryByCode, WORLD_COUNTRIES } from '../../common/kyc/country-options';
import { OfferedCountriesStore } from '../../store/offered-countries.store';
import { AdminAuditService } from './admin-audit.service';
import type { OfferedCountriesDto } from './dto/countries.dto';

/**
 * The countries the broker offers (0178) — one list for sign-up, KYC, the
 * desk's edit and the payment-method rules. Saved as ISO codes; a client's
 * saved country is never touched by a change here.
 */
@Injectable()
export class AdminCountriesService {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: Db,
    private readonly offered: OfferedCountriesStore,
    private readonly audit: AdminAuditService,
  ) {}

  async get(): Promise<OfferedCountriesDto> {
    const lists = await this.offered.get();
    return {
      offered: lists.codes ? [...lists.codes] : null,
      world: WORLD_COUNTRIES.map(({ code, name }) => ({ code, name })),
    };
  }

  async set(codes: readonly string[], actorId: string): Promise<OfferedCountriesDto> {
    const wanted = codes.map((code) => code.trim().toUpperCase());
    const unknown = wanted.filter((code) => !countryByCode(code));
    if (unknown.length > 0) {
      throw new FieldValidationError(`${unknown.join(', ')} is not a country we know.`, {
        codes: `${unknown.join(', ')} is not a country we know.`,
      });
    }
    if (new Set(wanted).size !== wanted.length) {
      throw new FieldValidationError('A country appears twice.', {
        codes: 'A country appears twice.',
      });
    }
    await this.db.transaction(async (tx) => {
      const before = await this.offered.get(tx);
      await this.offered.set(wanted, actorId, tx);
      await this.audit.recordWithin(
        tx,
        actorId,
        'kyc.countries_update',
        'kyc_config',
        'countries',
        {
          before: before.codes,
          after: wanted,
        },
      );
    });
    return this.get();
  }
}
