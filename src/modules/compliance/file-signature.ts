/**
 * MOVED to `src/common/uploads/file-signature.ts`.
 *
 * It was written for KYC documents and lived under `modules/compliance`, but
 * the question it answers — "is this file plausibly the type it claims" — is
 * not a compliance question. Profile photos need the same answer, and a second
 * copy would mean two ideas of what is safe to store, diverging the first time
 * one of them learns about a new format.
 *
 * Re-exported from here so `file-signature.spec.ts` and the KYC controller keep
 * their imports. Delete this file once those point at the new home.
 */
export { SIGNATURE_BYTES, sniffMimeType, signatureMatchesDeclared } from '../../common/uploads/file-signature';
