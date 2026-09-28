import { Global, Module } from '@nestjs/common';
import { ClientIdentityService } from './client-identity.service';

/**
 * Global, like the profile module beside it: every process that learns who a
 * client is — the KYC review today, an external tool later — writes the
 * client's identity record through this one service.
 */
@Global()
@Module({
  providers: [ClientIdentityService],
  exports: [ClientIdentityService],
})
export class ClientIdentityModule {}
