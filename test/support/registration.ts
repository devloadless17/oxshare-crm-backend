let phoneSeq = 0;

/**
 * A valid, never-repeated E.164 phone (Lebanese mobile range `+96171…`).
 *
 * One client per phone since 0194 (`users_phone_unique`), so a spec that makes
 * more than one client must give each its own number.
 */
export function uniqueTestPhone(): string {
  phoneSeq += 1;
  return `+96171${String(phoneSeq).padStart(6, '0')}`;
}

/**
 * The details sign-up REQUIRES besides the name, email and password (the owner's
 * ruling, 26 Sep 2026 — `REGISTRATION_REQUIRED`): date of birth, nationality,
 * phone and country of residence. Spread into every test registration, so a
 * spec states the person it registers without restating the rule.
 *
 * `phone` is a GETTER: each spread copies a fresh number, so two registrations
 * in one spec never collide on `users_phone_unique`.
 */
export const SIGN_UP_DETAILS = {
  dateOfBirth: '1990-04-12',
  nationality: 'Lebanese',
  get phone(): string {
    return uniqueTestPhone();
  },
  country: 'Lebanon',
};
