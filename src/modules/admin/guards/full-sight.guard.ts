import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { AuthenticatedAdmin } from './admin.guard';

/**
 * A route whose answer names clients it cannot filter by territory — free text
 * from another system, a whole-platform figure — is served only to an
 * administrator who sees ALL clients (`sees_all_clients`, 0154).
 *
 * Slicing is not possible there, and serving it whole would show a scoped desk
 * other desks' clients (R3). So it is refused, with a reason, rather than
 * sliced into a wrong answer or served into a leak. Runs after `AdminGuard`,
 * which is what sets `req.admin`.
 */
@Injectable()
export class FullSightGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<{ admin?: AuthenticatedAdmin }>();
    if (req.admin?.clientScope.unrestricted === true) return true;
    throw new ForbiddenException(
      'This view names clients across every territory, and your account is scoped to part of ' +
        'the client base. Ask an administrator with sight of all clients.',
    );
  }
}
