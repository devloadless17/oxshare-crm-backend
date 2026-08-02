import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { User } from '../../../store/users.store';

@Injectable()
export class EmailVerifiedGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{ user?: User }>();
    const user = request.user;
    if (!user?.emailVerified) {
      throw new ForbiddenException(
        'Please verify your email address before accessing this resource.',
      );
    }
    return true;
  }
}
