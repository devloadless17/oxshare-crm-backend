/**
 * Writes the OpenAPI document to openapi.json, without starting a server.
 *
 * PLATFORM-CONVENTIONS R-1.3. Both frontends generate their API types from this
 * document, and until now nothing verified that the committed types still
 * matched it: the frontend pipelines type-check against their own committed
 * `types.gen.ts`, so a backend shape change with no regeneration left all three
 * builds green while the running system was broken. The admin CI even carried a
 * comment claiming it caught that. It could not — it never runs the backend.
 *
 * Committing the document is what closes the loop. It turns "did anyone
 * remember to regenerate" into a diff someone reviews, and gives the frontend
 * pipelines something to check against without booting a database.
 */
import { writeFileSync, readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { SwaggerModule } from '@nestjs/swagger';
import { AppModule } from '../dist/app.module.js';
import { applyApiPrefix } from '../dist/common/api-prefix.js';
import { ErrorResponseDto } from '../dist/common/dto/error-response.dto.js';
import { buildSwaggerConfig } from '../dist/common/swagger-config.js';

const OUTPUT = 'openapi.json';

/*
 * ⚠️ THIS SCRIPT READS dist/, NOT src/ — so it can lie about a change it cannot see.
 *
 * The imports above come from `../dist/`, because the document is built by
 * booting the compiled Nest app. `npm run gen:openapi` does `nest build` first,
 * and CI builds before it checks, so both are honest. The bare
 * `node scripts/gen-openapi.mjs --check` is not: run by hand against a stale
 * dist/ it compares the committed document to one generated from OLD CODE and
 * reports "up to date" while a DTO change sits invisible to it.
 *
 * Reproduced rather than theorised: ten fields added to a DTO, the check
 * answered "up to date"; `npm run build`, the identical check answered "out of
 * date". Same source, same document, opposite answers, dist/ the only variable.
 *
 * That is the same silent-staleness class as the migration watermark and the
 * `nest --watch` note in CLAUDE.md, and it matters more than usual here: the
 * shape-masking design depends on DTO declarations reaching the published
 * contract, and this is the gate guarding that.
 *
 * So it REFUSES rather than guessing. Nothing is rebuilt automatically — a
 * generator that silently rebuilds hides how long it really takes, and the
 * remedy is one command the message names.
 */
function newestMtime(dir) {
  let newest = 0;
  const walk = (path) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = join(path, entry.name);
      if (entry.isDirectory()) walk(full);
      else newest = Math.max(newest, statSync(full).mtimeMs);
    }
  };
  if (existsSync(dir)) walk(dir);
  return newest;
}

if (!existsSync('dist')) {
  console.error('dist/ does not exist. This script reads the COMPILED app — run `npm run build`.');
  process.exit(1);
}

const srcAt = newestMtime('src');
const distAt = newestMtime('dist');
if (srcAt > distAt) {
  console.error(
    'REFUSING: dist/ is older than src/, so this would describe code that is no longer there.\n' +
      `  newest src/  ${new Date(srcAt).toISOString()}\n` +
      `  newest dist/ ${new Date(distAt).toISOString()}\n` +
      'Run `npm run build` first, or use `npm run gen:openapi`, which builds for you.',
  );
  process.exit(1);
}

// Boot secrets. The document is built from decorators, so nothing here reaches a
// database or signs anything — but config validation refuses to start without
// them, which is exactly the behaviour we want everywhere else.
process.env.NODE_ENV ??= 'test';
process.env.ADMIN_JWT_SECRET ??= 'openapi-generation-only-not-a-real-secret-value';
process.env.JWT_ACCESS_SECRET ??= 'openapi-generation-only-not-a-real-secret-value';
process.env.JWT_REFRESH_SECRET ??= 'openapi-generation-only-not-a-real-secret-value';
// The fourth secret. env.validation.ts requires it in EVERY environment, so
// without this line the generator could not boot on a clean checkout — and this
// script is what R-1.3's contract-drift gate runs.
process.env.ADMIN_JWT_REFRESH_SECRET ??= 'openapi-generation-only-not-a-real-secret-value';

const app = await NestFactory.create(AppModule, { logger: false });

// The same call main.ts makes. Without it the document describes bare paths
// while the server serves /v1/... — and the frontends would generate types for
// an API that does not exist (R-2.1).
applyApiPrefix(app);

// The SAME config main.ts serves. It used to be a second copy here, and the
// copy still declared bearer auth and the legacy `access_token` cookie long
// after main.ts stopped — so the contract both frontends generate from
// described a credential this API deletes.
const config = buildSwaggerConfig();

// extraModels: the error envelope is emitted by AllExceptionsFilter, not
// returned by any handler, so nothing else puts it in the document.
const document = SwaggerModule.createDocument(app, config, {
  extraModels: [ErrorResponseDto],
});
await app.close();

const serialized = `${JSON.stringify(document, null, 2)}\n`;

// --check: fail instead of writing, so CI reports drift rather than hiding it
// by silently regenerating.
if (process.argv.includes('--check')) {
  const current = existsSync(OUTPUT) ? readFileSync(OUTPUT, 'utf8') : '';
  if (current !== serialized) {
    console.error(
      `${OUTPUT} is out of date.\n\n` +
        'A request or response shape changed without the document being regenerated. Run:\n' +
        '  npm run gen:openapi\n\n' +
        'then regenerate the frontend types in both apps (npm run gen:api-types) and commit\n' +
        'all three. Skipping this is how a backend shape change reaches production while\n' +
        'every pipeline stays green.',
    );
    process.exit(1);
  }
  console.log(`${OUTPUT} is up to date.`);
  process.exit(0);
}

writeFileSync(OUTPUT, serialized);
console.log(`Wrote ${OUTPUT} (${Object.keys(document.paths ?? {}).length} paths).`);
