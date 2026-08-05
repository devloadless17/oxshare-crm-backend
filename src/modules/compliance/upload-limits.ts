/**
 * The KYC upload size ceiling, declared once.
 *
 * It lives in its own module because three places need to agree on it and two
 * of them are not the controller: `kyc.controller.ts` enforces it (in multer's
 * `limits`, which is what actually stops the bytes, and again in the
 * `ParseFilePipe` as a second line), and `upload-size.filter.ts` quotes it back
 * to the client in the 413. Importing the filter from the controller and the
 * constant from the filter would be a cycle; a leaf module is the way out.
 *
 * Deliberately not configuration. It is a documented assumption — no
 * authoritative document states a maximum document size — and a limit that can
 * drift per environment is a limit whose error message can be wrong.
 */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
