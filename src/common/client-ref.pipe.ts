import {
  BadRequestException,
  Injectable,
  type ArgumentMetadata,
  type PipeTransform,
} from '@nestjs/common';
import { parsePortalId } from '../store/users.store';

/** No client: ids start at 1, so it matches no row. */
export const NO_CLIENT = 0;

/**
 * A route or query parameter naming a CLIENT, as their Portal ID — `1000245`
 * or `#1000245` — which IS the client's id since 0159 (D-83). Nothing is
 * looked up: an unused number simply finds no row downstream, which answers
 * exactly like an unknown client (no second existence probe). A uuid, or
 * anything that is not a Portal ID, is a 400.
 */
@Injectable()
export class ClientRefPipe implements PipeTransform<string | undefined, number | undefined> {
  transform(value: string | undefined, metadata: ArgumentMetadata): number | undefined {
    const field = metadata.data ?? 'client';
    // An absent OPTIONAL filter stays absent; a path parameter is never absent.
    if ((value === undefined || value === '') && metadata.type === 'query') return undefined;

    const portalId = parsePortalId(value);
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
