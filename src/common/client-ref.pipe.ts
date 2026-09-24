import {
  BadRequestException,
  Injectable,
  type ArgumentMetadata,
  type PipeTransform,
} from '@nestjs/common';
import { parsePortalId, UsersStore } from '../store/users.store';

/** The nil uuid: what an unknown Portal ID resolves to — it matches no row. */
export const NO_CLIENT = '00000000-0000-0000-0000-000000000000';

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A CLIENT named in a URL — by Portal ID — turned into the uuid the system keys on.
 *
 * ## Why
 *
 * The admin screens identify a client by the Portal ID and nothing else: it is
 * what every table prints, what every search takes, and what every console URL
 * carries (`/clients/1000245`, `/kyc/1000245`). The uuid still keys every row
 * and every foreign key — it is simply never shown. So each route that names a
 * client takes the Portal ID too, and this is the one place it is translated:
 * a controller behind this pipe receives a uuid exactly as before, and nothing
 * past the edge had to change.
 *
 * A uuid is still accepted and passed through unchanged. Internal callers and
 * any link minted before the Portal ID existed keep working.
 *
 * ## An unknown number reads exactly like an unknown client
 *
 * A Portal ID nobody holds resolves to the NIL uuid rather than to an error of
 * its own, so the route answers as it always has for a client that does not
 * exist — its own 404, or an empty list. A distinct "no such Portal ID" would
 * give an existence probe a second, cheaper door: a scoped reader could tell
 * "exists outside my territory" (the route's 404) from "does not exist" (this
 * pipe's), which is the difference territory scoping exists to hide.
 *
 * ## Cost
 *
 * One point lookup on `users_portal_id_uq` per request that carries a Portal
 * ID, and none for a uuid.
 */
@Injectable()
export class ClientRefPipe implements PipeTransform<
  string | undefined,
  Promise<string | undefined>
> {
  constructor(private readonly users: UsersStore) {}

  async transform(
    value: string | undefined,
    metadata: ArgumentMetadata,
  ): Promise<string | undefined> {
    const field = metadata.data ?? 'client';
    // An absent OPTIONAL filter stays absent; a path parameter is never absent.
    if ((value === undefined || value === '') && metadata.type === 'query') return undefined;
    if (value !== undefined && UUID_SHAPE.test(value)) return value;

    const portalId = parsePortalId(value);
    if (portalId === undefined) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: [`${field} must be a client's Portal ID`],
        fields: { [field]: "must be a client's Portal ID" },
      });
    }
    return (await this.users.idForPortalId(portalId)) ?? NO_CLIENT;
  }
}
