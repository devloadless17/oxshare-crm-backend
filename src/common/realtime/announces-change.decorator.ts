import { SetMetadata, applyDecorators, UseInterceptors } from '@nestjs/common';
import { ResourceChangedInterceptor } from './resource-changed.interceptor';
import type { ResourceName } from './resource-changed';

export const ANNOUNCES_CHANGE = 'announces_change';

/**
 * Marks a handler whose success moves a queue OTHER operators are watching.
 *
 * Explicit, per-endpoint, and greppable — deliberately not an interceptor that
 * infers the resource from the URL of every mutating admin request. Inference
 * would announce a hundred endpoints nobody is watching (a settings save, a
 * role edit) and would silently start announcing anything a future route
 * happens to be nested under. Here the set of live queues is a list you can
 * read, and adding one is a decision somebody makes.
 *
 * @example
 *   @Patch(':userId/approve')
 *   @AnnouncesChange('kyc')
 */
export const AnnouncesChange = (resource: ResourceName): MethodDecorator =>
  applyDecorators(
    SetMetadata(ANNOUNCES_CHANGE, resource),
    UseInterceptors(ResourceChangedInterceptor),
  );
