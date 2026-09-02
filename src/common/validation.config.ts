import { BadRequestException, ValidationError, ValidationPipeOptions } from '@nestjs/common';

/**
 * The global request-validation configuration, in one place.
 *
 * `main.ts` and `test/validation.spec.ts` both read this. That matters: the spec
 * used to construct its own ValidationPipe, which meant it would have kept passing
 * if someone flipped `forbidNonWhitelisted` off in main.ts — a test guarding a
 * setting it also defines guards nothing.
 *
 * `forbidNonWhitelisted` turns a silent discard into a loud 400. With `whitelist`
 * alone an unexpected property was stripped and the request still succeeded, so a
 * caller sending a typo'd key got a 200 and a half-applied change. On a money
 * system, the caller and the contract disagreeing must be an error.
 *
 * ## Which webhooks are exempt, and which only LOOKED exempt
 *
 * A SIGNED webhook needs no exemption: it reads `req.body` directly, because the
 * raw body is required for HMAC verification, so it never passes through this
 * pipe. `rival-webhook` is the one that actually works this way.
 *
 * ⚠️ `Mt5WebhooksController` does NOT. This block used to lump it in with the
 * above — "the bridge is a system we do not own ... so it must keep tolerating
 * extra fields" — as though that were already the case. It takes `@Body() dto`
 * like any other route, so `forbidNonWhitelisted` applied to it in full, and the
 * stated principle was documentation of an intention nobody had implemented.
 *
 * The cost was real and it is the reason this paragraph exists. The bridge is a
 * separate service on its own release train; the day its live payload grew a
 * field, every push to a CRM that had not been redeployed answered 400. The deal
 * outbox retried forever against an error only a deploy could fix, and the live
 * account feed — which never retries, deliberately — stopped dead, with the
 * portal quietly falling back to polling and nothing on screen saying why.
 *
 * That controller now carries its own `@UsePipes` with
 * `forbidNonWhitelisted: false`, keeping `whitelist` so an unknown field is
 * discarded rather than stored. **A DTO consumed by an independently deployed
 * sender needs the same treatment**, and the test to write for it is that an
 * unrecognised property does not fail the request.
 */
export const VALIDATION_PIPE_OPTIONS: ValidationPipeOptions = {
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
  /*
   * A FIELD MAP, not a bag of English sentences — PLATFORM-CONVENTIONS R-2.2.
   *
   * class-validator's default output is `message: string[]`, e.g.
   * `["amount must be a number string"]`. A form cannot map that back to an
   * input without string-matching English — which breaks on a reworded
   * validator, and cannot work at all once the UI is translated (Rev 8 §10 lists
   * RTL Arabic as a requirement).
   *
   * So the field name, which class-validator already knows, is preserved
   * structurally. The human sentences stay in `message` so nothing that reads
   * them today breaks.
   */
  exceptionFactory: (errors: ValidationError[]) =>
    new BadRequestException({
      code: 'VALIDATION_FAILED',
      message: flattenMessages(errors),
      fields: toFieldMap(errors),
    }),
};

/**
 * `{ amount: 'must be a number string', 'document.type': 'must be one of …' }`
 *
 * Nested DTOs are flattened with a dotted path rather than nested objects: a
 * form knows its input by the same path it posted, and a nested shape would make
 * every consumer write a walker.
 */
function toFieldMap(errors: ValidationError[], prefix = ''): Record<string, string> {
  const fields: Record<string, string> = {};

  for (const error of errors) {
    const path = prefix ? `${prefix}.${error.property}` : error.property;

    const constraints = Object.values(error.constraints ?? {});
    if (constraints.length > 0) {
      // One message per field: a form shows one message under one input, and the
      // first constraint is the most specific thing wrong with it.
      fields[path] = constraints[0];
    }

    if (error.children?.length) {
      Object.assign(fields, toFieldMap(error.children, path));
    }
  }

  return fields;
}

/** The flat sentence list, unchanged, so existing callers keep working. */
function flattenMessages(errors: ValidationError[], prefix = ''): string[] {
  const messages: string[] = [];

  for (const error of errors) {
    const path = prefix ? `${prefix}.${error.property}` : error.property;
    messages.push(...Object.values(error.constraints ?? {}));
    if (error.children?.length) {
      messages.push(...flattenMessages(error.children, path));
    }
  }

  return messages;
}
