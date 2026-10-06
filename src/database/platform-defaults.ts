import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { getDb, type Db } from './db';
import { kycConfigSteps, rejectionReasons } from './schema';
import { DEFAULT_KYC_STEPS } from '../store/kyc-config.store';

/**
 * WHAT EVERY DATABASE STARTS WITH, production included.
 *
 * Until 6 Oct 2026 these lived only in `seed.ts`, which production never runs (main.ts gates it on
 * NODE_ENV, because the seed also creates demo logins). So a fresh production database started with
 * an EMPTY KYC form: a new client saw no steps, could submit nothing and could never be verified.
 *
 * Two things, written ONCE, on a database's first boot:
 *
 *  - the default KYC form (the four built-in steps and the identity details placed on Personal
 *    Information), and
 *  - the default rejection reasons for KYC, withdrawals, partner applications and deposits.
 *
 * "First boot" is read from the KYC form itself: the four built-in steps can never be deleted
 * (`assertKycConfigIntegrity`), so a database holding NO step has never been set up. That is why the
 * reasons are written only then too: a reason a broker deletes later must not come back on the next
 * deploy. An advisory lock makes two instances booting together (a blue-green release) write once.
 *
 * Nothing here is a demo or a login: those stay in `seed.ts`, development only.
 */

/** The default reasons' Arabic (0179), keyed by the English label. */
export const DEFAULT_REASON_AR: Readonly<Record<string, string>> = {
  'Identity document is blurry or unreadable': 'وثيقة الهوية غير واضحة أو غير مقروءة',
  'Identity document is expired': 'وثيقة الهوية منتهية الصلاحية',
  'Selfie does not match the identity document': 'الصورة الشخصية لا تطابق وثيقة الهوية',
  'Proof of address is older than 3 months': 'إثبات العنوان أقدم من 3 أشهر',
  'Proof of address does not match the declared address':
    'إثبات العنوان لا يطابق العنوان المُصرَّح به',
  'Personal information does not match the documents': 'المعلومات الشخصية لا تطابق الوثائق',
  'Document appears altered or tampered with': 'يبدو أن الوثيقة معدَّلة أو تم التلاعب بها',
  'Beneficiary details do not match the account holder': 'بيانات المستفيد لا تطابق صاحب الحساب',
  'Insufficient verified balance': 'الرصيد الموثَّق غير كافٍ',
  'Account verification (KYC) incomplete': 'التحقق من هوية الحساب غير مكتمل',
  'Suspicious activity — additional verification required': 'نشاط مشبوه — يلزم تحقق إضافي',
  'Insufficient trading or introducing experience': 'خبرة غير كافية في التداول أو في إحالة العملاء',
  'Introducing volume does not meet the programme minimum':
    'حجم الإحالات لا يبلغ الحد الأدنى للبرنامج',
  'Unable to verify the website or business details provided':
    'تعذّر التحقق من الموقع الإلكتروني أو بيانات النشاط التجاري المقدَّمة',
  'Application is incomplete or unclear': 'الطلب غير مكتمل أو غير واضح',
  'Does not meet the eligibility criteria for this programme':
    'لا يستوفي شروط الأهلية لهذا البرنامج',
  'The receipt is unreadable — please send a clearer photo':
    'الإيصال غير مقروء — يُرجى إرسال صورة أوضح',
  'The amount on the receipt does not match the amount requested':
    'المبلغ الوارد في الإيصال لا يطابق المبلغ المطلوب',
  'No payment matching this receipt has reached our account':
    'لم تصل إلى حسابنا أي دفعة مطابقة لهذا الإيصال',
  'The receipt is for a different transfer we have already credited':
    'الإيصال يخص تحويلاً آخر سبق أن أضفناه إلى رصيدك',
  'The receipt does not show who sent the payment': 'الإيصال لا يُظهر اسم مُرسِل الدفعة',
};

/*
 * Written at boot rather than by a migration, and that placement is forced: 'partner' (0030) and
 * 'deposit' (0127) were added to `rejection_context` by migrations, and Postgres refuses to USE a new
 * enum label inside the transaction that added it. Drizzle runs every pending migration in one
 * transaction on a fresh database, so even a later migration file could not insert them.
 *
 * Each deposit reason describes something the desk can see in the receipt or the statement, and none
 * promises a refund: nothing was debited.
 */
const REASONS: Record<'kyc' | 'withdrawal' | 'partner' | 'deposit', string[]> = {
  kyc: [
    'Identity document is blurry or unreadable',
    'Identity document is expired',
    'Selfie does not match the identity document',
    'Proof of address is older than 3 months',
    'Proof of address does not match the declared address',
    'Personal information does not match the documents',
    'Document appears altered or tampered with',
  ],
  withdrawal: [
    'Beneficiary details do not match the account holder',
    'Insufficient verified balance',
    'Account verification (KYC) incomplete',
    'Suspicious activity — additional verification required',
  ],
  partner: [
    'Insufficient trading or introducing experience',
    'Introducing volume does not meet the programme minimum',
    'Unable to verify the website or business details provided',
    'Application is incomplete or unclear',
    'Does not meet the eligibility criteria for this programme',
  ],
  deposit: [
    'The receipt is unreadable — please send a clearer photo',
    'The amount on the receipt does not match the amount requested',
    'No payment matching this receipt has reached our account',
    'The receipt is for a different transfer we have already credited',
    'The receipt does not show who sent the payment',
  ],
};

/** Every default reason, with its Arabic. */
export const DEFAULT_REJECTION_REASONS = (
  Object.entries(REASONS) as [keyof typeof REASONS, string[]][]
).flatMap(([context, labels]) =>
  labels.map((label) => ({ context, label, labelAr: DEFAULT_REASON_AR[label] ?? null })),
);

/** The default KYC form, as rows of `kyc_config_steps`. */
function defaultStepRows() {
  return DEFAULT_KYC_STEPS.map((s) => ({
    id: s.id,
    stepNumber: s.stepNumber,
    slug: s.slug,
    title: s.title,
    description: s.description,
    titleAr: s.titleAr ?? null,
    descriptionAr: s.descriptionAr ?? null,
    icon: s.icon,
    enabled: s.enabled,
    fields: s.fields as unknown as Record<string, unknown>[],
  }));
}

/**
 * Writes the defaults if this database has never been set up. Returns whether it wrote them.
 * Safe to call on every boot and from several instances at once.
 */
export async function ensurePlatformDefaults(db: Db): Promise<boolean> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('oxshare.platform_defaults'))`);
    const [step] = await tx.select({ id: kycConfigSteps.id }).from(kycConfigSteps).limit(1);
    if (step) return false;
    await tx.insert(kycConfigSteps).values(defaultStepRows());
    await tx.insert(rejectionReasons).values(DEFAULT_REJECTION_REASONS).onConflictDoNothing();
    return true;
  });
}

/** Runs `ensurePlatformDefaults` when the API boots, in every environment but the test suite. */
@Injectable()
export class PlatformDefaults implements OnApplicationBootstrap {
  private readonly logger = new Logger(PlatformDefaults.name);

  async onApplicationBootstrap(): Promise<void> {
    // The suite builds each database itself; a form appearing under a spec would change what it tests.
    if (process.env.NODE_ENV === 'test') return;
    if (await ensurePlatformDefaults(getDb())) {
      this.logger.log(
        'First boot of this database: wrote the default KYC form and rejection reasons.',
      );
    }
  }
}
