import { Module } from '@nestjs/common';
import { PartnersController } from './partners.controller';
import { PartnersService } from './partners.service';
import { ProgramsService } from './programs.service';

/** IB programs · commission engine · accruals · payouts · L1/L2 structure */
@Module({
  controllers: [PartnersController],
  providers: [PartnersService, ProgramsService],
  exports: [PartnersService, ProgramsService],
})
export class PartnersModule {}
