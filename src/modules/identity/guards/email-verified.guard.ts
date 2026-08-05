import { Injectable, CanActivate, ExecutionContext } from '@nestjs/common';
import { User } from '../../../store/users.store';
import { EmailNotVerifiedError } from '../../../common/errors/domain-errors';

@Injectable()
export class EmailVerifiedGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{ user?: User }>();
    const user = request.user;
    if (!user?.emailVerified) {
      // A DomainError rather than a ForbiddenException, so the envelope carries
      // `code: 'EMAIL_NOT_VERIFIED'` instead of a generic FORBIDDEN. The portal
      // matched the English message text to decide whether to offer "resend
      // verification"; it now branches on the code. AllExceptionsFilter still
      // maps this to 403.
      throw new EmailNotVerifiedError(
        'Please verify your email address before accessing this resource.',
      );
    }
    return true;
  }
}
