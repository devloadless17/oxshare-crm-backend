import { describe, expect, it } from 'vitest';
import 'reflect-metadata';
import type { ArgumentMetadata, PipeTransform } from '@nestjs/common';
import { Mt5WebhooksController } from '../src/modules/trading/mt5/mt5-webhooks.controller';
import { Mt5LiveDto } from '../src/modules/trading/mt5/dto/mt5-live.dto';
import { Mt5AccountSnapshotDto } from '../src/modules/trading/mt5/dto/mt5-account-snapshot.dto';

/**
 * The bridge deploys separately, so a field it learns to send must not take the
 * CRM down.
 *
 * ## The outage this pins
 *
 * The global pipe sets `forbidNonWhitelisted: true` — an unexpected property is
 * a 400. Right for a browser posting a form; wrong for a webhook whose sender is
 * a different service on its own release train.
 *
 * `validation.config.ts` claimed this surface was already exempt, on the
 * reasoning that a signed webhook reads the raw body and never reaches the pipe.
 * That is true of the Rival webhook and has never been true of this one, which
 * takes `@Body() dto` like any other route. The exemption was documented and not
 * implemented.
 *
 * It became load-bearing the day the live payload grew a `comment` field. The
 * bridge shipped first, every push to the not-yet-redeployed CRM answered 400,
 * and the live account feed — which never retries, deliberately — stopped dead.
 * No backlog, no growing queue, nothing on screen: the portal quietly fell back
 * to polling and the figures just looked old.
 *
 * ## Why this exercises the pipe instead of reading metadata
 *
 * A test asserting "a pipe is attached" passes on a pipe configured wrongly, and
 * the whole failure here was a setting nobody had checked. So it pulls the real
 * pipe off the controller and runs a payload through it.
 *
 * Mutation-checked: removing the `@UsePipes` line and flipping
 * `forbidNonWhitelisted` back to true each fail the first test below.
 */

/** How Nest stores `@UsePipes` on a controller class. */
const PIPES_METADATA = '__pipes__';

function controllerPipe(): PipeTransform {
  const pipes = Reflect.getMetadata(PIPES_METADATA, Mt5WebhooksController) as
    PipeTransform[] | undefined;

  expect(pipes, 'Mt5WebhooksController must carry its own validation pipe').toBeDefined();
  expect(pipes).toHaveLength(1);

  return pipes![0];
}

const body = (metatype: unknown): ArgumentMetadata =>
  ({ type: 'body', metatype, data: undefined }) as ArgumentMetadata;

/** A complete, valid live reading — the shape the bridge sends today. */
const LIVE_READING = {
  login: '00012345',
  currency: 'USD',
  balance: '1250.00000000',
  equity: '1237.60000000',
  credit: '0.00000000',
  margin: '33.00000000',
  marginFree: '1204.60000000',
  marginLevel: '3750.30',
  readAt: '2026-09-02T12:00:00.000Z',
  positions: [],
};

describe('the MT5 webhook tolerates a bridge that is ahead of it', () => {
  /*
   * THE regression. A future bridge sending a field this build has never heard
   * of must be accepted, not refused — the alternative is that shipping the two
   * services in the wrong order silently kills the live feed.
   */
  it('accepts a reading carrying a field this build does not know', async () => {
    const pipe = controllerPipe();

    const result = (await pipe.transform(
      { ...LIVE_READING, someFutureField: 'from a newer bridge' },
      body(Mt5LiveDto),
    )) as Record<string, unknown>;

    expect(result['equity']).toBe('1237.60000000');
  });

  /*
   * Tolerated is not the same as STORED. `whitelist` stays on, so an unknown
   * field is discarded on the way in and cannot reach a service or a column by
   * accident.
   */
  it('discards the unknown field rather than passing it through', async () => {
    const pipe = controllerPipe();

    const result = (await pipe.transform(
      { ...LIVE_READING, someFutureField: 'from a newer bridge' },
      body(Mt5LiveDto),
    )) as Record<string, unknown>;

    expect(result['someFutureField']).toBeUndefined();
  });

  /*
   * The money path is NOT weakened. A field the CRM acts on that is missing, or
   * present in the wrong shape, still fails — this exemption covers exactly one
   * thing: a name this build has not heard of.
   */
  it('still refuses a reading whose money is not a decimal string', async () => {
    const pipe = controllerPipe();

    await expect(
      pipe.transform({ ...LIVE_READING, equity: 1237.6 }, body(Mt5LiveDto)),
    ).rejects.toThrow();
  });

  it('still refuses a reading with a required field missing', async () => {
    const pipe = controllerPipe();

    const { readAt: _dropped, ...withoutReadAt } = LIVE_READING;
    await expect(pipe.transform(withoutReadAt, body(Mt5LiveDto))).rejects.toThrow();
  });

  /*
   * The same tolerance covers the whole controller, not just the live route.
   * A deal or a balance snapshot arriving from a newer bridge carries the same
   * hazard, and the deal one is worse: its outbox retries forever, so a 400
   * there is an unpaid partner rather than a stale screen.
   */
  it('extends the tolerance to the balance snapshot the sweep pushes', async () => {
    const pipe = controllerPipe();

    const result = (await pipe.transform(
      {
        login: '00012345',
        balance: '1250.00000000',
        readAt: '2026-09-02T12:00:00.000Z',
        someFutureField: 'from a newer bridge',
      },
      body(Mt5AccountSnapshotDto),
    )) as Record<string, unknown>;

    expect(result['balance']).toBe('1250.00000000');
    expect(result['someFutureField']).toBeUndefined();
  });
});
