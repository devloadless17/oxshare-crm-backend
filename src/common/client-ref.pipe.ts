import {
  BadRequestException,
  Injectable,
  type ArgumentMetadata,
  type PipeTransform,
} from '@nestjs/common';
import { parsePortalId } from '../store/users.store';

/** No client: ids start at 1, so it matches no row. */
export const NO_CLIENT = 0;

/** The largest Portal ID the int4 key can hold. */
const INT4_MAX = 2_147_483_647;

/**
 * A route or query parameter naming a CLIENT, as their Portal ID — `1000245`
 * or `#1000245` — which IS the client's id since 0159 (D-83). Nothing is
 * looked up: an unused number simply finds no row downstream, which answers
 * exactly like an unknown client (no second existence probe). A uuid, or
 * anything that is not a Portal ID, is a 400.
 *
 * ## It usually receives a NUMBER, not the text
 *
 * Every route declares the parameter `number`, and the global ValidationPipe
 * (`transform: true`) converts such a parameter with `+value` BEFORE this pipe
 * runs: "1000245" arrives as 1000245, a uuid or "abc" as NaN, an empty query as
 * 0. So both shapes are judged by one rule — text by `parsePortalId`, a number
 * as a positive integer the key can hold — and the answer does not depend on
 * whether the conversion ran. (Before 0159 the parameter was a `string` and the
 * conversion was a no-op; calling `.trim()` on the number broke every client
 * route the day it became `number`.)
 */
@Injectable()
export class ClientRefPipe implements PipeTransform<unknown, number | undefined> {
  transform(value: unknown, metadata: ArgumentMetadata): number | undefined {
    const field = metadata.data ?? 'client';
    // An absent OPTIONAL filter stays absent — `?userId=` arrives as '' or, converted, 0.
    // A path parameter is never absent.
    if (metadata.type === 'query' && (value === undefined || value === '' || value === 0)) {
      return undefined;
    }

    const portalId =
      typeof value === 'number'
        ? Number.isSafeInteger(value) && value >= 1 && value <= INT4_MAX
          ? value
          : undefined
        : parsePortalId(value);
    if (portalId === undefined) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: [`${field} must be a client's Portal ID`],
        fields: { [field]: "must be a client's Portal ID" },
      });
    }
    return portalId;
  }
}
