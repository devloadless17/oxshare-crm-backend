import { BadRequestException } from '@nestjs/common';
import type { Response } from 'express';
import { csvHeader, csvRow, type CsvColumn } from './csv';

/**
 * The transport edge of a table export: format validation, the filename header,
 * and streaming the rows out.
 *
 * This file is allowed to import `@nestjs/common` and `express` because it IS
 * the transport edge — it is called from controllers, never from a service. The
 * layering rule that bans HTTP types applies to `*.service.ts` and `store/**`,
 * and the row-fetching half of every export lives there, untouched by this.
 */

/**
 * The formats this API serves.
 *
 * `xlsx` is NOT here, and its absence is the decision. Writing a real workbook
 * means a spreadsheet library — `exceljs` and friends pull in a zip writer, an
 * XML builder and a few megabytes of dependency — and adding one to a money
 * system's dependency tree is a supply-chain decision somebody should take
 * deliberately rather than as a side effect of an export button.
 *
 * The alternative, serving CSV bytes under an `.xlsx` filename, is refused by
 * R-2.5: an unrecognised parameter value is a 400 naming what IS allowed, never
 * a silent substitution. An operator who asked for a workbook and received a
 * renamed CSV finds out when Excel refuses to open it, with nothing to explain
 * why — which is strictly worse than being told now.
 */
export const EXPORT_FORMATS = ['csv'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

/**
 * The requested format, or a 400 naming what is supported.
 *
 * An ABSENT `format` defaults to csv rather than erroring: the parameter names
 * which of several representations the caller wants, and there is currently only
 * one, so requiring it would be ceremony. An `xlsx` explicitly asked for is a
 * different thing entirely — the caller stated a preference this API cannot
 * honour, and R-2.5 says so out loud.
 */
export function exportFormat(value: string | undefined): ExportFormat {
  if (value === undefined || value === '') return 'csv';
  if ((EXPORT_FORMATS as readonly string[]).includes(value)) return value as ExportFormat;

  throw new BadRequestException({
    code: 'VALIDATION_FAILED',
    message: [
      `format must be one of: ${EXPORT_FORMATS.join(', ')}. ` +
        `"${value}" is not supported — this API writes CSV only, and serving CSV bytes under ` +
        'another extension would be a file the spreadsheet refuses to open.',
    ],
    fields: { format: `must be one of: ${EXPORT_FORMATS.join(', ')}` },
  });
}

/** `<resource>-<YYYY-MM-DD>.csv`, from the SERVER's clock. */
export function exportFilename(resource: string, format: ExportFormat, now = new Date()): string {
  /*
   * The date is the server's, and the client prefers this name over its own
   * fallback precisely because of that (see the admin app's `export.ts`): an
   * operator whose laptop clock is a day out would otherwise file an audit
   * artefact under the wrong day.
   *
   * The resource's `/` is replaced because `ib/applications` would otherwise
   * produce a filename containing a path separator, which a browser either
   * rejects or silently truncates to the last segment.
   */
  return `${resource.replace(/\//g, '-')}-${now.toISOString().slice(0, 10)}.${format}`;
}

/**
 * Set the headers that make a browser download the body as a named file.
 *
 * BOTH forms of the filename are sent, in the order RFC 6266 prescribes: the
 * plain `filename=` for old clients, then `filename*=UTF-8''…` which is the one
 * that survives non-ASCII. The admin client reads the extended form first and
 * falls back — sending only the plain one would work today and break the moment
 * a resource name stops being ASCII.
 */
export function setExportHeaders(res: Response, filename: string): void {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
  );
  /*
   * An export of client PII must not settle into a shared cache, and `no-store`
   * rather than `no-cache` because the difference matters here: `no-cache`
   * permits storing the response and revalidating, which still writes client
   * names to a proxy's disk.
   */
  res.setHeader('Cache-Control', 'no-store');
  // The API origin holds the session cookies. Nothing served from it may ever be
  // sniffed into active content — the same rule the uploads controller follows.
  res.setHeader('X-Content-Type-Options', 'nosniff');
}

/**
 * The ceiling on a single export.
 *
 * ── Why there is a cap at all ───────────────────────────────────────────────
 *
 * ARCHITECTURE §5 sizes the client base at ~219,000 rows. An export is one HTTP
 * request that holds a database read open for its whole duration, and an
 * unbounded one over that table is a request an operator can fire by clicking a
 * button on an unfiltered screen. The rows stream rather than accumulating in
 * memory, so the cap is not about heap — it is about how long one request may
 * hold a connection and how large a file the operator is handed.
 *
 * ── Why it is not silent ────────────────────────────────────────────────────
 *
 * A truncated export that says nothing is the worst outcome available: it is an
 * audit artefact that LOOKS complete, and a reviewer who exports 250,000 clients
 * and receives 200,000 rows has no way to know. So reaching the cap appends a
 * final row saying so — see `EXPORT_TRUNCATED_NOTICE`. The file remains valid
 * CSV and the notice is impossible to miss in a spreadsheet.
 */
export const MAX_EXPORT_ROWS = 200_000;

/** How many rows are fetched per database round trip while streaming. */
/**
 * Exports a caller may start per minute, per route.
 *
 * Named here beside the batch size because the two describe the same cost from
 * opposite ends: one bounds how much a single export reads at a time, this
 * bounds how often one can be started at all. Both were absent from the route
 * decorators, so every export inherited the global 120/min — a limit sized for a
 * person clicking around a console, not for a hundred concurrent streaming reads
 * over the whole client base.
 *
 * Deliberately generous against human use and tight against a loop: nobody
 * presses Export six times in a minute, and a script doing so is the case worth
 * bounding.
 */
export const EXPORT_RATE_LIMIT = 6;

export const EXPORT_BATCH_SIZE = 1_000;

/**
 * The last row of a truncated export.
 *
 * A row rather than a header, deliberately: a header is invisible once the file
 * is open in Excel, and this is the one fact a reader of a truncated export must
 * not miss.
 */
export const EXPORT_TRUNCATED_NOTICE = (limit: number) =>
  `TRUNCATED: this export stopped at the ${limit.toLocaleString('en-US')}-row limit. ` +
  'Narrow the filters and export again — rows are MISSING from this file.';

/**
 * Fetch one batch of rows: `offset`/`limit` into the filtered, scoped set.
 *
 * The scope predicate lives inside this function's implementation, in the query,
 * which is the property `common/security/client-scope.ts` insists on — an
 * exporter cannot accidentally serve unscoped rows because it never sees rows
 * the store did not already filter.
 */
export type ExportBatchFetcher<T> = (offset: number, limit: number) => Promise<T[]>;

/**
 * Stream a CSV export to the response, in batches.
 *
 * ── Streaming rather than building a string ─────────────────────────────────
 *
 * A 200,000-row client export is tens of megabytes. Built as one string it is
 * that much heap in a single allocation, on a process serving every other admin
 * request, and it delays the first byte until the last row is read. Written
 * batch by batch, memory is bounded by `EXPORT_BATCH_SIZE` and the operator's
 * browser starts receiving the file immediately.
 *
 * ── Why headers are set before the first write, and never after ─────────────
 *
 * Once any body byte is written the status and headers are committed. So the
 * fetch of the FIRST batch happens before `setExportHeaders`, which means a
 * failure that would have been a 500 still is one — an error thrown after the
 * first write would produce a truncated file carrying a 200, which is a corrupt
 * export the client cannot distinguish from a complete one.
 */
export async function streamCsv<T>(
  res: Response,
  resource: string,
  format: ExportFormat,
  columns: readonly CsvColumn<T>[],
  fetchBatch: ExportBatchFetcher<T>,
): Promise<void> {
  // The first batch BEFORE any header is set — see above. A permission or
  // validation failure raised in here is still a clean error response.
  let batch = await fetchBatch(0, EXPORT_BATCH_SIZE);

  setExportHeaders(res, exportFilename(resource, format));
  res.write(csvHeader(columns));

  let written = 0;
  while (batch.length > 0) {
    for (const item of batch) {
      if (written >= MAX_EXPORT_ROWS) {
        res.write(`${EXPORT_TRUNCATED_NOTICE(MAX_EXPORT_ROWS)}\r\n`);
        res.end();
        return;
      }
      res.write(csvRow(columns, item));
      written += 1;
    }

    /*
     * BACKPRESSURE, once per batch.
     *
     * `res.write` returns false when the socket's buffer is full, and ignoring
     * that makes "streaming" a fiction: Node keeps accepting writes and queues
     * them in memory, so a slow client — an operator on hotel wifi downloading
     * 200,000 rows — has the whole file accumulate in the server's heap anyway,
     * which is the exact failure streaming was chosen to avoid.
     *
     * Awaiting `drain` yields until the kernel has taken what was written, so
     * the loop runs at the speed the client can receive. Checked per BATCH
     * rather than per row: the condition changes every few thousand rows, and
     * testing it 200,000 times would cost more than it saves.
     *
     * The `writableEnded`/`destroyed` guard is what stops a client that hung up
     * mid-export from hanging the request until timeout — `drain` never fires
     * on a dead socket, and the handler would hold its database connection for
     * the whole wait.
     */
    if (res.writableNeedDrain) {
      if (res.writableEnded || res.destroyed) return;
      await new Promise<void>((resolve) => res.once('drain', resolve));
    }

    // A short batch means the source is exhausted — no extra round trip to
    // discover it.
    if (batch.length < EXPORT_BATCH_SIZE) break;
    batch = await fetchBatch(written, EXPORT_BATCH_SIZE);
  }

  res.end();
}

/**
 * Stream an export whose source is a SINGLE already-materialised array.
 *
 * For the configuration tables — currencies, tags, payment methods, roles,
 * administrators. Each is a bounded operator-managed list in the dozens, they
 * have no paginated store method to batch through, and inventing one purely for
 * an export would be a second query path to keep in step with the list screen's.
 *
 * The cap still applies, so this cannot become an accidental unbounded read if
 * one of those tables ever grows.
 */
export async function streamCsvFromArray<T>(
  res: Response,
  resource: string,
  format: ExportFormat,
  columns: readonly CsvColumn<T>[],
  load: () => Promise<readonly T[]>,
): Promise<void> {
  const all = await load();
  await streamCsv(res, resource, format, columns, (offset, limit) =>
    Promise.resolve(all.slice(offset, offset + limit)),
  );
}
