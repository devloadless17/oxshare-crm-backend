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
