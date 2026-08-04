import { describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { KycController } from '../src/modules/compliance/kyc.controller';
import { KycService } from '../src/modules/compliance/kyc.service';
import { KycConfigStore } from '../src/store/kyc-config.store';
import { JwtAuthGuard } from '../src/modules/identity/guards/jwt-auth.guard';
import { EmailVerifiedGuard } from '../src/modules/identity/guards/email-verified.guard';
import { VALIDATION_PIPE_OPTIONS } from '../src/common/validation.config';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';

/**
 * The KYC upload is bounded where the bytes are, not where the response is.
 *
 * `MaxFileSizeValidator` is a ParseFilePipe, and a pipe runs after multer has
 * already streamed the entire body to disk. The route therefore advertised a
 * 10 MB limit while accepting an unbounded write: an authenticated,
 * email-verified client could fill the volume that holds every KYC document on
 * the platform (they are on the API host's local disk until the S3 move), one
 * request at a time, and each one would be answered with a tidy 413.
 *
 * These tests drive the real Nest pipeline with a real multipart body, because
 * the defect was entirely in the ORDER the framework runs things — a unit test
 * of either component in isolation would have passed throughout.
 *
 * No database and no container: the service is stubbed, since what is under test
 * is the upload boundary, not what happens to the record afterwards.
 */

const MB = 1024 * 1024;

/**
 * Total bytes sitting in the KYC upload directory.
 *
 * Counting BYTES rather than files is deliberate: a partially-written oversize
 * upload is one file, so a file count would not distinguish "aborted at 10 MB"
 * from "never started".
 */
function storedBytes(dir: string): number {
  if (!existsSync(dir)) return 0;
  return readdirSync(dir).reduce((total, name) => total + statSync(join(dir, name)).size, 0);
}

interface Recorded {
  attached: { userId: string; field: string; path: string }[];
  failNext: boolean;
}

async function makeApp(recorded: Recorded): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    controllers: [KycController],
    providers: [
      {
        provide: KycService,
        useValue: {
          attachFile: (userId: string, field: string, path: string) => {
            if (recorded.failNext) {
              recorded.failNext = false;
              return Promise.reject(new Error('simulated store failure'));
            }
            recorded.attached.push({ userId, field, path });
            return Promise.resolve({ message: 'ok' });
          },
        },
      },
      { provide: KycConfigStore, useValue: { getSteps: () => Promise.resolve([]) } },
    ],
  })
    // The guards are not what is under test; a fixed user keeps the multipart
    // path honest without standing up auth.
    .overrideGuard(JwtAuthGuard)
    .useValue({
      canActivate: (ctx: { switchToHttp: () => { getRequest: () => { user?: unknown } } }) => {
        ctx.switchToHttp().getRequest().user = { id: 'user-1', emailVerified: true };
        return true;
      },
    })
    .overrideGuard(EmailVerifiedGuard)
    .useValue({ canActivate: () => true })
    .compile();

  const app = moduleRef.createNestApplication();
  app.useGlobalPipes(new ValidationPipe(VALIDATION_PIPE_OPTIONS));
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();
  return app;
}

describe('KYC upload — size is bounded before anything is written', () => {
  it('accepts a document inside the limit', async () => {
    const recorded: Recorded = { attached: [], failNext: false };
    const app = await makeApp(recorded);

    try {
      await request(app.getHttpServer())
        .post('/kyc/upload')
        .field('field', 'doc_front')
        .attach('file', Buffer.alloc(64 * 1024, 1), {
          filename: 'id.png',
          contentType: 'image/png',
        })
        .expect(201);

      expect(recorded.attached).toHaveLength(1);
      // The stored name is derived from the ALLOWED type, never the filename.
      expect(recorded.attached[0].path).toMatch(/\.png$/);
    } finally {
      await app.close();
    }
  });

  it('REFUSES an oversize document without writing it to disk', async () => {
    const recorded: Recorded = { attached: [], failNext: false };
    const app = await makeApp(recorded);
    const dir = join(process.cwd(), 'uploads', 'kyc');
    const bytesBefore = storedBytes(dir);

    try {
      // 11 MB against a 10 MB ceiling.
      await request(app.getHttpServer())
        .post('/kyc/upload')
        .field('field', 'doc_front')
        .attach('file', Buffer.alloc(11 * MB, 1), {
          filename: 'huge.png',
          contentType: 'image/png',
        })
        .expect((res) => {
          expect(res.status).toBeGreaterThanOrEqual(400);
        });

      expect(recorded.attached).toHaveLength(0);

      /*
       * THE assertion, and the reason this test is written against bytes rather
       * than against the status code.
       *
       * A 4xx here proves nothing: `MaxFileSizeValidator` rejected oversize
       * uploads before this change too — it just did so AFTER multer had written
       * every byte to disk. So a test that only checked the response would have
       * passed against the vulnerable code and quietly certified the defect as
       * fixed.
       *
       * What changed is that multer aborts the stream, so the disk never grows.
       * Remove `limits` from the FileInterceptor and this line fails while every
       * other assertion in the file still passes.
       */
      expect(storedBytes(dir)).toBe(bytesBefore);
    } finally {
      await app.close();
    }
  });

  it('refuses a disallowed content type', async () => {
    const recorded: Recorded = { attached: [], failNext: false };
    const app = await makeApp(recorded);

    try {
      await request(app.getHttpServer())
        .post('/kyc/upload')
        .field('field', 'doc_front')
        .attach('file', Buffer.from('<script>alert(1)</script>'), {
          filename: 'payload.html',
          contentType: 'text/html',
        })
        .expect((res) => {
          expect(res.status).toBeGreaterThanOrEqual(400);
        });

      expect(recorded.attached).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it('deletes the written file when recording it fails', async () => {
    const recorded: Recorded = { attached: [], failNext: true };
    const app = await makeApp(recorded);
    const dir = join(process.cwd(), 'uploads', 'kyc');
    const before = existsSync(dir) ? readdirSync(dir) : [];

    try {
      await request(app.getHttpServer())
        .post('/kyc/upload')
        .field('field', 'doc_front')
        .attach('file', Buffer.alloc(1024, 1), {
          filename: 'id.png',
          contentType: 'image/png',
        })
        .expect(500);

      // An identity document that no submission references can never be served,
      // never be reviewed and never be cleaned up by anything else.
      const after = existsSync(dir) ? readdirSync(dir) : [];
      expect(after.length).toBe(before.length);
    } finally {
      await app.close();
    }
  });
});
