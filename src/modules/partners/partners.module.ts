import { Module } from '@nestjs/common';
import { PartnersController } from './partners.controller';
import { PartnersService } from './partners.service';
import { ProgramsService } from './programs.service';
import { CommissionService } from './commission.service';
import { CommissionScheduler } from './commission.scheduler';
import { WalletModule } from '../wallet/wallet.module';

/** IB programs · commission engine · accruals · payouts · L1/L2 structure */
@Module({
  imports: [WalletModule],
  controllers: [PartnersController],
  providers: [PartnersService, ProgramsService, CommissionService, CommissionScheduler],
  exports: [PartnersService, ProgramsService, CommissionService],
})
export class PartnersModule {}
