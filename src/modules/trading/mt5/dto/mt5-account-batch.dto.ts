import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayMinSize, IsArray, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { Mt5AccountSnapshotDto } from './mt5-account-snapshot.dto';

/**
 * A round's worth of balances in one request.
 *
 * ## Why the sweep needed this
 *
 * One request per account is what does not scale: at ~16/s a 300-second round
 * cannot push more than ~4,800 accounts before the next one starts, whatever the
 * rate limit says. The deal path was fixed the same way; without this the
 * balance mirror is simply the first thing to fall behind on a large estate.
 *
 * ## 500, matching the deal batch
 *
 * The same reasoning and deliberately the same number: past a few hundred the
 * saving flattens while the cost of a rejected payload grows, and two different
 * ceilings on two sibling endpoints is a difference somebody would have to look
 * up. The whole batch is one UPDATE and at most one follow-up read.
 */
export class Mt5AccountBatchDto {
  @ApiProperty({
    type: [Mt5AccountSnapshotDto],
    description:
      'Balance snapshots, in any order. Two reads of one login are collapsed to the FRESHEST — ' +
      'the staleness guard would discard the older one regardless, and Postgres refuses to ' +
      'update a row twice in one statement.',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => Mt5AccountSnapshotDto)
  snapshots!: Mt5AccountSnapshotDto[];
}
