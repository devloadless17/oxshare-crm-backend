import type { Session } from '../http-setup';

/**
 * A client's KYC document, sent the way the portal sends one.
 *
 * `/kyc/step` used to accept file paths, and these journeys used that to stand
 * in for uploading — pointing a submission at `/uploads/kyc/j1-passport.png`,
 * a file that never existed. That was a hole, not a shortcut: the same merge let
 * a client point their submission at any stored file, including another
 * client's passport, and it is closed (`src/modules/compliance/kyc-answers.ts`).
 * So the journeys now do what a client does — upload bytes to `/kyc/upload`,
 * naming the document each page belongs to.
 */

/** Starts with the PNG signature, which is what the upload route checks. */
export const KYC_TEST_PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(2048, 1),
]);

export function uploadKycFile(session: Session, field: string, docType?: string) {
  const req = session.post('/v1/kyc/upload', undefined).field('field', field);
  if (docType) req.field('docType', docType);
  return req.attach('file', KYC_TEST_PNG, { filename: `${field}.png`, contentType: 'image/png' });
}

/** Passport, selfie and a utility bill — the three uploads a seeded flow asks for. */
export async function uploadStandardKycDocuments(session: Session): Promise<void> {
  for (const [field, docType] of [
    ['doc_front', 'passport'],
    ['selfie', undefined],
    ['address_proof', 'utility_bill'],
  ] as const) {
    const res = await uploadKycFile(session, field, docType);
    if (res.status >= 400) throw new Error(`upload ${field}: ${JSON.stringify(res.body)}`);
  }
}
