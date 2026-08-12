import { Module } from '@nestjs/common';
import { RivalClient } from './rival.client';
import { RivalConfigService } from './rival-config.service';

/**
 * The Rival connection substrate — client + config resolution.
 *
 * Its own module rather than providers inside `PaymentsModule`, because TWO
 * modules need it and the arrows must stay one-way: `PaymentsModule` (deposits,
 * withdrawals, the webhook) and `SettingsModule` (the admin screen's
 * test-connection call). SettingsModule importing PaymentsModule for one
 * client would drag the whole money surface into the settings graph.
 *
 * `AppSettingsStore` comes from the `@Global()` StoreModule, so this module
 * imports nothing.
 */
@Module({
  providers: [RivalClient, RivalConfigService],
  exports: [RivalClient, RivalConfigService],
})
export class RivalModule {}
