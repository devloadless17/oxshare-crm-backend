import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gte, isNull, lt, notInArray, or, sql } from 'drizzle-orm';
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
import { isUniqueViolation, violatesConstraint } from '../common/errors/pg-violation';

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

/**
 * A deleted chat's rows are kept this long after the delete, then removed. Past
 * it no allowance window (a minute, a UTC day) can still see them, and nothing
 * can be added to a deleted chat.
 */
const DELETED_KEEP_MS = 2 * 86_400_000;

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
   * a counter, over rows the client cannot remove: deleting a chat erases its
   * words and keeps its rows (0188). Only a CHARGED answer counts.
   */
  async answersSince(userId: number, since: Date): Promise<number> {
    const [row] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(assistantMessages)
      .where(
        and(
          eq(assistantMessages.userId, userId),
          eq(assistantMessages.role, 'assistant'),
          charged(),
          gte(assistantMessages.createdAt, since),
        ),
      );
    return row?.n ?? 0;
  }

  /**
   * Charged answers the platform gave since `since`: the platform-wide ceiling.
   * Same rule as the client's allowance, so free attempts (a client who hung up
   * before the answer began, a model outage) can never use the ceiling up and
   * shut every client out for the day. `usageSince` still counts every attempt.
   */
  async platformAnswersSince(since: Date): Promise<number> {
    const [row] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(assistantMessages)
      .where(
        and(
          eq(assistantMessages.role, 'assistant'),
          charged(),
          gte(assistantMessages.createdAt, since),
        ),
      );
    return row?.n ?? 0;
  }

  /** Every answer the platform gave since `since`, with what they cost in tokens (the admin card). */
  async usageSince(since: Date): Promise<AssistantUsage> {
    const [row] = await this.db
      .select({
        answers: sql<number>`count(*)::int`,
        // bigint: a busy day's input tokens pass 2^31, and `::int` would 500 the admin screen.
        inputTokens:
          sql<number>`coalesce(sum(${assistantMessages.inputTokens}), 0)::bigint`.mapWith(Number),
        cachedTokens:
          sql<number>`coalesce(sum(${assistantMessages.cachedTokens}), 0)::bigint`.mapWith(Number),
        outputTokens:
          sql<number>`coalesce(sum(${assistantMessages.outputTokens}), 0)::bigint`.mapWith(Number),
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
      .where(
        and(eq(assistantConversations.userId, userId), isNull(assistantConversations.deletedAt)),
      )
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
          isNull(assistantConversations.deletedAt),
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

  /**
   * A client deleting a chat: what was SAID is gone at once, and the chat reads as
   * missing everywhere. What was USED stays (the rows, their status, their tokens)
   * because every allowance counts them; a hard delete let a client reset their
   * limits by deleting chats, and freed the one-answer index mid-answer (0188).
   * Retention removes the rows two days later. Returns false when not theirs.
   *
   * Lock order: the conversation, then its messages, as `finishAnswer` takes them.
   */
  async deleteConversation(userId: number, conversationId: string): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const [deleted] = await tx
        .update(assistantConversations)
        .set({ deletedAt: new Date(), title: null })
        .where(
          and(
            eq(assistantConversations.id, conversationId),
            eq(assistantConversations.userId, userId),
            isNull(assistantConversations.deletedAt),
          ),
        )
        .returning({ id: assistantConversations.id });
      if (!deleted) return false;
      await tx
        .update(assistantMessages)
        .set({ content: '', followups: null, feedbackReason: null })
        .where(eq(assistantMessages.conversationId, conversationId));
      return true;
    });
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
        let conversationId = input.conversationId;
        let created = false;
        if (conversationId) {
          // The conversation is locked FIRST, as everywhere (see `deleteConversation`).
          const [owned] = await tx
            .update(assistantConversations)
            .set({ lastMessageAt: new Date() })
            .where(
              and(
                eq(assistantConversations.id, conversationId),
                eq(assistantConversations.userId, input.userId),
                isNull(assistantConversations.deletedAt),
              ),
            )
            .returning({ id: assistantConversations.id });
          if (!owned) throw new NotFoundError('Conversation not found.');
          await this.retireStaleStreams(tx, input.userId);
        } else {
          await this.retireStaleStreams(tx, input.userId);
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
   * Everything is checked INSIDE the transaction, and a refusal rolls it back:
   * the chat must be theirs and not deleted, there must be an answer to replace,
   * it must not still be streaming (that would run two model calls at once and
   * lose the first one's record), and a question must come before it. Same
   * one-in-flight guarantee as `beginExchange`.
   */
  async beginRegenerate(userId: number, conversationId: string): Promise<AssistantRegeneration> {
    try {
      return await this.db.transaction(async (tx) => {
        // Owned and not deleted, and locked FIRST, as everywhere (see `deleteConversation`).
        const now = new Date();
        const [owned] = await tx
          .update(assistantConversations)
          .set({ lastMessageAt: now })
          .where(
            and(
              eq(assistantConversations.id, conversationId),
              eq(assistantConversations.userId, userId),
              isNull(assistantConversations.deletedAt),
            ),
          )
          .returning({ id: assistantConversations.id });
        if (!owned) throw new NotFoundError('Conversation not found.');
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

        await tx
          .update(assistantMessages)
          .set({ supersededAt: now })
          .where(eq(assistantMessages.id, last.id));
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

  /**
   * Closes an answer, whatever happened to it. Only a `streaming` row is closed, once.
   *
   * The chat may have been deleted while the answer was being written. Its row
   * is closed all the same (it is usage), but its words are not written back.
   * The conversation is read `FOR SHARE` first, in the order the delete takes
   * its locks, so whichever runs second sees the other's result.
   */
  async finishAnswer(messageId: string, outcome: AssistantAnswerOutcome): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [chat] = await tx
        .select({ deletedAt: assistantConversations.deletedAt })
        .from(assistantConversations)
        .innerJoin(
          assistantMessages,
          eq(assistantMessages.conversationId, assistantConversations.id),
        )
        .where(eq(assistantMessages.id, messageId))
        .for('share', { of: assistantConversations });
      const erased = Boolean(chat?.deletedAt);
      await tx
        .update(assistantMessages)
        .set({
          ...outcome,
          ...(erased ? { content: '', followups: null } : {}),
          completedAt: new Date(),
        })
        .where(and(eq(assistantMessages.id, messageId), eq(assistantMessages.status, 'streaming')));
    });
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

  /**
   * Retention: conversations idle longer than `days`, and chats the client
   * deleted over two days ago, are removed with their messages.
   */
  async pruneIdleConversations(days: number): Promise<number> {
    const cutoff = new Date(Date.now() - days * 86_400_000);
    const rows = await this.db
      .delete(assistantConversations)
      .where(
        or(
          lt(assistantConversations.lastMessageAt, cutoff),
          lt(assistantConversations.deletedAt, new Date(Date.now() - DELETED_KEEP_MS)),
        ),
      )
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

/**
 * An answer the client is charged for. A FAILED one gave them nothing (the model
 * was down, they left before it began, a deploy cut it), and an INTERRUPTED one
 * is an instance that died: neither is their doing, so neither uses a question.
 */
function charged() {
  return notInArray(assistantMessages.status, ['failed', 'interrupted']);
}

/** The domain refusal a failed exchange transaction stands for, or the error itself. */
function refusalFor(error: unknown): unknown {
  if (!isUniqueViolation(error)) return error;
  if (violatesConstraint(error, 'assistant_messages_request_uq')) {
    return new AssistantDuplicateError('This question was already received.');
  }
  return new AssistantBusyError('An answer is already being written. Wait for it to finish.');
}
