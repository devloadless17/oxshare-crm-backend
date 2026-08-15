/**
 * The documents this system knows how to collect, and what collecting one
 * involves.
 *
 * ## Why a catalogue rather than per-field configuration
 *
 * "A passport is one photo page" is a fact about passports, not a decision an
 * operator makes per step. Asking them to re-enter it on every field that
 * accepts a passport is how the front/back pairing drifts apart between two
 * steps and how a slot ends up labelled "Page 2" on a document that has one
 * page.
 *
 * So the shape lives here once, and a `document` field names which entries it
 * accepts. Adding "Residence Permit" to a step becomes ticking a box.
 *
 * ## Why the parts hang off the document
 *
 * Researched against Sumsub, Onfido, Persona, Veriff, Jumio, Stripe Identity
 * and Trulioo (Aug 2026). Every one models the side as an axis ORTHOGONAL to
 * the document type — Sumsub's `idDocSubType`, Onfido's `side`, Jumio's
 * "parts", Persona's per-type front/back/barcode checkboxes. None encodes it in
 * the type enum; there is no `ID_CARD_FRONT` anywhere.
 *
 * Only Sumsub and Jumio publish the requirement as API data. The other four
 * hard-code it inside their own hosted widget — which is exactly why they ship
 * a widget, and exactly what this system cannot do, because the operator
 * defines the flow here.
 *
 * An ordered `parts` ARRAY rather than a `sides: 2` count, because a count
 * carries no label: "Photo Page" and "Back Side" are different questions and a
 * UI handed `2` has to invent both. `required` per part covers the genuinely
 * optional sheet — a tenancy agreement's second page — without a second
 * mechanism.
 */

export interface DocumentPart {
  /** Stable within the document. Also the upload slot suffix. */
  key: string;
  label: string;
  required: boolean;
  hint?: string;
}

export interface CatalogueDocument {
  /** Stored in `document.docType` / `addressProof.docType`. Never renamed. */
  value: string;
  label: string;
  /** Which kind of proof this satisfies — the builder groups by it. */
  category: 'identity' | 'address';
  parts: DocumentPart[];
}

/**
 * The values here are the ones already written to `kyc_submissions` —
 * `passport`, `national_id`, `driving_license`, `utility_bill`,
 * `bank_statement`, `tenancy_agreement`. Renaming one orphans every submission
 * that chose it, so they are append-only.
 */
export const DOCUMENT_CATALOGUE: readonly CatalogueDocument[] = [
  {
    value: 'passport',
    label: 'Passport',
    category: 'identity',
    // ONE part. A passport has no back to photograph, and asking for one is a
    // question the client cannot answer.
    parts: [
      {
        key: 'front',
        label: 'Photo Page',
        required: true,
        hint: 'The page with your photo and details',
      },
    ],
  },
  {
    value: 'national_id',
    label: 'National ID',
    category: 'identity',
    parts: [
      { key: 'front', label: 'Front Side', required: true },
      { key: 'back', label: 'Back Side', required: true },
    ],
  },
  {
    value: 'driving_license',
    label: 'Driving License',
    category: 'identity',
    parts: [
      { key: 'front', label: 'Front Side', required: true },
      { key: 'back', label: 'Back Side', required: true },
    ],
  },
  {
    value: 'residence_permit',
    label: 'Residence Permit',
    category: 'identity',
    parts: [
      { key: 'front', label: 'Front Side', required: true },
      { key: 'back', label: 'Back Side', required: true },
    ],
  },
  {
    value: 'utility_bill',
    label: 'Utility Bill',
    category: 'address',
    parts: [
      {
        key: 'front',
        label: 'The Bill',
        required: true,
        hint: 'Must show your name, address and a date in the last 3 months',
      },
    ],
  },
  {
    value: 'bank_statement',
    label: 'Bank Statement',
    category: 'address',
    parts: [
      {
        key: 'front',
        label: 'The Statement',
        required: true,
        hint: 'Must show your name, address and a date in the last 3 months',
      },
    ],
  },
  {
    value: 'tenancy_agreement',
    label: 'Tenancy Agreement',
    category: 'address',
    parts: [
      { key: 'front', label: 'Signature Page', required: true },
      // The one optional slot in the catalogue, and the reason `required` lives
      // per part rather than per document.
      {
        key: 'back',
        label: 'Additional Page',
        required: false,
        hint: 'Only if your address is on a separate page',
      },
    ],
  },
] as const;

/**
 * The field TYPE that collects this document — `doc:passport`.
 *
 * Prefixed so a document type can never collide with a base type (`text`,
 * `date`), and so any code reading a config can tell the two apart with a
 * `startsWith` rather than by consulting the catalogue.
 */
export function documentFieldType(value: string): string {
  return `${DOCUMENT_TYPE_PREFIX}${value}`;
}

export const DOCUMENT_TYPE_PREFIX = 'doc:';

/** The catalogue entry a field type collects, or `undefined` for a base type. */
export function documentForFieldType(type: string | undefined): CatalogueDocument | undefined {
  if (!type?.startsWith(DOCUMENT_TYPE_PREFIX)) return undefined;
  return catalogueDocument(type.slice(DOCUMENT_TYPE_PREFIX.length));
}

/** Lookup by stored value. `undefined` for a document no longer offered. */
export function catalogueDocument(value: string): CatalogueDocument | undefined {
  return DOCUMENT_CATALOGUE.find((entry) => entry.value === value);
}

/**
 * The documents a `document` field accepts, resolved to their full shape.
 *
 * A field stores VALUES only (`['passport', 'national_id']`), so the parts
 * cannot drift out of step with the catalogue. An unknown value is dropped
 * rather than throwing: a catalogue entry withdrawn after a step was configured
 * should stop being offered, not break the step.
 */
export function resolveAcceptedDocuments(
  values: readonly string[] | undefined,
): CatalogueDocument[] {
  return (values ?? [])
    .map((value) => catalogueDocument(value))
    .filter((entry): entry is CatalogueDocument => entry !== undefined);
}
