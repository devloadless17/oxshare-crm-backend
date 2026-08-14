import { describe, expect, it } from 'vitest';
import { filenameFromStored, objectKey, storedPath } from './storage-key';

/**
 * The key scheme.
 *
 * These are the cheapest tests in the codebase and they protect the most: the whole
 * reason the R2 move needed no frontend change and no data migration is that a
 * stored path, a served URL and an object key differ by exactly one segment. If that
 * mirror breaks, KYC documents 404 for everyone and the fix is a migration over the
 * compliance record.
 */

describe('objectKey', () => {
  it('is the bucket directory joined to the filename', () => {
    expect(objectKey('kyc', '9f2c.jpg')).toBe('kyc/9f2c.jpg');
    expect(objectKey('avatars', 'a.png')).toBe('avatars/a.png');
    expect(objectKey('payment-logos', 'b.svg')).toBe('payment-logos/b.svg');
  });

  /*
   * Traversal is neutralised where the key is BUILT, not at each call site.
   *
   * Callers usually match the name against a database column first, but a path check
   * that lives in one place is one somebody routes around by adding a second caller.
   */
  it('strips any directory a caller managed to include', () => {
    expect(objectKey('kyc', '../../etc/passwd')).toBe('kyc/passwd');
    expect(objectKey('kyc', '/absolute/x.jpg')).toBe('kyc/x.jpg');
    expect(objectKey('kyc', 'nested/dir/x.jpg')).toBe('kyc/x.jpg');
  });

  it('refuses names that cannot yield a safe key', () => {
    expect(() => objectKey('kyc', '')).toThrow();
    expect(() => objectKey('kyc', '.')).toThrow();
    expect(() => objectKey('kyc', '..')).toThrow();
    // A leading dot is refused rather than stored: `.env` in a bucket we serve from
    // is not a file we ever wrote.
    expect(() => objectKey('kyc', '.hidden')).toThrow();
  });
});

describe('storedPath', () => {
  /*
   * ⚠️ This exact shape is what multer's `diskStorage` produced before object
   * storage, and it is what the frontends' URL builders normalise. Changing it turns
   * a code change into a data migration over `kyc_submissions`.
   */
  it('matches the shape written before the R2 move', () => {
    expect(storedPath('kyc', '9f2c.jpg')).toBe('uploads/kyc/9f2c.jpg');
  });

  it('is the object key with the API route prefix in front', () => {
    const filename = 'abc.pdf';
    expect(storedPath('kyc', filename)).toBe(`uploads/${objectKey('kyc', filename)}`);
  });
});

describe('filenameFromStored', () => {
  /*
   * Every shape that is genuinely in the database. All of these have been written at
   * some point, and the admin app's `buildKycDocUrl` normalises the same set — this
   * is the backend half of that contract.
   */
  it('recovers the filename from every shape the database holds', () => {
    expect(filenameFromStored('uploads/kyc/x.jpg')).toBe('x.jpg');
    expect(filenameFromStored('./uploads/kyc/x.jpg')).toBe('x.jpg');
    expect(filenameFromStored('/uploads/kyc/x.jpg')).toBe('x.jpg');
    // Windows separators — written when the API ran on a Windows host.
    expect(filenameFromStored('uploads\\kyc\\x.jpg')).toBe('x.jpg');
    // Avatars and logos store a bare filename, not a path.
    expect(filenameFromStored('x.jpg')).toBe('x.jpg');
  });

  it('returns null rather than guessing, so callers 404', () => {
    expect(filenameFromStored(null)).toBeNull();
    expect(filenameFromStored(undefined)).toBeNull();
    expect(filenameFromStored('')).toBeNull();
    expect(filenameFromStored('uploads/kyc/')).toBeNull();
    expect(filenameFromStored('.')).toBeNull();
  });

  /*
   * The round trip that the ownership checks depend on.
   *
   * `submissionReferencesFile` and `assertDocumentInScope` compare `basename(path)`
   * against a requested filename. If these two ever disagreed, a client would be
   * refused access to their own document — silently, because the file is still there
   * and still readable by any reviewing admin.
   */
  it('round-trips with storedPath', () => {
    const filename = 'd1e2f3a4.pdf';
    expect(filenameFromStored(storedPath('kyc', filename))).toBe(filename);
  });
});
