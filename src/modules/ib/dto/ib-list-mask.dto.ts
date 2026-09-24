import { ApiProperty } from '@nestjs/swagger';
import { ClientField, NotClientField } from '../../../common/security/client-field.decorator';

/**
 * Shapes that exist so RBAC-03 MASKING HAS SOMETHING TO WALK on the three IB
 * lists. They are not response types and are never attached to a route.
 *
 * ## The gap these close
 *
 * `FieldMaskInterceptor` masks by walking a route's DECLARED response type, and
 * it declines to act at all when a handler declares none (`field-mask
 * .interceptor.ts` — `shape === undefined` is a pass-through). Three admin IB
 * routes declare none while returning client email, first name and last name:
 *
 *   GET /admin/ib/applications   the applicant
 *   GET /admin/ib/partners       the partner
 *   GET /admin/ib/accruals       the partner AND the client, both
 *
 * Every other route in that controller declares a shape, so the interceptor was
 * a structural no-op on exactly the three that needed it. An administrator whose
 * role hides `client.email` was refused it everywhere else and handed it here.
 *
 * `response-shape-coverage.spec.ts` lists all three, under a comment stating
 * that each "has been read by hand and carries no client-owned field". Three of
 * them do — see the note this change leaves on that list.
 *
 * ## Why masking-only shapes rather than `@ApiOkResponse({ type })`
 *
 * Declaring a response type is the better long-term answer and the one that list
 * asks for: it would type both frontends and remove the entries entirely. But it
 * is only an improvement if the DTO describes the WHOLE payload — these
 * responses carry `rows`, `total`, per-status `counts`, nested `application` /
 * `account` records, `earnings` and `agencyName` — and a partial DTO attached to
 * a route generates a partial type for both frontends, which is worse than no
 * type at all, because it looks authoritative.
 *
 * So the leak is closed the way the CSV exports close theirs: mask the rows
 * explicitly, against shapes declared for that purpose and nothing else
 * (`export-rows.dto.ts` — "these shapes exist for masking to walk, not to
 * describe the CSV"). Typing these three responses properly stays worth doing,
 * and is now a typing job rather than a security one.
 */

/**
 * A person on an IB list row.
 *
 * Marked with the `client.*` catalogue keys, including for a PARTNER, which is
 * the convention `IbPartnerPersonDto` already establishes: a partner is a user
 * of this platform, and an administrator refused client email addresses is not
 * owed them because the person also introduces business.
 */
class IbListPerson {
  @NotClientField('an identifier addressing the record, not an attribute of the person behind it')
  @ApiProperty()
  id!: string;

  @NotClientField('an identifier addressing the record, not an attribute of the person behind it')
  @ApiProperty({ type: 'integer', nullable: true })
  portalId?: number | null;

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

class IbApplicationListRow {
  @ApiProperty({ type: () => IbListPerson })
  user!: IbListPerson;
}

class IbPartnerListRow {
  @ApiProperty({ type: () => IbListPerson })
  user!: IbListPerson;
}

/**
 * An accrual row names TWO people, and both need masking.
 *
 * `client` is already nulled by `IbStore.findAccrualsPage` when the client sits
 * outside the reader's TERRITORY — a different control answering a different
 * question. Territory decides which rows exist to you; the field mask decides
 * which columns you are shown of the rows that do. An in-territory client whose
 * email the reader's role hides is exactly the case territory scoping cannot
 * reach, and it is the one this shape covers.
 */
class IbAccrualListRow {
  @ApiProperty({ type: () => IbListPerson })
  partner!: IbListPerson;

  @ApiProperty({ type: () => IbListPerson })
  client!: IbListPerson;
}

/** `{ rows, total, counts }` — only `rows` is declared, because only it is masked. */
export class IbApplicationListMaskDto {
  @ApiProperty({ type: () => IbApplicationListRow })
  rows!: IbApplicationListRow[];
}

export class IbPartnerListMaskDto {
  @ApiProperty({ type: () => IbPartnerListRow })
  rows!: IbPartnerListRow[];
}

export class IbAccrualListMaskDto {
  @ApiProperty({ type: () => IbAccrualListRow })
  rows!: IbAccrualListRow[];
}
