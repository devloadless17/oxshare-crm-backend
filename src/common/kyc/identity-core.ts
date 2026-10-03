import { isProfileKey, type ProfileKey } from '../profile/client-profile';
import {
  DOCUMENT_CATALOGUE,
  DOCUMENT_TYPE_PREFIX,
  documentFieldType,
  documentForFieldType,
  type CatalogueDocument,
} from './document-catalogue';

/**
 * THE IDENTITY CORE — the part of the KYC form the PLATFORM owns (26 Sep 2026).
 * A pure seam: no Nest, no Drizzle, no fs.
 *
 * ## The defect
 *
 * Deleting "First Name" from Personal Information in the builder and adding it
 * back produced a CUSTOM field: a box labelled "firstname" whose answer landed
 * in `personal_info` as an anonymous broker question, while the client's real
 * first name — the profile column every screen and audit row reads — was no
 * longer asked at all. Reported from local testing, and found on the dev
 * database in exactly that shape.
 *
 * It was one symptom of one cause: the system recognised identity only by a
 * field's KEY, inside a configuration the builder could rewrite at will. So the
 * builder could also relabel it, re-type it, move it to another step, delete
 * the step holding it, ask for a passport twice or on a step of the broker's
 * own, and name a custom upload `doc_front` so it overwrote the real passport.
 *
 * ## The fix: identity is not configuration
 *
 * As in any serious CRM, the client's identity is FIXED — the fields, their
 * labels, their types and which are required — and so are the documents that
 * prove it. They are defined here, in code:
 *
 *  - the nine profile fields are never STORED in `kyc_config_steps`. The store
 *    injects them at the top of the personal step on every read and drops them
 *    on every write (`platformStep` / `storedStep`), so no edit in the builder
 *    has anything to act on;
 *  - the four built-in steps exist exactly once, with fixed slugs and titles.
 *    Personal Information and Identity Document are always on; Selfie and
 *    Proof of Address can be switched off (the owner's ruling, 26 Sep 2026);
 *  - the identity and address steps hold only their catalogue documents, each
 *    at most once, and the selfie step only its camera. A broker who wants
 *    another upload puts it on a step of their own.
 *
 * What stays the broker's: extra questions on Personal Information, steps of
 * their own, which documents they accept, whether to ask for a selfie or a
 * proof of address, and each step's description.
 *
 * ⚠️ This REVERSES the 15 Aug 2026 retirement of the mandatory-step rule
 * (`admin-compliance.service.ts` records it), for two of the four steps and on
 * the owner's explicit instruction. The retirement was right that which
 * SUPPORTING documents a jurisdiction requires is the broker's call — so the
 * selfie and the proof of address can still be switched off. It could not be
 * right about the other two: a verification without the person's identity and
 * an identity document is not a verification of anybody.
 */

/** A form field, structurally — the store's `KycFieldConfig` fits it. */
export interface FormField {
  id: string;
  name: string;
  label: string;
  type: string;
  required: boolean;
  hint?: string;
  options?: string[];
  /**
   * The Arabic twins (0179): the label, the hint, and each option's label keyed
   * by its English value (the stored answer is always the English value). The
   * platform's fields carry the platform's Arabic, rebuilt here like `label`.
   */
  labelAr?: string;
  hintAr?: string;
  optionsAr?: Record<string, string>;
  /** Platform-owned: served on read, never stored, never editable. */
  system?: boolean;
}

/** A form step, structurally — the store's `KycStepConfig` fits it. */
export interface FormStep<F extends FormField = FormField> {
  id: string;
  stepNumber: number;
  slug: string;
  title: string;
  description: string;
  /** The title and description in Arabic (0179); absent = not translated. */
  titleAr?: string;
  descriptionAr?: string;
  icon: string;
  enabled: boolean;
  fields: F[];
  /** One of the four built-in steps — served on read, never stored. */
  core?: boolean;
  /**
   * Kept for older readers and always false: since Phase 2 (29 Sep 2026) every
   * step, the built-in ones included, can be switched off.
   */
  alwaysOn?: boolean;
  /**
   * On the identity document, selfie and proof of address steps: must the client
   * provide it (true, the default), or may they skip it. Meaningless elsewhere.
   */
  evidenceRequired?: boolean;
}

/** One of the platform's identity fields. */
export interface IdentityField extends FormField {
  name: ProfileKey;
}

/**
 * THE CLIENT'S IDENTITY, as the KYC form asks for it.
 *
 * In the profile's own order (`PROFILE_FIELD_KEYS`) — the order sign-up and the
 * support desk's edit present them, so a client meets them the same way in all
 * three. The ids are the ones the default configuration has always used, so a
 * builder holding an old draft still recognises them.
 *
 * `required` is the VERIFICATION tier and it is the platform's, not the
 * broker's (the owner's ruling): everything but the postal code, which many
 * addresses do not have — the UAE's and Qatar's among them.
 */
/**
 * Advice for an OPTIONAL detail. Where the broker makes that detail required it
 * is dropped (`platformStep`): "leave blank" beside a required asterisk told the
 * client two opposite things (found in local testing, 29 Sep 2026).
 */
const BLANK_ALLOWED_HINT = 'Leave blank if your address has none';
const BLANK_ALLOWED_HINT_AR = 'اتركه فارغًا إذا لم يتضمّن عنوانك ذلك';

/*
 * The Arabic beside each English label and hint (0179) is the PLATFORM's, like
 * the English: served on every read, never stored, never editable.
 */
export const IDENTITY_FIELDS: readonly IdentityField[] = [
  {
    id: 'f-1',
    name: 'firstName',
    label: 'First Name',
    labelAr: 'الاسم الأول',
    type: 'text',
    required: true,
    hint: 'As on your ID',
    hintAr: 'كما يظهر في وثيقة هويتك',
  },
  {
    id: 'f-2',
    name: 'lastName',
    label: 'Last Name',
    labelAr: 'اسم العائلة',
    type: 'text',
    required: true,
    hint: 'As on your ID',
    hintAr: 'كما يظهر في وثيقة هويتك',
  },
  {
    id: 'f-3',
    name: 'dateOfBirth',
    label: 'Date of Birth',
    labelAr: 'تاريخ الميلاد',
    type: 'date',
    required: true,
    hint: 'Must be 18+',
    hintAr: 'يجب أن يكون عمرك 18 عامًا أو أكثر',
  },
  {
    id: 'f-5',
    name: 'nationality',
    label: 'Nationality',
    labelAr: 'الجنسية',
    type: 'select',
    required: true,
  },
  {
    id: 'f-4',
    name: 'phone',
    label: 'Phone Number',
    labelAr: 'رقم الهاتف',
    type: 'phone',
    required: true,
    hint: 'International format',
    hintAr: 'بالصيغة الدولية',
  },
  {
    id: 'f-6',
    name: 'country',
    label: 'Country of Residence',
    labelAr: 'بلد الإقامة',
    type: 'select',
    required: true,
  },
  {
    id: 'f-7',
    name: 'address',
    label: 'Residential Address',
    labelAr: 'عنوان السكن',
    type: 'text',
    required: true,
  },
  { id: 'f-city', name: 'city', label: 'City', labelAr: 'المدينة', type: 'text', required: true },
  {
    // Added 28 Sep 2026 (the owner's list): free text, optional — many
    // countries have no state or province in an address.
    id: 'f-state-province',
    name: 'stateProvince',
    label: 'State / Province',
    labelAr: 'الولاية / المحافظة',
    type: 'text',
    required: false,
    hint: BLANK_ALLOWED_HINT,
    hintAr: BLANK_ALLOWED_HINT_AR,
  },
  {
    id: 'f-postal-code',
    name: 'postalCode',
    label: 'Postal / ZIP code',
    labelAr: 'الرمز البريدي',
    type: 'text',
    required: false,
    hint: BLANK_ALLOWED_HINT,
    hintAr: BLANK_ALLOWED_HINT_AR,
  },
];

/** What a verification cannot be submitted without — every identity field but the postal code. */
export const VERIFICATION_REQUIRED: readonly ProfileKey[] = IDENTITY_FIELDS.filter(
  (field) => field.required,
).map((field) => field.name);

/**
 * What SIGN-UP must collect (the owner's ruling, 26 Sep 2026): who the person
 * is and how to reach them. The address, city and postal code are completed in
 * the verification, pre-filled from whatever sign-up was given.
 */
export const REGISTRATION_REQUIRED: readonly ProfileKey[] = [
  'firstName',
  'lastName',
  'dateOfBirth',
  'nationality',
  'phone',
  'country',
];

export function identityField(name: string): IdentityField | undefined {
  return IDENTITY_FIELDS.find((field) => field.name === name);
}

// ─── The four built-in steps ─────────────────────────────────────────────────

export type CoreSlug = 'personal' | 'document' | 'selfie' | 'address';

export interface CoreStep {
  slug: CoreSlug;
  title: string;
  /**
   * The default title in Arabic (0179) — served for a step still wearing the
   * default English title with no Arabic of its own (`platformStep`).
   */
  titleAr: string;
  icon: string;
  /** The default wording. The broker may reword it; the title is fixed. */
  description: string;
  /** The default wording in Arabic; the broker may reword it like `description`. */
  descriptionAr: string;
  /** Personal Information and Identity Document: a verification is these. */
  alwaysOn: boolean;
  /** The kind of catalogue document the step collects, when it collects one. */
  documents?: 'identity' | 'address';
}

export const CORE_STEPS: readonly CoreStep[] = [
  {
    slug: 'personal',
    title: 'Personal Information',
    titleAr: 'المعلومات الشخصية',
    icon: 'User',
    description: 'Legal identity details exactly as they appear on your government ID.',
    descriptionAr: 'بيانات هويتك القانونية كما تظهر تمامًا في وثيقة هويتك الرسمية.',
    alwaysOn: false,
  },
  {
    slug: 'document',
    title: 'Identity Document',
    titleAr: 'وثيقة الهوية',
    icon: 'FileText',
    description: 'Upload a valid Passport, National ID, Driving License or Residence Permit.',
    descriptionAr: 'حمّل جواز سفر أو بطاقة هوية وطنية أو رخصة قيادة أو تصريح إقامة ساري المفعول.',
    alwaysOn: false,
    documents: 'identity',
  },
  {
    slug: 'selfie',
    title: 'Selfie Verification',
    titleAr: 'التحقق بصورة سيلفي',
    icon: 'Camera',
    description: 'Live selfie photo matching your identity document.',
    descriptionAr: 'صورة سيلفي مباشرة تطابق وثيقة هويتك.',
    alwaysOn: false,
  },
  {
    slug: 'address',
    title: 'Proof of Address',
    titleAr: 'إثبات العنوان',
    icon: 'Home',
    description: 'Document dated within the last 3 months showing your residential address.',
    descriptionAr: 'وثيقة مؤرَّخة خلال آخر 3 أشهر تُظهر عنوان سكنك.',
    alwaysOn: false,
    documents: 'address',
  },
];

export function coreStepOf(slug: string): CoreStep | undefined {
  return CORE_STEPS.find((step) => step.slug === slug);
}

/**
 * The summary screen the portal appends after every configured step. Never
 * configured, so never a slug a broker's step may take.
 */
export const REVIEW_SLUG = 'review';

/** Slugs no step of the broker's may take. */
export const RESERVED_SLUGS: readonly string[] = [
  ...CORE_STEPS.map((step) => step.slug),
  REVIEW_SLUG,
];

/** The selfie step's one field — the platform's camera. */
export const SELFIE_FIELD: FormField = {
  id: 'f-11',
  name: 'selfie',
  label: 'Selfie Photo',
  labelAr: 'صورة سيلفي',
  type: 'camera',
  required: true,
};

// ─── Documents ───────────────────────────────────────────────────────────────

/**
 * The field each catalogue document is collected under on its step — the ids
 * and names the default configuration has always written, so a flag a reviewer
 * raised against `nationalId` keeps naming the national ID.
 */
const DOCUMENT_FIELD_KEYS: Readonly<Record<string, { id: string; name: string }>> = {
  passport: { id: 'f-doc-passport', name: 'passport' },
  national_id: { id: 'f-doc-national-id', name: 'nationalId' },
  driving_license: { id: 'f-doc-driving-license', name: 'drivingLicense' },
  residence_permit: { id: 'f-doc-residence-permit', name: 'residencePermit' },
  utility_bill: { id: 'f-addr-utility', name: 'utilityBill' },
  bank_statement: { id: 'f-addr-bank', name: 'bankStatement' },
  tenancy_agreement: { id: 'f-addr-tenancy', name: 'tenancyAgreement' },
};

/**
 * The ONE way a catalogue document appears on its step.
 *
 * The TYPE is the only fact a stored document field carries; the id, name and
 * label follow from it. A field that says `doc:passport` and is labelled
 * "National ID" is therefore impossible — on read and on write alike.
 */
export function documentField(doc: CatalogueDocument): FormField {
  const keys = Object.prototype.hasOwnProperty.call(DOCUMENT_FIELD_KEYS, doc.value)
    ? DOCUMENT_FIELD_KEYS[doc.value]
    : {
        id: `f-doc-${doc.value.replace(/_/g, '-')}`,
        name: doc.value.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()),
      };
  return {
    id: keys.id,
    name: keys.name,
    label: doc.label,
    labelAr: doc.labelAr,
    type: documentFieldType(doc.value),
    required: false,
  };
}

/** A document field as STORED: its type is the fact, and its Arabic name follows from it. */
export function storedDocumentField(doc: CatalogueDocument): FormField {
  const { labelAr: _platform, ...field } = documentField(doc);
  return field;
}

/** The catalogue, split the way the two document steps offer it. */
export const DOCUMENT_CATALOGUE_BY_CATEGORY: Readonly<
  Record<'identity' | 'address', readonly CatalogueDocument[]>
> = {
  identity: DOCUMENT_CATALOGUE.filter((doc) => doc.category === 'identity'),
  address: DOCUMENT_CATALOGUE.filter((doc) => doc.category === 'address'),
};

/** The names the document fields use — no field of the broker's may take one. */
const DOCUMENT_FIELD_NAMES: readonly string[] = DOCUMENT_CATALOGUE.map(
  (doc) => documentField(doc).name,
);

export function isDocumentField(field: { type?: string }): boolean {
  return (field.type ?? '').startsWith(DOCUMENT_TYPE_PREFIX);
}

/**
 * The catalogue documents a step accepts: each at most once, of the step's own
 * category, in catalogue order — the order the builder's checklist shows.
 */
export function acceptedDocuments(
  fields: readonly { type?: string }[],
  category: 'identity' | 'address',
): CatalogueDocument[] {
  const offered = new Set(
    fields
      .map((field) => documentForFieldType(field.type))
      .filter((doc): doc is CatalogueDocument => doc?.category === category)
      .map((doc) => doc.value),
  );
  return DOCUMENT_CATALOGUE.filter((doc) => offered.has(doc.value));
}

// ─── The form as the platform serves it, and as it is stored ─────────────────

/**
 * A step as every reader sees it (Phase 2, 29 Sep 2026 — the owner's "everything
 * customizable"): the broker's title, order and switch, with the platform's
 * parts rebuilt from code where they sit.
 *
 *  - an identity field on Personal Information is a PLACEMENT the broker chose —
 *    where it sits and whether it is required; its name, label, type and hint
 *    are the platform's, rebuilt here, so no save can rename or retype one, and
 *    a second placement of the same detail is dropped;
 *  - the selfie step opens with its camera (`system`), required when the
 *    step's evidence is;
 *  - a document step lists its accepted documents first, rebuilt from their
 *    types, then any question of the broker's.
 */
export function platformStep<S extends FormStep>(step: S): S {
  const core = coreStepOf(step.slug);
  if (!core) return { ...step, core: false, alwaysOn: false };

  const evidenceRequired = step.evidenceRequired !== false;
  const placed = new Set<string>();
  const own: FormField[] = [];
  for (const field of step.fields) {
    if (core.slug === 'personal' && isProfileKey(field.name)) {
      if (placed.has(field.name)) continue;
      placed.add(field.name);
      const detail = identityField(field.name)!;
      const required = Boolean(field.required);
      const { hint, hintAr, ...rest } = detail;
      const advise = Boolean(hint) && !(required && hint === BLANK_ALLOWED_HINT);
      own.push({
        ...rest,
        ...(advise ? { hint } : {}),
        ...(advise && hintAr ? { hintAr } : {}),
        required,
        system: true,
      });
    } else if (!isPlatformField(core.slug, field)) {
      own.push(field);
    }
  }
  const platform: FormField[] =
    core.slug === 'selfie'
      ? [{ ...SELFIE_FIELD, required: evidenceRequired, system: true }]
      : core.documents
        ? acceptedDocuments(step.fields, core.documents).map(documentField)
        : [];
  return {
    ...step,
    ...coreArabic(core, step),
    icon: core.icon,
    evidenceRequired: core.slug === 'personal' ? undefined : evidenceRequired,
    core: true,
    alwaysOn: false,
    // The platform's fields are plain `FormField`s; the caller's field type is a
    // structural superset whose extra members are all optional.
    fields: [...(platform as S['fields']), ...(own as S['fields'])],
  };
}

/**
 * The platform's Arabic for a built-in step still wearing the platform's English
 * (0179). A step whose title or description the broker reworded keeps whatever
 * Arabic the broker wrote — the platform's would translate words no longer
 * there. The broker's own Arabic always wins.
 */
function coreArabic(
  core: CoreStep,
  step: Pick<FormStep, 'title' | 'description' | 'titleAr' | 'descriptionAr'>,
): Pick<FormStep, 'titleAr' | 'descriptionAr'> {
  const own = (text: string | undefined) => (text?.trim() ? text : undefined);
  const titleAr = own(step.titleAr) ?? (step.title === core.title ? core.titleAr : undefined);
  const descriptionAr =
    own(step.descriptionAr) ??
    (step.description === core.description ? core.descriptionAr : undefined);
  return {
    ...(titleAr ? { titleAr } : { titleAr: undefined }),
    ...(descriptionAr ? { descriptionAr } : { descriptionAr: undefined }),
  };
}

/**
 * A step as it is STORED: an identity placement as the platform's field with the
 * broker's `required`, a document as its type, the selfie camera not at all
 * (it follows from the step), and the flags that describe the served form
 * (`core`, `alwaysOn`, `system`) never.
 */
export function storedStep<S extends FormStep>(step: S): S {
  const { core: _core, alwaysOn: _alwaysOn, ...rest } = step;
  const unflagged = rest.fields.map(({ system: _system, ...field }) => field);
  const spec = coreStepOf(step.slug);
  if (!spec) return { ...rest, evidenceRequired: undefined, fields: unflagged } as S;

  const placed = new Set<string>();
  const kept: FormField[] = [];
  for (const field of unflagged) {
    if (spec.slug === 'personal' && isProfileKey(field.name)) {
      if (placed.has(field.name)) continue;
      placed.add(field.name);
      const { id, name, label, type } = identityField(field.name)!;
      kept.push({ id, name, label, type, required: Boolean(field.required) });
    } else if (!isPlatformField(spec.slug, field)) {
      kept.push(field);
    }
  }
  const documents: FormField[] = spec.documents
    ? acceptedDocuments(unflagged, spec.documents).map(storedDocumentField)
    : [];
  return {
    ...rest,
    icon: spec.icon,
    evidenceRequired: spec.slug === 'personal' ? undefined : rest.evidenceRequired !== false,
    fields: [...documents, ...kept],
  } as S;
}

/**
 * The identity details the form asks for, where the broker placed them, each
 * with whether it is required — Personal Information's identity fields, or
 * none when that step is switched off.
 */
export function identityPlacements(
  steps: readonly FormStep[],
): { name: ProfileKey; required: boolean }[] {
  const personal = steps.find((step) => step.slug === 'personal');
  if (!personal?.enabled) return [];
  return personal.fields
    .filter((field) => isProfileKey(field.name))
    .map((field) => ({ name: field.name as ProfileKey, required: Boolean(field.required) }));
}

/**
 * The requirements a submission was made under (0158): each built-in step's
 * switch and, for the evidence steps, whether evidence was required; and the
 * identity details asked, each with whether it was required.
 */
export interface FormPolicy {
  steps: { slug: string; enabled: boolean; evidenceRequired?: boolean }[];
  identity: { name: string; required: boolean }[];
}

/** The requirements the form sets NOW — what a submission records as its policy. */
export function policyOf(steps: readonly FormStep[]): FormPolicy {
  return {
    steps: steps
      .filter((step) => coreStepOf(step.slug))
      .map((step) => ({
        slug: step.slug,
        enabled: step.enabled,
        ...(step.slug === 'personal' ? {} : { evidenceRequired: step.evidenceRequired !== false }),
      })),
    identity: identityPlacements(steps),
  };
}

/**
 * The form as it stood for a submission: today's steps with the built-in
 * steps' switches, evidence requirements and identity placements put back to
 * what `policy` recorded. The broker's own questions are left as they are —
 * approval does not re-ask them.
 */
export function withPolicy<
  S extends {
    slug: string;
    enabled: boolean;
    evidenceRequired?: boolean;
    fields: readonly { name: string; required: boolean }[];
  },
>(steps: readonly S[], policy: FormPolicy): S[] {
  return steps.map((step) => {
    const recorded = policy.steps.find((candidate) => candidate.slug === step.slug);
    if (!recorded) return step;
    const evidenceRequired = recorded.evidenceRequired;
    let fields = step.fields;
    if (step.slug === 'personal') {
      const own = step.fields.filter((field) => !isProfileKey(field.name));
      const identity = policy.identity
        .filter((placed) => isProfileKey(placed.name))
        .map((placed) => ({
          ...identityField(placed.name)!,
          required: placed.required,
          system: true,
        }));
      fields = [...identity, ...own];
    } else if (step.slug === 'selfie') {
      fields = step.fields.map((field) =>
        field.name === SELFIE_FIELD.name
          ? { ...field, required: evidenceRequired !== false }
          : field,
      );
    }
    return { ...step, enabled: recorded.enabled, evidenceRequired, fields };
  });
}

/** Every identity detail, placed in the platform's order with its default tier. */
export const DEFAULT_IDENTITY_PLACEMENTS: readonly FormField[] = IDENTITY_FIELDS.map(
  ({ id, name, label, type, required }) => ({ id, name, label, type, required }),
);

/**
 * A field the platform owns on a built-in step: an identity field on Personal
 * Information, the camera on the selfie step, a document on a document step.
 */
export function isPlatformField(slug: string, field: { name: string; type?: string }): boolean {
  switch (slug) {
    case 'personal':
      return isProfileKey(field.name);
    case 'selfie':
      return field.name === SELFIE_FIELD.name;
    case 'document':
    case 'address':
      return isDocumentField(field);
    default:
      return false;
  }
}

/**
 * Every step in the broker's order, numbered from one — the order a client meets
 * them in. Personal Information was forced first until Phase 2; the order is
 * the broker's now.
 */
export function inFormOrder<S extends FormStep>(steps: readonly S[]): S[] {
  return steps.map((step, index) => ({ ...step, stepNumber: index + 1 }));
}

// ─── What a broker's own field and step may be called ────────────────────────

/** Upload slots the rest of the system reads by name. */
const CANONICAL_SLOTS: readonly string[] = [
  'doc_front',
  'doc_back',
  'selfie',
  'address_proof',
  'address_proof_2',
];

/** Keys every JavaScript object already answers to — never an answer's key. */
const PROTOTYPE_KEYS: readonly string[] = [
  '__proto__',
  'constructor',
  'prototype',
  'hasOwnProperty',
  'isPrototypeOf',
  'propertyIsEnumerable',
  'toLocaleString',
  'toString',
  'valueOf',
];

/** A usable key: a letter, then letters, digits, underscores or hyphens. */
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

/**
 * Why a field of the broker's may not take this key, or `undefined` when it
 * may. Each reserved key is read BY NAME somewhere, so a broker's field wearing
 * one would be filed as — or over — the thing that owns it.
 */
export function reservedFieldName(name: string): string | undefined {
  if (isProfileKey(name)) {
    return `the client's ${identityField(name)!.label}, which the platform asks for itself`;
  }
  if (CANONICAL_SLOTS.includes(name)) return 'where an identity document or the selfie is stored';
  if (DOCUMENT_FIELD_NAMES.includes(name)) return 'the name of a document the platform collects';
  if (name === 'docType') return 'where the client’s choice of document is stored';
  if (name.startsWith('__') || PROTOTYPE_KEYS.includes(name)) {
    return 'a name the system uses internally';
  }
  return undefined;
}

export function isUsableFieldName(name: string): boolean {
  return FIELD_NAME.test(name) && reservedFieldName(name) === undefined;
}

/** A step address of the broker's: lower-case words joined by hyphens. */
const CUSTOM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_SLUG_LENGTH = 48;

/** Why a NEW step of the broker's may not take this address, or `undefined`. */
export function customSlugProblem(slug: string): string | undefined {
  if (RESERVED_SLUGS.includes(slug)) return 'the platform uses that address itself';
  if (slug.length > MAX_SLUG_LENGTH || !CUSTOM_SLUG.test(slug)) {
    return 'an address is lower-case letters and digits joined by hyphens';
  }
  return undefined;
}

/**
 * The address a new step of the broker's is given — from its title, so the
 * client's address bar reads `/kyc/step/source-of-funds`, and never one taken,
 * reserved or empty (a title in Arabic has no Latin letters to make one from).
 */
export function newCustomSlug(title: string, taken: ReadonlySet<string>): string {
  const base =
    title
      .normalize('NFKD')
      .replace(/\p{M}/gu, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, MAX_SLUG_LENGTH - 3)
      .replace(/-+$/g, '') || 'step';
  const free = (candidate: string) => !taken.has(candidate) && !RESERVED_SLUGS.includes(candidate);
  if (free(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (free(candidate)) return candidate;
  }
}

// ─── What a broker's own field may be LABELLED ───────────────────────────────

/** A label as compared: accents, case, spacing and punctuation removed. */
export function normaliseLabel(label: string): string {
  return (
    label
      .normalize('NFKD')
      .replace(/\p{M}/gu, '')
      .toLowerCase()
      // Arabic's tatweel (ـ) only stretches a word; "الاســم" is "الاسم".
      .replace(/ـ/g, '')
      .replace(/[^\p{L}\p{N}]/gu, '')
  );
}

/**
 * Labels that NAME something the platform already collects, and what that is.
 *
 * A broker's question labelled "First name" is the defect this file exists to
 * end, arriving by another door: a second box for the same fact, whose answer
 * can disagree with the real one. Matched on the WHOLE label once normalised,
 * so "Employer name" or "Previous address" stay the broker's to ask.
 */
const PLATFORM_LABELS: ReadonlyMap<string, string> = new Map(
  (
    [
      ['First Name', ['firstname', 'givenname', 'forename', 'name', 'fullname', 'legalname']],
      ['Last Name', ['lastname', 'surname', 'familyname']],
      ['Date of Birth', ['dateofbirth', 'birthdate', 'dob', 'birthday']],
      ['Nationality', ['nationality', 'citizenship']],
      [
        'Phone Number',
        [
          'phone',
          'phonenumber',
          'mobile',
          'mobilenumber',
          'mobilephone',
          'telephone',
          'telephonenumber',
          'cellphone',
          'contactnumber',
        ],
      ],
      ['Country of Residence', ['country', 'countryofresidence', 'residencecountry', 'residence']],
      ['Residential Address', ['address', 'residentialaddress', 'streetaddress', 'homeaddress']],
      ['City', ['city', 'town', 'cityortown']],
      [
        'State / Province',
        ['state', 'province', 'stateprovince', 'stateorprovince', 'region', 'county'],
      ],
      ['Postal / ZIP code', ['postalcode', 'postcode', 'zip', 'zipcode', 'postalzipcode']],
      ['Email', ['email', 'emailaddress']],
      ['Passport', ['passport']],
      ['National ID', ['nationalid', 'nationalidcard', 'idcard', 'identitycard']],
      ['Driving License', ['drivinglicense', 'drivinglicence', 'driverslicense', 'driverslicence']],
      ['Residence Permit', ['residencepermit', 'residencecard']],
      ['Selfie Photo', ['selfie', 'selfiephoto']],
      ['Proof of Address', ['proofofaddress', 'utilitybill', 'bankstatement', 'tenancyagreement']],
    ] as const
  ).flatMap(([meaning, spellings]) => spellings.map((spelling) => [spelling, meaning] as const)),
);

/**
 * A catalogue document's PAGES, named the way migration 0137 named the File
 * fields it made from documents that stood on a broker's own step ("National
 * ID — Back Side"). Each is a document the platform collects on its own step —
 * a second passport photo page on another step is the second passport the
 * owner ruled out.
 */
const DOCUMENT_PAGE_LABELS: ReadonlyMap<string, string> = new Map(
  DOCUMENT_CATALOGUE.flatMap((doc) =>
    doc.parts.map(
      (part) =>
        [
          normaliseLabel(`${doc.label} ${part.label}`),
          doc.category === 'identity' ? doc.label : 'Proof of Address',
        ] as const,
    ),
  ),
);

/**
 * The same names IN ARABIC (0179), meaning the same English things: an Arabic
 * label naming the client's first name is the same second box as an English
 * one. The platform's own Arabic labels, a few everyday synonyms, and each
 * document page in Arabic. Kept apart from the English maps, so the English
 * matching stays exactly what it was.
 */
const ARABIC_PLATFORM_LABELS: ReadonlyMap<string, string> = new Map(
  (
    [
      ...IDENTITY_FIELDS.map((field) => [field.labelAr!, field.label] as const),
      ['الاسم', 'First Name'],
      ['الاسم الكامل', 'First Name'],
      ['الاسم الثلاثي', 'First Name'],
      ['اللقب', 'Last Name'],
      ['الكنية', 'Last Name'],
      ['تاريخ الولادة', 'Date of Birth'],
      ['المواطنة', 'Nationality'],
      ['الهاتف', 'Phone Number'],
      ['رقم الجوال', 'Phone Number'],
      ['رقم الموبايل', 'Phone Number'],
      ['البلد', 'Country of Residence'],
      ['الدولة', 'Country of Residence'],
      ['دولة الإقامة', 'Country of Residence'],
      ['العنوان', 'Residential Address'],
      ['البريد الإلكتروني', 'Email'],
      ...DOCUMENT_CATALOGUE.map(
        (doc) =>
          [doc.labelAr, doc.category === 'identity' ? doc.label : 'Proof of Address'] as const,
      ),
      ...DOCUMENT_CATALOGUE.flatMap((doc) =>
        doc.parts.map(
          (part) =>
            [
              `${doc.labelAr} ${part.labelAr}`,
              doc.category === 'identity' ? doc.label : 'Proof of Address',
            ] as const,
        ),
      ),
      [SELFIE_FIELD.labelAr!, 'Selfie Photo'],
      ['إثبات العنوان', 'Proof of Address'],
    ] as const
  ).map(([spelling, meaning]) => [normaliseLabel(spelling), meaning] as const),
);

/** What the platform already collects under this label, or `undefined`. */
export function platformMeaningOf(label: string): string | undefined {
  const normalised = normaliseLabel(label);
  return (
    PLATFORM_LABELS.get(normalised) ??
    DOCUMENT_PAGE_LABELS.get(normalised) ??
    ARABIC_PLATFORM_LABELS.get(normalised)
  );
}

/** A built-in step's title, if a broker's step is trying to wear it — in English or Arabic. */
export function coreTitleMatching(title: string): string | undefined {
  const wanted = normaliseLabel(title);
  return CORE_STEPS.find(
    (step) => normaliseLabel(step.title) === wanted || normaliseLabel(step.titleAr) === wanted,
  )?.title;
}
