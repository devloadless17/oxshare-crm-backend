import { Module } from '@nestjs/common';
import { PlatformsController } from './platforms.controller';
import { AdminPlatformLinksController } from './admin-platform-links.controller';
import { PlatformLinksService } from './platform-links.service';
import { IdentityModule } from '../identity/identity.module';
import { AdminAuthModule } from '../admin/admin-auth.module';

/**
 * Trading-terminal download links — one service, two audiences.
 *
 * Both controllers live here rather than the admin one being filed under
 * `modules/admin`, because they are two views of ONE piece of operator data and
 * splitting them across modules is how the read and the write drift: a key
 * added on one side and not the other, or a validation rule applied to the
 * admin write and not to whatever else learns to write it later.
 *
 * The guards are what separate the audiences, and they are visible on each
 * route rather than implied by which folder the file sits in.
 */
@Module({
  imports: [IdentityModule, AdminAuthModule],
  controllers: [PlatformsController, AdminPlatformLinksController],
  providers: [PlatformLinksService],
  exports: [PlatformLinksService],
})
export class PlatformsModule {}
