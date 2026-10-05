import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import type request from 'supertest';
import { z } from 'zod/v4';
import {
  actingAs,
  startHttpTestApp,
  stopHttpTestApp,
  type HttpTestContext,
  type Session,
} from './http-setup';
import { PasswordService } from '../src/common/security/password.service';
import {
  admins,
  assistantConversations,
  assistantMessages,
  assistantSettings,
  auditLog,
  roles,
  users,
} from '../src/database/schema';
import { ALL_PERMISSIONS } from './support/all-permissions';
import { AnswerRunner, type AnswerSink } from '../src/modules/assistant/answer-runner';
import { AssistantService } from '../src/modules/assistant/assistant.service';
import { FOLLOWUPS_MARKER } from '../src/modules/assistant/followups';
import {
  LLM_PROVIDER,
  LlmUpstreamError,
  type LlmEvent,
  type LlmProvider,
  type LlmRequest,
} from '../src/modules/assistant/llm/llm-provider';
import {
  ASSISTANT_TOOLS,
  ToolRegistry,
  type AssistantTool,
} from '../src/modules/assistant/tools/tool-registry';
import { AssistantStore } from '../src/store/assistant.store';

/**
 * The portal assistant's guarantees: who may ask, what it may cost, and that a
 * tool only ever acts for the session's client. A scripted model stands in for
 * OpenAI: no test here calls a real one.
 */

type Turn = (request: LlmRequest) => Iterable<LlmEvent>;

const usage = { inputTokens: 100, cachedTokens: 0, outputTokens: 20 };

/** A model that says `text` and stops. */
const says = (text: string): Turn =>
  function* () {
    yield { type: 'text', delta: text };
    yield { type: 'done', finish: 'stop', usage };
  };

class ScriptedModel implements LlmProvider {
  readonly model = 'scripted';
  turns: Turn[] = [];
  calls = 0;
  flagged = false;

  isConfigured(): boolean {
    return true;
  }

  async *stream(request: LlmRequest): AsyncIterable<LlmEvent> {
    this.calls += 1;
    const turn = this.turns.shift() ?? says('Fine.');
    for (const event of turn(request)) {
      // A real stream yields between events; so does this one.
      await Promise.resolve();
      yield event;
    }
  }

  moderate(): Promise<boolean> {
    return Promise.resolve(this.flagged);
  }
}

/** A read tool that reports which client it was run for. */
const seenBy: number[] = [];
const whoAmI: AssistantTool<{ clientId?: number }> = {
  name: 'who_am_i',
  description: 'Test tool.',
  kind: 'read',
  input: z.object({ clientId: z.number().optional() }),
  run: (ctx) => {
    seenBy.push(ctx.clientId);
    return Promise.resolve({ ok: true });
  },
};

const PASSWORD = 'client-password-123';
const ALICE = { email: 'assistant-alice@oxshare.com', password: PASSWORD };
const BOB = { email: 'assistant-bob@oxshare.com', password: PASSWORD };
const UNVERIFIED = { email: 'assistant-unverified@oxshare.com', password: PASSWORD };
const ADMIN = { email: 'assistant-admin@oxshare.com', password: PASSWORD };

const model = new ScriptedModel();
let ctx: HttpTestContext;
let alice: Session;
let bob: Session;
let aliceId: number;
let bobId: number;
let unverifiedId: number;

interface StreamEvent {
  event: string;
  data: Record<string, unknown>;
}

/** Collects an SSE body as text so the events can be parsed. */
function sse(test: request.Test): request.Test {
  return test.buffer(true).parse((res, done) => {
    let body = '';
    res.setEncoding('utf8');
    res.on('data', (chunk: string) => (body += chunk));
    res.on('end', () => done(null, body));
  });
}

function eventsOf(body: unknown): StreamEvent[] {
  return String(body)
    .split('\n\n')
    .filter((block) => block.startsWith('event:'))
    .map((block) => {
      const [eventLine, dataLine] = block.split('\n');
      return {
        event: eventLine.slice('event: '.length),
        data: JSON.parse(dataLine.slice('data: '.length)) as Record<string, unknown>,
      };
    });
}

/** A sink that shows nothing and keeps the error codes it was sent. */
function quietSink(): AnswerSink & { errors: string[] } {
  const errors: string[] = [];
  return {
    errors,
    meta: () => undefined,
    delta: () => undefined,
    followups: () => undefined,
    done: () => undefined,
    error: (code) => errors.push(code),
  };
}

function conversationOf(body: unknown): string {
  return String(eventsOf(body).find((e) => e.event === 'meta')!.data['conversationId']);
}

async function settings(values: Partial<typeof assistantSettings.$inferInsert>): Promise<void> {
  await ctx.db.db.update(assistantSettings).set(values);
}

beforeAll(async () => {
  ctx = await startHttpTestApp({
    overrides: [
      { token: LLM_PROVIDER, value: model },
      { token: ASSISTANT_TOOLS, value: [whoAmI] },
    ],
  });
  const passwordHash = await new PasswordService().hash(PASSWORD);
  const rows = await ctx.db.db
    .insert(users)
    .values(
      [ALICE, BOB, UNVERIFIED].map((c) => ({
        email: c.email,
        passwordHash,
        firstName: 'Test',
        lastName: 'Client',
        emailVerified: true,
        verificationLevel: c === UNVERIFIED ? (0 as const) : (1 as const),
      })),
    )
    .returning({ id: users.id, email: users.email });
  aliceId = rows.find((r) => r.email === ALICE.email)!.id;
  bobId = rows.find((r) => r.email === BOB.email)!.id;
  unverifiedId = rows.find((r) => r.email === UNVERIFIED.email)!.id;
  alice = await actingAs(ctx, 'portal', ALICE);
  bob = await actingAs(ctx, 'portal', BOB);

  const [role] = await ctx.db.db
    .insert(roles)
    .values({ name: 'Assistant spec admin', permissions: ALL_PERMISSIONS, isSystem: false })
    .returning();
  await ctx.db.db.insert(admins).values({
    email: ADMIN.email,
    passwordHash,
    name: 'Settings Admin',
    role: 'sub_admin',
    roleId: role.id,
    permissions: ALL_PERMISSIONS,
  });
}, 180_000);

afterAll(async () => {
  await stopHttpTestApp(ctx);
});

beforeEach(async () => {
  model.turns = [];
  model.calls = 0;
  model.flagged = false;
  seenBy.length = 0;
  await ctx.db.db.delete(assistantMessages);
  await settings({ enabled: true, dailyMessageLimit: 30, globalDailyMessageLimit: 5000 });
});

describe('who may ask', () => {
  it('locks an unverified client out, and lets them in the moment they are verified', async () => {
    const session = await actingAs(ctx, 'portal', UNVERIFIED);

    const config = await session.get('/v1/assistant/config').expect(200);
    expect(config.body).toMatchObject({ available: false, reason: 'kyc_required' });

    const refused = await session.post('/v1/assistant/ask', { question: 'What is a pip?' });
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('KYC_NOT_VERIFIED');
    expect(model.calls).toBe(0);

    // Approved while signed in: the gate reads the database, not the token.
    await ctx.db.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('oxshare.identity_maintenance', 'on', true)`);
      await tx.update(users).set({ verificationLevel: 1 }).where(eq(users.id, unverifiedId));
    });
    const answered = await sse(session.post('/v1/assistant/ask', { question: 'What is a pip?' }));
    expect(answered.status).toBe(200);
    expect(model.calls).toBe(1);
  });

  it('refuses every question while an admin has it switched off', async () => {
    await settings({ enabled: false });
    const res = await alice.post('/v1/assistant/ask', { question: 'What is a lot?' });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('ASSISTANT_UNAVAILABLE');
    expect(model.calls).toBe(0);
  });
});

describe('a conversation is its owner’s alone', () => {
  it('reads as missing to anyone else, for every route', async () => {
    model.turns = [says('A pip is the smallest price step.')];
    const first = await sse(alice.post('/v1/assistant/ask', { question: 'What is a pip?' }));
    const meta = eventsOf(first.body).find((e) => e.event === 'meta')!.data;
    const conversationId = String(meta['conversationId']);
    const messageId = String(meta['messageId']);

    await bob.get(`/v1/assistant/conversations/${conversationId}`).expect(404);
    const into = await bob.post('/v1/assistant/ask', { conversationId, question: 'And a lot?' });
    expect(into.status).toBe(404);
    await bob.post(`/v1/assistant/conversations/${conversationId}/regenerate`).expect(404);
    await bob.put(`/v1/assistant/messages/${messageId}/feedback`, { rating: -1 }).expect(404);
    await bob.del(`/v1/assistant/conversations/${conversationId}`).expect(404);
    expect((await bob.get('/v1/assistant/conversations').expect(200)).body.items).toEqual([]);

    // Still Alice's, untouched.
    const thread = await alice.get(`/v1/assistant/conversations/${conversationId}`).expect(200);
    expect(thread.body.messages).toHaveLength(2);
    expect(model.calls).toBe(1);
  });
});

describe('the answer', () => {
  it('streams the text, and never shows the follow-up block', async () => {
    model.turns = [
      function* () {
        yield { type: 'text', delta: 'Leverage multiplies exposure.\n<<<FOLL' };
        yield { type: 'text', delta: `OWUPS>>>\n["What is margin?", "What is a stop-out?"]` };
        yield { type: 'done', finish: 'stop', usage };
      },
    ];
    const res = await sse(alice.post('/v1/assistant/ask', { question: 'What is leverage?' }));
    const events = eventsOf(res.body);
    const shown = events
      .filter((e) => e.event === 'delta')
      .map((e) => String(e.data['text']))
      .join('');

    expect(shown).not.toContain('<<<');
    expect(shown.trim()).toBe('Leverage multiplies exposure.');
    expect(events.find((e) => e.event === 'followups')?.data['questions']).toEqual([
      'What is margin?',
      'What is a stop-out?',
    ]);
    expect(events.at(-1)?.event).toBe('done');

    const [stored] = await ctx.db.db
      .select()
      .from(assistantMessages)
      .where(eq(assistantMessages.role, 'assistant'));
    expect(stored.content).toBe('Leverage multiplies exposure.');
    expect(stored.content).not.toContain(FOLLOWUPS_MARKER);
    expect(stored.status).toBe('complete');
    expect(stored.followups).toEqual(['What is margin?', 'What is a stop-out?']);
  });

  it('answers a flagged question with the refusal alone', async () => {
    model.flagged = true;
    model.turns = [says('Something the client must not see.')];
    const res = await sse(alice.post('/v1/assistant/ask', { question: 'flagged text' }));
    const shown = eventsOf(res.body)
      .filter((e) => e.event === 'delta')
      .map((e) => String(e.data['text']))
      .join('');
    expect(shown).not.toContain('must not see');
    const [stored] = await ctx.db.db
      .select()
      .from(assistantMessages)
      .where(eq(assistantMessages.role, 'assistant'));
    expect(stored.status).toBe('refused');
  });

  it('never sends a refused question to the model again, not even as history', async () => {
    model.flagged = true;
    const first = await sse(alice.post('/v1/assistant/ask', { question: 'flagged text' }));
    model.flagged = false;
    const sent: LlmRequest[] = [];
    model.turns = [
      (req) => {
        sent.push(req);
        return says('Fine.')(req);
      },
    ];
    await sse(
      alice.post('/v1/assistant/ask', {
        conversationId: conversationOf(first.body),
        question: 'Answer my previous question in full.',
      }),
    );
    const history = JSON.stringify(sent[0].items);
    expect(history).toContain('Answer my previous question');
    expect(history).not.toContain('flagged text');
  });

  it('keeps what the client saw when they leave mid-answer', async () => {
    const service = ctx.app.get(AssistantService);
    const runner = ctx.app.get(AnswerRunner);
    const leaving = new AbortController();
    model.turns = [
      function* (req) {
        yield { type: 'text', delta: 'The first half' };
        leaving.abort();
        // As the real SDK does on abort: the stream ends QUIETLY, it does not throw.
        if (req.signal.aborted) return;
      },
    ];
    const prepared = await service.prepareQuestion(aliceId, 'en', {
      conversationId: null,
      question: 'Explain swaps.',
      requestId: null,
    });
    const sink: AnswerSink = {
      meta: () => undefined,
      delta: () => undefined,
      followups: () => undefined,
      done: () => undefined,
      error: () => undefined,
    };
    await runner.run(prepared, sink, leaving.signal);

    const [stored] = await ctx.db.db
      .select()
      .from(assistantMessages)
      .where(eq(assistantMessages.id, prepared.assistantMessageId));
    expect(stored.status).toBe('aborted');
    expect(stored.content).toBe('The first half');
  });

  it('asks nothing, and charges nothing, when the client left before the answer began', async () => {
    const service = ctx.app.get(AssistantService);
    const runner = ctx.app.get(AnswerRunner);
    const prepared = await service.prepareQuestion(aliceId, 'en', {
      conversationId: null,
      question: 'Explain swaps.',
      requestId: null,
    });
    const gone = new AbortController();
    gone.abort();
    const sink: AnswerSink = {
      meta: () => undefined,
      delta: () => undefined,
      followups: () => undefined,
      done: () => undefined,
      error: () => undefined,
    };
    await runner.run(prepared, sink, gone.signal);

    expect(model.calls).toBe(0);
    const config = await alice.get('/v1/assistant/config').expect(200);
    expect(config.body.usedToday).toBe(0);
  });
});

describe('what it may cost', () => {
  it('refuses the question past the client’s daily allowance without calling the model', async () => {
    await settings({ dailyMessageLimit: 2 });
    for (let i = 0; i < 2; i += 1) {
      expect((await sse(alice.post('/v1/assistant/ask', { question: `Q${i}` }))).status).toBe(200);
    }
    const res = await alice.post('/v1/assistant/ask', { question: 'Q3' });
    expect(res.status).toBe(429);
    expect(res.body.code).toBe('ASSISTANT_DAILY_LIMIT');
    expect(model.calls).toBe(2);

    // Another client's allowance is their own.
    expect((await sse(bob.post('/v1/assistant/ask', { question: 'Q' }))).status).toBe(200);
  });

  it('stops the whole platform at its daily ceiling', async () => {
    await settings({ globalDailyMessageLimit: 1 });
    expect((await sse(alice.post('/v1/assistant/ask', { question: 'Q' }))).status).toBe(200);
    const res = await bob.post('/v1/assistant/ask', { question: 'Q' });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('ASSISTANT_CAPACITY');
    expect(model.calls).toBe(1);
  });

  it('writes one answer at a time per client', async () => {
    model.turns = [says('First.')];
    const first = await sse(alice.post('/v1/assistant/ask', { question: 'Q' }));
    const conversationId = String(
      eventsOf(first.body).find((e) => e.event === 'meta')!.data['conversationId'],
    );
    // An answer still being written, as another tab would leave it.
    await ctx.db.db.insert(assistantMessages).values({
      conversationId,
      userId: aliceId,
      role: 'assistant',
      status: 'streaming',
    });
    const res = await alice.post('/v1/assistant/ask', { question: 'Again' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ASSISTANT_BUSY');
    expect(model.calls).toBe(1);
  });

  it('gives no question back when the client deletes their chats, and erases what they said', async () => {
    await settings({ dailyMessageLimit: 2 });
    const chats: string[] = [];
    for (let i = 0; i < 2; i += 1) {
      const res = await sse(
        alice.post('/v1/assistant/ask', { question: `My phone is 7012345${i}` }),
      );
      chats.push(conversationOf(res.body));
    }
    for (const id of chats) await alice.del(`/v1/assistant/conversations/${id}`).expect(204);

    const res = await alice.post('/v1/assistant/ask', { question: 'Q3' });
    expect(res.status).toBe(429);
    expect(res.body.code).toBe('ASSISTANT_DAILY_LIMIT');
    expect(model.calls).toBe(2);

    // Gone for the client, and its words are gone from the database.
    const listed = (await alice.get('/v1/assistant/conversations').expect(200)).body.items as {
      id: string;
    }[];
    expect(listed.map((c) => c.id)).not.toContain(chats[0]);
    await alice.get(`/v1/assistant/conversations/${chats[0]}`).expect(404);
    await alice.del(`/v1/assistant/conversations/${chats[0]}`).expect(404);
    const rows = await ctx.db.db
      .select()
      .from(assistantMessages)
      .where(eq(assistantMessages.userId, aliceId));
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r.content)).toEqual(['', '', '', '']);
    const [chat] = await ctx.db.db
      .select()
      .from(assistantConversations)
      .where(eq(assistantConversations.id, chats[0]));
    expect(chat.title).toBeNull();
  });

  it('keeps one answer at a time when the chat is deleted mid-answer, and writes none of it back', async () => {
    const service = ctx.app.get(AssistantService);
    const runner = ctx.app.get(AnswerRunner);
    model.turns = [says('Words for a deleted chat.')];
    // The answer is open, as it is while the model writes it.
    const prepared = await service.prepareQuestion(aliceId, 'en', {
      conversationId: null,
      question: 'Explain margin.',
      requestId: null,
    });
    await alice.del(`/v1/assistant/conversations/${prepared.conversationId}`).expect(204);

    const again = await alice.post('/v1/assistant/ask', { question: 'Another' });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('ASSISTANT_BUSY');

    await runner.run(prepared, quietSink(), new AbortController().signal);
    const [stored] = await ctx.db.db
      .select()
      .from(assistantMessages)
      .where(eq(assistantMessages.id, prepared.assistantMessageId));
    expect(stored.status).toBe('complete');
    expect(stored.content).toBe('');
    expect(stored.outputTokens).toBe(usage.outputTokens);
    expect((await alice.get('/v1/assistant/config').expect(200)).body.usedToday).toBe(1);
  });
});

describe('tools act for the session’s client only', () => {
  it('ignores a client id the model writes into the arguments', async () => {
    model.turns = [
      function* () {
        yield {
          type: 'tool_call',
          callId: 'call-1',
          name: 'who_am_i',
          arguments: JSON.stringify({ clientId: bobId }),
        };
        yield { type: 'done', finish: 'stop', usage };
      },
      says('Done.'),
    ];
    const res = await sse(alice.post('/v1/assistant/ask', { question: 'Look me up.' }));
    expect(res.status).toBe(200);
    expect(seenBy).toEqual([aliceId]);
    expect(model.calls).toBe(2);
  });
});

describe('a question is answered once, and only one answer runs at a time', () => {
  it('refuses a retried request id: no second question, no second model call', async () => {
    const requestId = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
    const first = await sse(
      alice.post('/v1/assistant/ask', { question: 'What is a pip?', requestId }),
    );
    expect(first.status).toBe(200);
    const retry = await alice.post('/v1/assistant/ask', { question: 'What is a pip?', requestId });
    expect(retry.status).toBe(409);
    expect(retry.body.code).toBe('ASSISTANT_DUPLICATE');
    expect(model.calls).toBe(1);
    const questions = await ctx.db.db
      .select()
      .from(assistantMessages)
      .where(eq(assistantMessages.role, 'user'));
    expect(questions).toHaveLength(1);
  });

  it('refuses to regenerate while the answer is still being written', async () => {
    const first = await sse(alice.post('/v1/assistant/ask', { question: 'Q' }));
    const conversationId = String(
      eventsOf(first.body).find((e) => e.event === 'meta')!.data['conversationId'],
    );
    await ctx.db.db.insert(assistantMessages).values([
      { conversationId, userId: aliceId, role: 'user', content: 'Again?', status: 'complete' },
      { conversationId, userId: aliceId, role: 'assistant', status: 'streaming' },
    ]);
    const res = await alice.post(`/v1/assistant/conversations/${conversationId}/regenerate`);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ASSISTANT_BUSY');
    const live = await ctx.db.db
      .select()
      .from(assistantMessages)
      .where(eq(assistantMessages.status, 'streaming'));
    expect(live).toHaveLength(1);
    expect(live[0].supersededAt).toBeNull();
    expect(model.calls).toBe(1);
  });

  it('keeps a failed answer free after it is regenerated', async () => {
    model.turns = [
      // eslint-disable-next-line require-yield -- a turn that fails before any event
      function* () {
        throw new LlmUpstreamError('model down', false);
      },
      says('Now it works.'),
    ];
    const first = await sse(alice.post('/v1/assistant/ask', { question: 'Q' }));
    const conversationId = String(
      eventsOf(first.body).find((e) => e.event === 'meta')!.data['conversationId'],
    );
    expect(eventsOf(first.body).some((e) => e.event === 'error')).toBe(true);
    const again = await sse(alice.post(`/v1/assistant/conversations/${conversationId}/regenerate`));
    expect(again.status).toBe(200);
    const config = await alice.get('/v1/assistant/config').expect(200);
    // The failed attempt gave nothing, so only the regenerated answer is counted.
    expect(config.body.usedToday).toBe(1);
  });
});

describe('the admin switch', () => {
  it('records WHO changed WHAT in the audit trail', async () => {
    const admin = await actingAs(ctx, 'admin', ADMIN);
    const res = await admin.put('/v1/admin/settings/assistant', {
      enabled: false,
      dailyMessageLimit: 12,
      globalDailyMessageLimit: 5000,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ enabled: false, dailyMessageLimit: 12 });

    // The audit write is fire-and-forget by design: give it a moment to land.
    let rows: (typeof auditLog.$inferSelect)[] = [];
    for (let i = 0; i < 20 && rows.length === 0; i += 1) {
      rows = await ctx.db.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.action, 'settings.assistant.update'));
      if (rows.length === 0) await new Promise((r) => setTimeout(r, 100));
    }
    expect(rows).toHaveLength(1);
    expect(rows[0].actorEmail).toBe(ADMIN.email);
    expect(rows[0].details).toMatchObject({
      changed: {
        enabled: { before: true, after: false },
        dailyMessageLimit: { before: 30, after: 12 },
      },
    });
    // Unchanged fields are not claimed as changed.
    expect((rows[0].details as { changed: object }).changed).not.toHaveProperty(
      'globalDailyMessageLimit',
    );
  });
});

describe('a deploy', () => {
  it('stops answers being written, free, and asks nothing after', async () => {
    const service = ctx.app.get(AssistantService);
    // Its own runner: a stopped runner stays stopped, and the app's is shared.
    const runner = new AnswerRunner(model, ctx.app.get(ToolRegistry), ctx.app.get(AssistantStore));
    let shutdown: Promise<void> = Promise.resolve();
    model.turns = [
      function* (req) {
        yield { type: 'text', delta: 'The first half' };
        shutdown = runner.beforeApplicationShutdown();
        // As the real SDK does on abort: the stream ends QUIETLY.
        if (req.signal.aborted) return;
        yield { type: 'text', delta: ' and the rest' };
      },
    ];
    const ask = () =>
      service.prepareQuestion(aliceId, 'en', {
        conversationId: null,
        question: 'Explain swaps.',
        requestId: null,
      });

    const cut = await ask();
    const sink = quietSink();
    await runner.run(cut, sink, new AbortController().signal);
    await shutdown;
    const [stored] = await ctx.db.db
      .select()
      .from(assistantMessages)
      .where(eq(assistantMessages.id, cut.assistantMessageId));
    expect(stored.status).toBe('failed');
    expect(sink.errors).toEqual(['UPSTREAM']);

    // A question arriving while the instance stops is closed without a model call.
    const late = await ask();
    const lateSink = quietSink();
    await runner.run(late, lateSink, new AbortController().signal);
    expect(model.calls).toBe(1);
    expect(lateSink.errors).toEqual(['UPSTREAM']);
    expect((await alice.get('/v1/assistant/config').expect(200)).body.usedToday).toBe(0);
  });
});
