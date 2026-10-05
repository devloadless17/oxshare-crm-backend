import { createHmac, hkdfSync } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AssistantCapacityError,
  AssistantConversationFullError,
  AssistantDailyLimitError,
  AssistantRateLimitError,
  AssistantUnavailableError,
  KycNotVerifiedError,
  NotFoundError,
  ValidationError,
} from '../../common/errors/domain-errors';
import type { Locale } from '../../common/i18n/locale';
import { JobLeaseService } from '../../common/scheduling/job-lease.service';
import { AdminAuditService } from '../admin/admin-audit.service';
import { ScheduledJob } from '../../common/scheduling/scheduled-job.decorator';
import {
  AssistantStore,
  type AssistantConversationRow,
  type AssistantExchange,
  type AssistantMessageRow,
  type AssistantSettingsRow,
  type AssistantSettingsWrite,
  type AssistantUsage,
} from '../../store/assistant.store';
import { UsersStore } from '../../store/users.store';
import { REQUIRED_VERIFICATION_LEVEL } from '../identity/guards/kyc-verified.guard';
import type { PreparedAnswer } from './answer-runner';
import { LLM_PROVIDER, type LlmItem, type LlmProvider } from './llm/llm-provider';

/** The longest question a client may send. */
export const MAX_QUESTION_LENGTH = 2_000;
/** Answers per client inside any rolling minute: a human asks slower than this. */
const PER_MINUTE_LIMIT = 6;
/** Turns of history sent with each question, and the characters they may span. */
const HISTORY_TURNS = 20;
const HISTORY_CHARS = 24_000;
/** A conversation this long is closed to new questions; the client starts a new chat. */
const MAX_THREAD_MESSAGES = 200;
/** Chats idle this long are deleted — clients type personal details into them. */
const RETENTION_DAYS = 180;

export type AssistantUnavailableReason = 'not_configured' | 'disabled' | 'kyc_required';

export interface AssistantConfigView {
  available: boolean;
  reason: AssistantUnavailableReason | null;
  dailyLimit: number;
  usedToday: number;
  /** When today's allowance renews (midnight UTC). */
  resetsAt: Date;
  maxQuestionLength: number;
}

export interface AdminAssistantSettingsView extends AssistantSettingsRow {
  keyConfigured: boolean;
  model: string;
  today: AssistantUsage;
}

/**
 * The portal assistant's rules: who may ask, how much, and what is sent.
 *
 * Every refusal is decided HERE, before a stream opens, so it reaches the
 * client as an ordinary HTTP error with a code. Authorisation lives in the
 * service (R-4.3), and the verification gate reads the DATABASE, as
 * `KycVerifiedGuard` does: a client rejected or asked to re-verify a minute
 * ago is refused now, not when their token expires.
 */
@Injectable()
export class AssistantService {
  private readonly logger = new Logger('Assistant');
  /** Derived for this one purpose, so the abuse id never shares a key with session signing. */
  private readonly identityKey: Buffer;

  constructor(
    private readonly store: AssistantStore,
    private readonly users: UsersStore,
    @Inject(LLM_PROVIDER) private readonly llm: LlmProvider,
    private readonly leases: JobLeaseService,
    private readonly audit: AdminAuditService,
    config: ConfigService,
  ) {
    this.identityKey = Buffer.from(
      hkdfSync(
        'sha256',
        config.getOrThrow<string>('JWT_ACCESS_SECRET'),
        'oxshare',
        'assistant-safety-identifier-v1',
        32,
      ),
    );
  }

  /* ── Reads ─────────────────────────────────────────────────────────────── */

  async config(clientId: number): Promise<AssistantConfigView> {
    const settings = await this.store.getSettings();
    const reason = !this.llm.isConfigured()
      ? 'not_configured'
      : !settings.enabled
        ? 'disabled'
        : !(await this.isVerified(clientId))
          ? 'kyc_required'
          : null;
    return {
      available: reason === null,
      reason,
      dailyLimit: settings.dailyMessageLimit,
      usedToday: await this.store.answersSince(clientId, startOfUtcDay()),
      resetsAt: nextUtcMidnight(),
      maxQuestionLength: MAX_QUESTION_LENGTH,
    };
  }

  async listConversations(clientId: number): Promise<AssistantConversationRow[]> {
    await this.assertCanUse(clientId);
    return this.store.listConversations(clientId, 50);
  }

  async conversation(
    clientId: number,
    conversationId: string,
  ): Promise<{ conversation: AssistantConversationRow; messages: AssistantMessageRow[] }> {
    await this.assertCanUse(clientId);
    const conversation = await this.store.findConversation(clientId, conversationId);
    if (!conversation) throw new NotFoundError('Conversation not found.');
    return { conversation, messages: await this.store.messagesOf(clientId, conversationId) };
  }

  /* ── Writes ────────────────────────────────────────────────────────────── */

  async deleteConversation(clientId: number, conversationId: string): Promise<void> {
    if (!(await this.store.deleteConversation(clientId, conversationId))) {
      throw new NotFoundError('Conversation not found.');
    }
  }

  async setFeedback(
    clientId: number,
    messageId: string,
    rating: 1 | -1 | null,
    reason: string | null,
  ): Promise<void> {
    if (!(await this.store.setFeedback(clientId, messageId, rating, reason))) {
      throw new NotFoundError('Message not found.');
    }
  }

  /** Every check, then the question recorded and the answer opened. */
  async prepareQuestion(
    clientId: number,
    locale: Locale,
    input: { conversationId: string | null; question: string; requestId: string | null },
  ): Promise<PreparedAnswer> {
    const question = input.question.trim();
    if (question.length === 0 || question.length > MAX_QUESTION_LENGTH) {
      throw new ValidationError('Write a question of up to 2000 characters.');
    }
    const remainingToday = await this.assertCanAsk(clientId);

    const history = input.conversationId
      ? historyItems(await this.threadOf(clientId, input.conversationId, 2))
      : [];
    const exchange = await this.store.beginExchange({
      userId: clientId,
      conversationId: input.conversationId,
      title: titleFrom(question),
      question,
      requestId: input.requestId,
    });
    return this.prepared(
      clientId,
      locale,
      exchange,
      [...history, { kind: 'message', role: 'user', text: question }],
      question,
      remainingToday,
    );
  }

  /** A fresh answer to the conversation's last question. Costs one answer, like asking. */
  async prepareRegenerate(
    clientId: number,
    locale: Locale,
    conversationId: string,
  ): Promise<PreparedAnswer> {
    const remainingToday = await this.assertCanAsk(clientId);
    const thread = await this.threadOf(clientId, conversationId, 0);
    // Every check on the thread happens inside this transaction, before any write.
    const regeneration = await this.store.beginRegenerate(clientId, conversationId);
    const items = historyItems(thread.filter((m) => m.id !== regeneration.replacedId));
    return this.prepared(
      clientId,
      locale,
      regeneration,
      items,
      regeneration.question,
      remainingToday,
    );
  }

  /* ── Admin ─────────────────────────────────────────────────────────────── */

  async adminSettings(): Promise<AdminAssistantSettingsView> {
    return {
      ...(await this.store.getSettings()),
      keyConfigured: this.llm.isConfigured(),
      model: this.llm.model,
      today: await this.store.usageSince(startOfUtcDay()),
    };
  }

  /**
   * Writes the switch and the limits, and the AUDIT ROW. `@Audited` on the
   * route only declares the stance for the coverage test; the row is this
   * method's job (as `SettingsService.setTrading` does). The route once
   * declared itself audited and recorded nothing, which no census can see.
   */
  async setAdminSettings(
    values: AssistantSettingsWrite,
    adminId: string,
  ): Promise<AdminAssistantSettingsView> {
    const before = await this.store.getSettings();
    await this.store.setSettings(values, adminId);
    const changed: Record<string, { before: unknown; after: unknown }> = {};
    for (const field of ['enabled', 'dailyMessageLimit', 'globalDailyMessageLimit'] as const) {
      if (before[field] !== values[field]) {
        changed[field] = { before: before[field], after: values[field] };
      }
    }
    this.audit.record(adminId, 'settings.assistant.update', 'app_settings', 'assistant', {
      changed,
    });
    return this.adminSettings();
  }

  /* ── Retention ─────────────────────────────────────────────────────────── */

  @ScheduledJob('assistant.prune')
  async prune(): Promise<void> {
    await this.leases.run('assistant.prune', 30 * 60_000, async () => {
      const removed = await this.store.pruneIdleConversations(RETENTION_DAYS);
      if (removed > 0) {
        this.logger.log(
          `Pruned ${removed} assistant conversation(s) idle over ${RETENTION_DAYS} days.`,
        );
      }
    });
  }

  /* ── Internals ─────────────────────────────────────────────────────────── */

  /** Switched on, configured, and asked by a verified client. */
  private async assertCanUse(clientId: number): Promise<AssistantSettingsRow> {
    const settings = await this.store.getSettings();
    if (!this.llm.isConfigured() || !settings.enabled) {
      throw new AssistantUnavailableError('The assistant is not available right now.');
    }
    if (!(await this.isVerified(clientId))) {
      throw new KycNotVerifiedError('Verify your identity to use the assistant.');
    }
    return settings;
  }

  /**
   * The three limits, cheapest refusal first. Returns the answers left today
   * after this one. The one-at-a-time rule is not here: it is a constraint,
   * enforced by the INSERT that opens the answer.
   */
  private async assertCanAsk(clientId: number): Promise<number> {
    const settings = await this.assertCanUse(clientId);
    if (
      (await this.store.answersSince(clientId, new Date(Date.now() - 60_000))) >= PER_MINUTE_LIMIT
    ) {
      throw new AssistantRateLimitError('You are asking too quickly. Wait a moment and try again.');
    }
    const usedToday = await this.store.answersSince(clientId, startOfUtcDay());
    if (usedToday >= settings.dailyMessageLimit) {
      throw new AssistantDailyLimitError(
        'You have reached your daily question limit. It resets at midnight UTC.',
      );
    }
    if (
      (await this.store.platformAnswersSince(startOfUtcDay())) >= settings.globalDailyMessageLimit
    ) {
      throw new AssistantCapacityError(
        'The assistant has reached its limit for today. Please try again tomorrow.',
      );
    }
    return settings.dailyMessageLimit - usedToday - 1;
  }

  private async isVerified(clientId: number): Promise<boolean> {
    const user = await this.users.findById(clientId);
    return (user?.verificationLevel ?? 0) >= REQUIRED_VERIFICATION_LEVEL;
  }

  /**
   * The conversation's visible thread, read once. Not theirs reads as not found.
   * `adds` is how many visible messages the request will add: a question adds
   * two, a regenerate none (it replaces the last answer), so a full thread can
   * still have its last answer retried.
   */
  private async threadOf(
    clientId: number,
    conversationId: string,
    adds: 0 | 2,
  ): Promise<AssistantMessageRow[]> {
    const conversation = await this.store.findConversation(clientId, conversationId);
    if (!conversation) throw new NotFoundError('Conversation not found.');
    const messages = await this.store.messagesOf(clientId, conversationId);
    if (messages.length + adds > MAX_THREAD_MESSAGES) {
      throw new AssistantConversationFullError('This conversation is full. Start a new chat.');
    }
    return messages;
  }

  private prepared(
    clientId: number,
    locale: Locale,
    exchange: AssistantExchange,
    items: LlmItem[],
    question: string,
    remainingToday: number,
  ): PreparedAnswer {
    return {
      clientId,
      locale,
      conversationId: exchange.conversationId,
      assistantMessageId: exchange.assistantMessageId,
      created: exchange.created,
      items,
      question,
      endUserKey: createHmac('sha256', this.identityKey)
        .update(`assistant:${clientId}`)
        .digest('hex')
        .slice(0, 32),
      remainingToday,
    };
  }
}

/**
 * The recent thread, newest kept, within the turn and character budgets.
 * Answers that never produced text (failed, still streaming) are left out:
 * they would show the model a question with no reply where the client saw an
 * error.
 *
 * A REFUSED exchange is left out whole, question included. Moderation judges
 * only the newest question, so a flagged one sent back as history would reach
 * the model one turn later behind "answer my previous question".
 */
function historyItems(messages: readonly AssistantMessageRow[]): LlmItem[] {
  const usable: AssistantMessageRow[] = [];
  for (const m of messages) {
    if (m.role === 'assistant' && m.status === 'refused') {
      if (usable.at(-1)?.role === 'user') usable.pop();
    } else if (m.role === 'user' || (m.status !== 'streaming' && m.content.trim().length > 0)) {
      usable.push(m);
    }
  }
  const kept: LlmItem[] = [];
  let chars = 0;
  for (let i = usable.length - 1; i >= 0 && kept.length < HISTORY_TURNS; i -= 1) {
    const message = usable[i];
    chars += message.content.length;
    if (chars > HISTORY_CHARS && kept.length > 0) break;
    kept.unshift({ kind: 'message', role: message.role, text: message.content });
  }
  // A thread sent to the model starts with the client speaking.
  while (kept.length > 0 && kept[0].kind === 'message' && kept[0].role === 'assistant')
    kept.shift();
  return kept;
}

/** The conversation's name: the first question on one line, shortened. */
function titleFrom(question: string): string {
  const line = question.replace(/\s+/g, ' ').trim();
  return line.length > 80 ? `${line.slice(0, 79).trimEnd()}…` : line;
}

function startOfUtcDay(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function nextUtcMidnight(): Date {
  return new Date(startOfUtcDay().getTime() + 86_400_000);
}
