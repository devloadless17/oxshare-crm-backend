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
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from '../dist/app.module.js';
import { applyApiPrefix } from '../dist/common/api-prefix.js';

const OUTPUT = 'openapi.json';

// Boot secrets. The document is built from decorators, so nothing here reaches a
// database or signs anything — but config validation refuses to start without
// them, which is exactly the behaviour we want everywhere else.
process.env.NODE_ENV ??= 'test';
process.env.ADMIN_JWT_SECRET ??= 'openapi-generation-only-not-a-real-secret-value';
process.env.JWT_ACCESS_SECRET ??= 'openapi-generation-only-not-a-real-secret-value';
process.env.JWT_REFRESH_SECRET ??= 'openapi-generation-only-not-a-real-secret-value';

const app = await NestFactory.create(AppModule, { logger: false });

// The same call main.ts makes. Without it the document describes bare paths
// while the server serves /v1/... — and the frontends would generate types for
// an API that does not exist (R-2.1).
applyApiPrefix(app);

const config = new DocumentBuilder()
  .setTitle('OxShare CRM API')
  .setDescription('Forex/CFD Introducing-Broker CRM — Phase 1')
  .setVersion('1.0')
  .addBearerAuth()
  .addCookieAuth('access_token')
  .build();

const document = SwaggerModule.createDocument(app, config);
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
