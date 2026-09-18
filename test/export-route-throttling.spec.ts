import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { DiscoveryService, MetadataScanner } from '@nestjs/core';
import { PATH_METADATA } from '@nestjs/common/constants';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import { EXPORT_RATE_LIMIT } from '../src/common/export/export-response';

/**
 * Every CSV export names a rate limit — the other half of R-3.5.
 *
 * ## What was open
 *
 * All fourteen exports inherited the global 120/min and nothing else. That
 * limit is sized for a person moving around a console; an export is a batched
 * streaming read over the WHOLE filtered client base, held open for the length
 * of the download (`export-response.ts`). A hundred and twenty concurrent
 * full-table streams is not a rate the database was ever asked about.
 *
 * It is not a data-exposure hole — every export is scoped, masked and
 * permission-gated — which is exactly why it stayed invisible: nothing about it
 * fails, it just costs more than anybody decided to spend.
 *
 * ## Why a census rather than fourteen assertions
 *
 * Because the failure mode is a FIFTEENTH export, written next month, that
 * inherits the global limit by omission — the same shape as the credential
 * routes, whose own file promised a completeness test for years without having
 * one. This finds an export by its ROUTE, so a new one arrives here by existing.
 */

let app: INestApplication;

const TTL = 'THROTTLER:TTLdefault';
const LIMIT = 'THROTTLER:LIMITdefault';

beforeAll(async () => {
  process.env['NODE_ENV'] ??= 'test';
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  await app.init();
}, 60_000);

afterAll(async () => {
  await app?.close();
});

interface ExportRoute {
  signature: string;
  ttl: number | undefined;
  limit: number | undefined;
}

/** Every route whose path ends in `export`, with the limit it declares. */
function exportRoutes(): ExportRoute[] {
  const discovery = app.get(DiscoveryService);
  const scanner = new MetadataScanner();
  const found: ExportRoute[] = [];

  for (const wrapper of discovery.getControllers()) {
    const instance = wrapper.instance as Record<string, unknown> | undefined;
    const controllerClass = wrapper.metatype as (new (...args: never[]) => unknown) | undefined;
    if (!instance || !controllerClass) continue;

    const prefix = String(Reflect.getMetadata(PATH_METADATA, controllerClass) ?? '');
    const prototype = Object.getPrototypeOf(instance) as object;

    for (const methodName of scanner.getAllMethodNames(prototype)) {
      const handler = instance[methodName] as ((...args: never[]) => unknown) | undefined;
      if (typeof handler !== 'function') continue;
      const path = Reflect.getMetadata(PATH_METADATA, handler) as unknown;
      if (typeof path !== 'string' || !path.endsWith('export')) continue;

      found.push({
        signature: `${prefix}/${path}`,
        ttl: Reflect.getMetadata(TTL, handler) as number | undefined,
        limit: Reflect.getMetadata(LIMIT, handler) as number | undefined,
      });
    }
  }

  return found.sort((a, b) => a.signature.localeCompare(b.signature));
}

describe('every CSV export declares its own rate limit', () => {
  it('finds the exports at all, so this cannot pass vacuously', () => {
    // The assertion that stops a broken scan reading as a clean bill of health:
    // an empty list satisfies "every export is throttled" perfectly.
    expect(exportRoutes().length).toBeGreaterThanOrEqual(14);
  });

  it('leaves none of them on the global limit', () => {
    const unlimited = exportRoutes()
      .filter((route) => route.ttl === undefined || route.limit === undefined)
      .map((route) => route.signature);

    expect(
      unlimited,
      'These exports carry no @Throttle, so they inherit the global 120/min — which is a ' +
        'limit for console clicks, not for concurrent streaming reads of the whole client ' +
        'base:\n' +
        unlimited.map((r) => `  ${r}`).join('\n'),
    ).toEqual([]);
  });

  it('holds them all to the SAME shared figure, not fourteen opinions', () => {
    /*
     * One constant rather than a number typed fourteen times. Copies drift —
     * somebody tunes the noisy one and the other thirteen keep the old value —
     * and then "what is the export limit" has fourteen answers.
     */
    const odd = exportRoutes()
      .filter((route) => route.limit !== EXPORT_RATE_LIMIT)
      .map((route) => `${route.signature} (${String(route.limit)})`);

    expect(odd, `These declare a limit other than EXPORT_RATE_LIMIT:\n${odd.join('\n')}`).toEqual(
      [],
    );
  });

  it('keeps the figure generous enough that nobody routes around it', () => {
    // A limit tight enough to bounce an operator exporting two lists in a row
    // gets removed the first time it does. Six a minute is far above any human
    // use of an Export button and far below what a loop would do.
    expect(EXPORT_RATE_LIMIT).toBeGreaterThanOrEqual(5);
    expect(EXPORT_RATE_LIMIT).toBeLessThan(120);
  });
});
