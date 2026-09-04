/**
 * Past this, a pending transfer is a person's problem rather than a retry's.
 *
 * FIFTEEN MINUTES, down from six hours. Six was chosen against "how long might
 * a normal outage last" and answered the wrong question: the resume job retries
 * every minute, so anything still pending after fifteen is not waiting out a
 * blip — it is hitting something that will not clear by itself, and the next
 * five and three-quarter hours add nothing but a client watching a spinner.
 *
 * Long enough that an ordinary bridge restart passes without paging anybody.
 *
 * ## ⚠️ ITS OWN FILE, and that is not tidying
 *
 * This lived in `transfer-resume.scheduler.ts`, and exporting it from there to
 * a second reader BROKE THE BOOT. The scheduler imports `TransferExecutor`,
 * which imports `TransfersService` — so a `TransfersService` that imports the
 * scheduler back closes a runtime cycle, and Nest resolves the class to
 * `undefined`: "Nest can't resolve dependencies of the TransferExecutor
 * (DRIZZLE_DB, ?, Mt5BridgeClient)". It typechecks perfectly, because the cycle
 * is real only at runtime.
 *
 * A LEAF module — importing nothing — cannot participate in a cycle, whoever
 * reads it. Anything else shared between the scheduler and the service belongs
 * here for the same reason.
 */
export const TRANSFER_STALE_MS = 15 * 60 * 1000;
