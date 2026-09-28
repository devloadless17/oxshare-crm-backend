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
  icon: string;
  enabled: boolean;
  fields: F[];
  /** One of the four built-in steps — served on read, never stored. */
  core?: boolean;
  /** A built-in step that cannot be switched off — served on read, never stored. */
  alwaysOn?: boolean;
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
export const IDENTITY_FIELDS: readonly IdentityField[] = [
  {
    id: 'f-1',
    name: 'firstName',
    label: 'First Name',
    type: 'text',
    required: true,
    hint: 'As on your ID',
  },
  {
    id: 'f-2',
    name: 'lastName',
    label: 'Last Name',
    type: 'text',
    required: true,
    hint: 'As on your ID',
  },
  {
    id: 'f-3',
    name: 'dateOfBirth',
    label: 'Date of Birth',
    type: 'date',
    required: true,
    hint: 'Must be 18+',
  },
  { id: 'f-5', name: 'nationality', label: 'Nationality', type: 'select', required: true },
  {
    id: 'f-4',
    name: 'phone',
    label: 'Phone Number',
    type: 'phone',
    required: true,
    hint: 'International format',
  },
  {
    id: 'f-6',
    name: 'country',
    label: 'Country of Residence',
    type: 'select',
    required: true,
  },
  { id: 'f-7', name: 'address', label: 'Residential Address', type: 'text', required: true },
  { id: 'f-city', name: 'city', label: 'City', type: 'text', required: true },
  {
    // Added 28 Sep 2026 (the owner's list): free text, optional — many
    // countries have no state or province in an address.
    id: 'f-state-province',
    name: 'stateProvince',
    label: 'State / Province',
    type: 'text',
    required: false,
    hint: 'Leave blank if your address has none',
  },
  {
    id: 'f-postal-code',
    name: 'postalCode',
    label: 'Postal / ZIP code',
    type: 'text',
    required: false,
    hint: 'Leave blank if your address has none',
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
  icon: string;
  /** The default wording. The broker may reword it; the title is fixed. */
  description: string;
  /** Personal Information and Identity Document: a verification is these. */
  alwaysOn: boolean;
  /** The kind of catalogue document the step collects, when it collects one. */
  documents?: 'identity' | 'address';
}

export const CORE_STEPS: readonly CoreStep[] = [
  {
    slug: 'personal',
    title: 'Personal Information',
    icon: 'User',
    description: 'Legal identity details exactly as they appear on your government ID.',
    alwaysOn: true,
  },
  {
    slug: 'document',
    title: 'Identity Document',
    icon: 'FileText',
    description: 'Upload a valid Passport, National ID, Driving License or Residence Permit.',
    alwaysOn: true,
    documents: 'identity',
  },
  {
    slug: 'selfie',
    title: 'Selfie Verification',
    icon: 'Camera',
    description: 'Live selfie photo matching your identity document.',
    alwaysOn: false,
  },
  {
    slug: 'address',
    title: 'Proof of Address',
    icon: 'Home',
    description: 'Document dated within the last 3 months showing your residential address.',
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
    type: documentFieldType(doc.value),
    required: false,
  };
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
 * A step as every reader sees it: the platform's parts rebuilt from code, the
 * broker's parts exactly as stored.
 *
 *  - a built-in step takes its fixed title and icon, is marked `core`, and an
 *    always-on one is enabled whatever a row says;
 *  - Personal Information opens with the nine identity fields (`system`), then
 *    the broker's questions — a profile key stored by an older build is dropped
 *    rather than shown twice;
 *  - the selfie step opens with its camera (`system`);
 *  - a document step lists its accepted documents, rebuilt from their types.
 */
export function platformStep<S extends FormStep>(step: S): S {
  const core = coreStepOf(step.slug);
  if (!core) return { ...step, core: false, alwaysOn: false };

  const own = step.fields.filter((field) => !isPlatformField(core.slug, field));
  const platform: FormField[] =
    core.slug === 'personal'
      ? IDENTITY_FIELDS.map((field) => ({ ...field, system: true }))
      : core.slug === 'selfie'
        ? [{ ...SELFIE_FIELD, system: true }]
        : acceptedDocuments(step.fields, core.documents!).map(documentField);
  return {
    ...step,
    title: core.title,
    icon: core.icon,
    enabled: core.alwaysOn ? true : step.enabled,
    core: true,
    alwaysOn: core.alwaysOn,
    // The platform's fields are plain `FormField`s; the caller's field type is a
    // structural superset whose extra members are all optional.
    fields: [...(platform as S['fields']), ...own],
  };
}

/**
 * A step as it is STORED: the platform's parts reduced to the one fact each
 * carries, or dropped entirely.
 *
 * The identity fields and the selfie camera are not stored at all; a document
 * field keeps only its type (its id, name and label follow from it); a built-in
 * step's title and icon are the platform's. The flags `core`, `alwaysOn` and
 * `system` describe the served form and never reach a row.
 */
export function storedStep<S extends FormStep>(step: S): S {
  const { core: _core, alwaysOn: _alwaysOn, ...rest } = step;
  const unflagged = rest.fields.map(({ system: _system, ...field }) => field);
  const spec = coreStepOf(step.slug);
  if (!spec) return { ...rest, fields: unflagged } as S;

  const own = unflagged.filter((field) => !isPlatformField(spec.slug, field));
  const documents: FormField[] = spec.documents
    ? acceptedDocuments(unflagged, spec.documents).map(documentField)
    : [];
  return {
    ...rest,
    title: spec.title,
    icon: spec.icon,
    enabled: spec.alwaysOn ? true : step.enabled,
    fields: [...documents, ...own],
  } as S;
}

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
 * Personal Information first, every other step in its own order, numbered
 * from one — the order a client meets them in. The identity every later step
 * is checked against is collected before anything is checked against it.
 */
export function inFormOrder<S extends FormStep>(steps: readonly S[]): S[] {
  const personal = steps.filter((step) => step.slug === 'personal');
  const rest = steps.filter((step) => step.slug !== 'personal');
  return [...personal, ...rest].map((step, index) => ({ ...step, stepNumber: index + 1 }));
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
  return label
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');
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

/** What the platform already collects under this label, or `undefined`. */
export function platformMeaningOf(label: string): string | undefined {
  const normalised = normaliseLabel(label);
  return PLATFORM_LABELS.get(normalised) ?? DOCUMENT_PAGE_LABELS.get(normalised);
}

/** A built-in step's title, if a broker's step is trying to wear it. */
export function coreTitleMatching(title: string): string | undefined {
  const wanted = normaliseLabel(title);
  return CORE_STEPS.find((step) => normaliseLabel(step.title) === wanted)?.title;
}
