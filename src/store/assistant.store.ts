import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gte, isNull, lt, ne, sql } from 'drizzle-orm';
import { DRIZZLE_DB } from '../database/database.module';
import type { Db } from '../database/db';
import {
  assistantConversations,
  assistantMessages,
  assistantSettings,
  type AssistantMessageRole,
  type AssistantMessageStatus,
} from '../database/schema';
import {
  AssistantBusyError,
  AssistantDuplicateError,
  NotFoundError,
} from '../common/errors/domain-errors';
import { isUniqueViolation } from '../common/errors/pg-violation';

/**
 * The portal assistant's conversations, messages and settings (0187).
 *
 * Every client-facing read takes the client's id and filters on it. A
 * conversation that is somebody else's is indistinguishable from one that does
 * not exist, so the store never needs a separate ownership check that a caller
 * could forget.
 */

export interface AssistantSettingsRow {
  enabled: boolean;
  dailyMessageLimit: number;
  globalDailyMessageLimit: number;
  updatedBy: string | null;
  updatedAt: Date | null;
}

export interface AssistantSettingsWrite {
  enabled: boolean;
  dailyMessageLimit: number;
  globalDailyMessageLimit: number;
}

export interface AssistantConversationRow {
  id: string;
  title: string | null;
  createdAt: Date;
  lastMessageAt: Date;
}

export interface AssistantMessageRow {
  id: string;
  role: AssistantMessageRole;
  content: string;
  status: AssistantMessageStatus;
  followups: string[] | null;
  feedback: number | null;
  createdAt: Date;
}

/** What a finished (or failed) answer records. */
export interface AssistantAnswerOutcome {
  content: string;
  status: Exclude<AssistantMessageStatus, 'streaming'>;
  followups?: string[] | null;
  model?: string | null;
  inputTokens?: number | null;
  cachedTokens?: number | null;
  outputTokens?: number | null;
  ttftMs?: number | null;
  latencyMs?: number | null;
}

export interface AssistantExchange {
  conversationId: string;
  assistantMessageId: string;
  /** True when this exchange started the conversation. */
  created: boolean;
}

/** A regenerate also hands back the question being answered again, and the answer it replaced. */
export interface AssistantRegeneration extends AssistantExchange {
  question: string;
  replacedId: string;
}

export interface AssistantUsage {
  answers: number;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
}

/**
 * How long a `streaming` row may sit before it is taken to be a dead instance's.
 * Well past the longest an answer can run (the service's deadline is 90 s), so
 * a live stream is never declared dead under it.
 */
const STALE_STREAM_MS = 3 * 60_000;

const DEFAULT_SETTINGS: AssistantSettingsRow = {
  enabled: false,
  dailyMessageLimit: 30,
  globalDailyMessageLimit: 5000,
  updatedBy: null,
  updatedAt: null,
};

@Injectable()
export class AssistantStore {
  constructor(@Inject(DRIZZLE_DB) private readonly db: Db) {}

  /* ── Settings ──────────────────────────────────────────────────────────── */

  /** The row, or the migration's defaults when none exists (off). */
  async getSettings(): Promise<AssistantSettingsRow> {
    const [row] = await this.db.select().from(assistantSettings).limit(1);
    return row ?? DEFAULT_SETTINGS;
  }

  async setSettings(
    values: AssistantSettingsWrite,
    updatedBy: string,
  ): Promise<AssistantSettingsRow> {
    const write = { ...values, updatedBy, updatedAt: new Date() };
    const [row] = await this.db
      .insert(assistantSettings)
      .values({ id: true, ...write })
      .onConflictDoUpdate({ target: assistantSettings.id, set: write })
      .returning();
    return row;
  }

  /* ── Usage ─────────────────────────────────────────────────────────────── */

  /**
   * Answers this client was given since `since`. The allowance is a COUNT, never
   * a counter. An answer that FAILED (the model was down, the key refused) gave
   * the client nothing, so it does not use up a question; the platform-wide
   * `usageSince` still counts every attempt.
   */
  async answersSince(userId: number, since: Date): Promise<number> {
    const [row] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(assistantMessages)
      .where(
        and(
          eq(assistantMessages.userId, userId),
          eq(assistantMessages.role, 'assistant'),
          ne(assistantMessages.status, 'failed'),
          gte(assistantMessages.createdAt, since),
        ),
      );
    return row?.n ?? 0;
  }

  /** Every answer the platform gave since `since`: the platform-wide ceiling. A count, nothing else. */
  async platformAnswersSince(since: Date): Promise<number> {
    const [row] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(assistantMessages)
      .where(and(eq(assistantMessages.role, 'assistant'), gte(assistantMessages.createdAt, since)));
    return row?.n ?? 0;
  }

  /** Every answer the platform gave since `since`, with what they cost in tokens (the admin card). */
  async usageSince(since: Date): Promise<AssistantUsage> {
    const [row] = await this.db
      .select({
        answers: sql<number>`count(*)::int`,
        inputTokens: sql<number>`coalesce(sum(${assistantMessages.inputTokens}), 0)::int`,
        cachedTokens: sql<number>`coalesce(sum(${assistantMessages.cachedTokens}), 0)::int`,
        outputTokens: sql<number>`coalesce(sum(${assistantMessages.outputTokens}), 0)::int`,
      })
      .from(assistantMessages)
      .where(and(eq(assistantMessages.role, 'assistant'), gte(assistantMessages.createdAt, since)));
    return row ?? { answers: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0 };
  }

  /* ── Conversations ─────────────────────────────────────────────────────── */

  async listConversations(userId: number, limit: number): Promise<AssistantConversationRow[]> {
    return this.db
      .select({
        id: assistantConversations.id,
        title: assistantConversations.title,
        createdAt: assistantConversations.createdAt,
        lastMessageAt: assistantConversations.lastMessageAt,
      })
      .from(assistantConversations)
      .where(eq(assistantConversations.userId, userId))
      .orderBy(desc(assistantConversations.lastMessageAt))
      .limit(limit);
  }

  async findConversation(
    userId: number,
    conversationId: string,
  ): Promise<AssistantConversationRow | null> {
    const [row] = await this.db
      .select({
        id: assistantConversations.id,
        title: assistantConversations.title,
        createdAt: assistantConversations.createdAt,
        lastMessageAt: assistantConversations.lastMessageAt,
      })
      .from(assistantConversations)
      .where(
        and(
          eq(assistantConversations.id, conversationId),
          eq(assistantConversations.userId, userId),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  /** The visible thread, oldest first. Regenerated (superseded) answers are history, not thread. */
  async messagesOf(userId: number, conversationId: string): Promise<AssistantMessageRow[]> {
    return this.db
      .select({
        id: assistantMessages.id,
        role: assistantMessages.role,
        content: assistantMessages.content,
        status: assistantMessages.status,
        followups: assistantMessages.followups,
        feedback: assistantMessages.feedback,
        createdAt: assistantMessages.createdAt,
      })
      .from(assistantMessages)
      .where(
        and(
          eq(assistantMessages.conversationId, conversationId),
          eq(assistantMessages.userId, userId),
          isNull(assistantMessages.supersededAt),
        ),
      )
      .orderBy(asc(assistantMessages.createdAt), asc(assistantMessages.role));
  }

  /** A client deleting a chat means it is gone — not archived. Returns false when not theirs. */
  async deleteConversation(userId: number, conversationId: string): Promise<boolean> {
    const rows = await this.db
      .delete(assistantConversations)
      .where(
        and(
          eq(assistantConversations.id, conversationId),
          eq(assistantConversations.userId, userId),
        ),
      )
      .returning({ id: assistantConversations.id });
    return rows.length > 0;
  }

  /* ── Exchanges ─────────────────────────────────────────────────────────── */

  /**
   * Records the question and opens the answer, in one transaction.
   *
   * Two partial unique indexes decide what may not happen twice:
   * - `assistant_messages_request_uq`: the same question (the portal's request
   *   id, reused by its retries) is recorded ONCE. A retry after the response was
   *   lost on the way back is refused as a duplicate, never asked again.
   * - `assistant_messages_one_streaming_uq`: one answer in flight per client. A
   *   concurrent second send fails HERE, before any model is called (409).
   *
   * A row left `streaming` by an instance that died is retired first, so a crash
   * cannot lock a client out for ever.
   */
  async beginExchange(input: {
    userId: number;
    conversationId: string | null;
    title: string;
    question: string;
    requestId: string | null;
  }): Promise<AssistantExchange> {
    try {
      return await this.db.transaction(async (tx) => {
        await this.retireStaleStreams(tx, input.userId);

        let conversationId = input.conversationId;
        let created = false;
        if (conversationId) {
          const [owned] = await tx
            .update(assistantConversations)
            .set({ lastMessageAt: new Date() })
            .where(
              and(
                eq(assistantConversations.id, conversationId),
                eq(assistantConversations.userId, input.userId),
              ),
            )
            .returning({ id: assistantConversations.id });
          if (!owned) throw new NotFoundError('Conversation not found.');
        } else {
          const [row] = await tx
            .insert(assistantConversations)
            .values({ userId: input.userId, title: input.title })
            .returning({ id: assistantConversations.id });
          conversationId = row.id;
          created = true;
        }

        const now = Date.now();
        await tx.insert(assistantMessages).values({
          conversationId,
          userId: input.userId,
          role: 'user',
          content: input.question,
          status: 'complete',
          requestId: input.requestId,
          createdAt: new Date(now),
          completedAt: new Date(now),
        });
        // One millisecond later, so the thread orders question before answer.
        const [answer] = await tx
          .insert(assistantMessages)
          .values({
            conversationId,
            userId: input.userId,
            role: 'assistant',
            status: 'streaming',
            createdAt: new Date(now + 1),
          })
          .returning({ id: assistantMessages.id });

        return { conversationId, assistantMessageId: answer.id, created };
      });
    } catch (error) {
      throw refusalFor(error);
    }
  }

  /**
   * Opens a fresh answer to the conversation's last question, and marks the
   * previous answer superseded (its outcome kept, so a failed answer stays free).
   *
   * Everything is checked INSIDE the transaction, before any write: there must
   * be an answer to replace, it must not still be streaming (that would run two
   * model calls at once and lose the first one's record), and a question must
   * come before it. Same one-in-flight guarantee as `beginExchange`.
   */
  async beginRegenerate(userId: number, conversationId: string): Promise<AssistantRegeneration> {
    try {
      return await this.db.transaction(async (tx) => {
        await this.retireStaleStreams(tx, userId);

        const [last, previous] = await tx
          .select({
            id: assistantMessages.id,
            role: assistantMessages.role,
            status: assistantMessages.status,
            content: assistantMessages.content,
          })
          .from(assistantMessages)
          .where(
            and(
              eq(assistantMessages.conversationId, conversationId),
              eq(assistantMessages.userId, userId),
              isNull(assistantMessages.supersededAt),
            ),
          )
          .orderBy(desc(assistantMessages.createdAt))
          .limit(2);
        if (!last || last.role !== 'assistant' || previous?.role !== 'user') {
          throw new NotFoundError('There is no answer to regenerate.');
        }
        if (last.status === 'streaming') {
          throw new AssistantBusyError(
            'An answer is already being written. Wait for it to finish.',
          );
        }

        const now = new Date();
        await tx
          .update(assistantMessages)
          .set({ supersededAt: now })
          .where(eq(assistantMessages.id, last.id));
        await tx
          .update(assistantConversations)
          .set({ lastMessageAt: now })
          .where(eq(assistantConversations.id, conversationId));
        // Stamped from the same clock as every other message, so the thread order holds.
        const [answer] = await tx
          .insert(assistantMessages)
          .values({
            conversationId,
            userId,
            role: 'assistant',
            status: 'streaming',
            createdAt: now,
          })
          .returning({ id: assistantMessages.id });

        return {
          conversationId,
          assistantMessageId: answer.id,
          created: false,
          question: previous.content,
          replacedId: last.id,
        };
      });
    } catch (error) {
      throw refusalFor(error);
    }
  }

  /** Closes an answer, whatever happened to it. Only a `streaming` row is closed, once. */
  async finishAnswer(messageId: string, outcome: AssistantAnswerOutcome): Promise<void> {
    await this.db
      .update(assistantMessages)
      .set({ ...outcome, completedAt: new Date() })
      .where(and(eq(assistantMessages.id, messageId), eq(assistantMessages.status, 'streaming')));
  }

  /** Returns false when the message is not this client's answer. */
  async setFeedback(
    userId: number,
    messageId: string,
    rating: 1 | -1 | null,
    reason: string | null,
  ): Promise<boolean> {
    const rows = await this.db
      .update(assistantMessages)
      .set({
        feedback: rating,
        feedbackReason: rating === -1 ? reason : null,
        feedbackAt: rating === null ? null : new Date(),
      })
      .where(
        and(
          eq(assistantMessages.id, messageId),
          eq(assistantMessages.userId, userId),
          eq(assistantMessages.role, 'assistant'),
        ),
      )
      .returning({ id: assistantMessages.id });
    return rows.length > 0;
  }

  /** Retention: conversations idle longer than `days` are deleted with their messages. */
  async pruneIdleConversations(days: number): Promise<number> {
    const cutoff = new Date(Date.now() - days * 86_400_000);
    const rows = await this.db
      .delete(assistantConversations)
      .where(lt(assistantConversations.lastMessageAt, cutoff))
      .returning({ id: assistantConversations.id });
    return rows.length;
  }

  private async retireStaleStreams(
    tx: Parameters<Parameters<Db['transaction']>[0]>[0],
    userId: number,
  ): Promise<void> {
    await tx
      .update(assistantMessages)
      .set({ status: 'interrupted', completedAt: new Date() })
      .where(
        and(
          eq(assistantMessages.userId, userId),
          eq(assistantMessages.status, 'streaming'),
          lt(assistantMessages.createdAt, new Date(Date.now() - STALE_STREAM_MS)),
        ),
      );
  }
}

/** Which partial unique index a violation hit, from the driver error under Drizzle's wrapper. */
function violatedConstraint(error: unknown): string | undefined {
  for (let current: unknown = error, depth = 0; current && depth < 5; depth += 1) {
    const constraint = (current as { constraint?: unknown }).constraint;
    if (typeof constraint === 'string') return constraint;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/** The domain refusal a failed exchange transaction stands for, or the error itself. */
function refusalFor(error: unknown): unknown {
  if (!isUniqueViolation(error)) return error;
  if (violatedConstraint(error) === 'assistant_messages_request_uq') {
    return new AssistantDuplicateError('This question was already received.');
  }
  return new AssistantBusyError('An answer is already being written. Wait for it to finish.');
}
