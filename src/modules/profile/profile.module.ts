import { Global, Module } from '@nestjs/common';
import { ClientProfileService } from './client-profile.service';
import { ProfileOptionsController } from './profile-options.controller';

/**
 * Global, like the stores it sits on: registration (identity), the KYC personal
 * step (compliance) and the support desk (admin) all write a client's profile,
 * and each must do it through the one service — never by importing one another.
 */
@Global()
@Module({
  controllers: [ProfileOptionsController],
  providers: [ClientProfileService],
  exports: [ClientProfileService],
})
export class ProfileModule {}
