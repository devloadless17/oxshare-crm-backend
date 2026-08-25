import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayMinSize, IsArray, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { Mt5DealDto } from './mt5-deal.dto';

/**
 * Many deals in one request — the sweep's delivery shape.
 *
 * ## Why there is a ceiling and what sets it
 *
 * 500. Not a round number picked for looks: the whole batch is one INSERT and
 * one indexed lookup, and both are bounded by how much the global
 * `ValidationPipe` will walk before the request has cost more than the round
 * trips it saves. Past a few hundred the saving flattens and the failure mode
 * gets worse — a rejected 5,000-deal payload wastes the whole read.
 *
 * A hundred thousand deals is two hundred requests at this size, against a
 * hundred thousand at one deal each. That is the difference the endpoint exists
 * for: half an hour of sequential delivery becomes seconds.
 *
 * ## Why not simply raise it further
 *
 * The bridge retries a failed batch whole, so a batch is also the unit of
 * WASTED work when something goes wrong. Five hundred bounds that at something
 * a retry can absorb without anyone noticing.
 */
export class Mt5DealBatchDto {
  @ApiProperty({
    type: [Mt5DealDto],
    description:
      'Closed deals, in any order. Duplicates within the payload are collapsed, and a ticket ' +
      'the CRM already holds is reported as `ingested: false` rather than refused — ingestion ' +
      'is idempotent on the MT5 ticket, which is what makes batching safe.',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => Mt5DealDto)
  deals!: Mt5DealDto[];
}
