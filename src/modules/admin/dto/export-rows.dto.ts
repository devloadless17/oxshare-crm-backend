import { ApiProperty } from '@nestjs/swagger';
import { ClientField, NotClientField } from '../../../common/security/client-field.decorator';

/**
 * The row shapes the CSV exports emit, declared so that MASKING HAS SOMETHING TO
 * WALK.
 *
 * ## Why exports need their own shapes at all
 *
 * The response interceptor masks by walking a route's declared type, and an
 * export does not have one: by the time the response exists it is a byte
 * stream, and the rows are gone. So an export must mask its ROWS before they
 * are serialised — a call, unavoidably.
 *
 * What is avoidable is a second SET OF DECLARATIONS. These rows used to be
 * masked through catalogue aliases (`walletExport.userEmail` and friends), which
 * meant the desk's shape and its CSV's shape were described in two different
 * places. That is precisely how the withdrawal desk masked correctly for
 * seventeen days while its export did not: two definitions, one of them
 * forgotten.
 *
 * With the fields marked here, both halves read the SAME declarations —
 * `@ClientField` on the shape — and the only difference left is where the call
 * happens, which is a consequence of streaming rather than a second policy.
 *
 * ## Why the names are flat
 *
 * A CSV has one row of headers, so the person is flattened to `userEmail`
 * rather than nested under `user`. That is a genuine difference in shape, not a
 * naming preference, and it is why these cannot simply reuse the desk's DTOs.
 */

class ExportedPerson {
  /** The client's Portal ID — the identifier a spreadsheet is filtered by. Never masked. */
  @NotClientField('an identifier addressing the record, not an attribute of the person behind it')
  @ApiProperty({ required: false })
  userPortalId?: number | null;

  @ClientField('client.email')
  @ApiProperty({ required: false })
  userEmail?: string | null;

  @ClientField('client.firstName')
  @ApiProperty({ required: false })
  userFirstName?: string | null;

  @ClientField('client.lastName')
  @ApiProperty({ required: false })
  userLastName?: string | null;
}

/** A wallet row in `GET /admin/wallets/export`. */
export class WalletExportRowDto extends ExportedPerson {
  @NotClientField('an identifier addressing the record, not an attribute of the person behind it')
  @ApiProperty()
  id!: string;
}

/** A trading-account row in `GET /admin/trading-accounts/export`. */
export class TradingAccountExportRowDto extends ExportedPerson {
  @NotClientField('an identifier addressing the record, not an attribute of the person behind it')
  @ApiProperty()
  id!: string;
}

/** A withdrawal row in `GET /admin/withdrawals/export`. */
export class WithdrawalExportRowDto extends ExportedPerson {
  @NotClientField('an identifier addressing the record, not an attribute of the person behind it')
  @ApiProperty()
  id!: string;
}

/** A transaction row in `GET /admin/transactions/export`. */
export class FinancialExportRowDto extends ExportedPerson {
  @NotClientField('an identifier addressing the record, not an attribute of the person behind it')
  @ApiProperty()
  id!: string;
}

/**
 * The person on an IB export row — NESTED, not flattened.
 *
 * The four shapes above flatten to `userEmail` because their CSVs are built
 * from flat rows. The two IB exports are not: `IbApplicationExportRow` and
 * `IbPartnerExportRow` carry a `user` object, and their columns read
 * `r.user.email`. `maskByShape` walks the DECLARED type of each property, so the
 * shape it is given has to match the rows it is handed — a flat DTO would find
 * no `userEmail` on these rows, delete nothing, and mask nothing while appearing
 * to be wired up.
 *
 * That "appearing to be wired up" is the whole risk here, and it is why these
 * exist as their own classes rather than as a reuse of `ExportedPerson`.
 */
class IbExportedPerson {
  @NotClientField('an identifier addressing the record, not an attribute of the person behind it')
  @ApiProperty()
  id!: string;

  @ClientField('client.email')
  @ApiProperty({ required: false })
  email?: string | null;

  @ClientField('client.firstName')
  @ApiProperty({ required: false })
  firstName?: string | null;

  @ClientField('client.lastName')
  @ApiProperty({ required: false })
  lastName?: string | null;
}

/**
 * An application row in `GET /admin/ib/applications/export`.
 *
 * Only `user` is declared, for the same reason `WalletExportRowDto` declares
 * only `id`: these shapes exist for masking to walk, not to describe the CSV.
 * Columns nothing masks — the application's status, the agency, the dates —
 * need no declaration and get none.
 */
export class IbApplicationExportRowDto {
  @ApiProperty({ type: () => IbExportedPerson })
  user!: IbExportedPerson;
}

/** A partner row in `GET /admin/ib/partners/export`. */
export class IbPartnerExportRowDto {
  @ApiProperty({ type: () => IbExportedPerson })
  user!: IbExportedPerson;
}
