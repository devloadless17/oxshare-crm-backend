import { ValidationPipeOptions } from '@nestjs/common';

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
 * The MT5 bridge webhook needs no exemption: it reads `req.body` directly, because
 * the raw body is required for HMAC verification, so it never passes through this
 * pipe. That matters — the bridge is a system we do not own, and per that
 * controller's own note "a lost deal is an unpaid partner", so it must keep
 * tolerating extra fields.
 */
export const VALIDATION_PIPE_OPTIONS: ValidationPipeOptions = {
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
};
