/**
 * The details sign-up REQUIRES besides the name, email and password (the owner's
 * ruling, 26 Sep 2026 — `REGISTRATION_REQUIRED`): date of birth, nationality,
 * phone and country of residence. Spread into every test registration, so a
 * spec states the person it registers without restating the rule.
 */
export const SIGN_UP_DETAILS = {
  dateOfBirth: '1990-04-12',
  nationality: 'Lebanese',
  phone: '+96170123456',
  country: 'Lebanon',
} as const;
