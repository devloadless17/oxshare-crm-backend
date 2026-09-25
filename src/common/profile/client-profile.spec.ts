import { describe, expect, it } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { users } from '../../database/schema';
import {
  ageInYears,
  checkProfile,
  deskLocks,
  firstProfileError,
  isProfileKey,
  KYC_CORRECTABLE_KEYS,
  MINIMUM_AGE_YEARS,
  normaliseProfileValue,
  parseCalendarDate,
  PROFILE_CHOICES,
  PROFILE_FIELD_KEYS,
  PROFILE_FIELD_TYPE,
  PROFILE_MAX_LENGTH,
  toE164,
  type ProfileKey,
} from './client-profile';

/**
 * THE RULES EVERY WRITER OF A CLIENT'S IDENTITY OBEYS (0139).
 *
 * Registration, the KYC personal step, the support desk and a reviewer's
 * correction all pass through `checkProfile`, so each rule here is the rule
 * everywhere — which is the point: "t1" at registration and "test1" in KYC was
 * two write paths with two sets of rules, and a client ended up holding both.
 *
 * The cases are the values people actually type, and the values that have to
 * survive: names from every script the broker's market writes in, numbers in
 * every shape a phone keyboard produces, the leap-day birthday.
 */

const AS_OF = new Date(Date.UTC(2026, 8, 25)); // 25 Sep 2026
const one = (key: ProfileKey, value: string) => normaliseProfileValue(key, value, AS_OF);
const ok = (key: ProfileKey, value: string) => {
  const outcome = one(key, value);
  if (!outcome.ok) throw new Error(`${key}=${JSON.stringify(value)} refused: ${outcome.message}`);
  return outcome.value;
};
const refused = (key: ProfileKey, value: string) => !one(key, value).ok;

describe('the profile is described once, and consistently', () => {
  it('fits every value in its column — a refusal here, never a database error there', () => {
    // The seam's lengths ARE the schema's. A column narrowed by a migration
    // without this list following would pass every check and fail the INSERT.
    const columns = new Map(getTableConfig(users).columns.map((c) => [c.name, c]));
    const snake = (key: string) => key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
    for (const key of PROFILE_FIELD_KEYS) {
      const column = columns.get(snake(key));
      expect(column, `users.${snake(key)} exists`).toBeDefined();
      if (key === 'dateOfBirth') {
        expect(column!.getSQLType()).toBe('date');
        continue;
      }
      // The column's own SQL type — `varchar(100)` — so a narrowed column fails here.
      expect(column!.getSQLType(), key).toBe(`varchar(${PROFILE_MAX_LENGTH[key]})`);
    }
  });

  it('names a builder type for every field, and a choice list for every drop-down', () => {
    for (const key of PROFILE_FIELD_KEYS) {
      expect(PROFILE_FIELD_TYPE[key], key).toMatch(/^(text|date|select|phone)$/);
      expect(Boolean(PROFILE_CHOICES[key]), key).toBe(PROFILE_FIELD_TYPE[key] === 'select');
    }
  });

  it('knows its own keys by OWN name only', () => {
    expect(PROFILE_FIELD_KEYS.every(isProfileKey)).toBe(true);
    for (const key of ['constructor', 'toString', '__proto__', 'Phone', 'email', '']) {
      expect(isProfileKey(key), key).toBe(false);
    }
  });

  it('lets a correction touch only profile fields, and never a name', () => {
    expect(KYC_CORRECTABLE_KEYS.every(isProfileKey)).toBe(true);
    expect(KYC_CORRECTABLE_KEYS).not.toContain('firstName');
    expect(KYC_CORRECTABLE_KEYS).not.toContain('lastName');
    expect(KYC_CORRECTABLE_KEYS).not.toContain('nationality');
  });
});

describe('a name is somebody’s legal name, as their ID prints it', () => {
  it.each([
    "O'Brien",
    'O’Brien',
    'Jean-Luc',
    'St. John',
    'de la Cruz',
    'Nuñez',
    'ALI',
    'McDonald',
    'محمد',
    'عبد الله',
    'Łukasz',
    'Đặng',
    'Ναταλία',
    'Ханна',
  ])('accepts %s, unchanged', (name) => {
    expect(ok('firstName', name)).toBe(name.normalize('NFC'));
  });

  it('never re-cases a name — "ALI" and "de la Cruz" stay exactly as typed', () => {
    expect(ok('lastName', 'de la Cruz')).toBe('de la Cruz');
    expect(ok('firstName', 'ALI')).toBe('ALI');
  });

  it.each(['t1', 'test1', 'Jane2', '@dmin', '-Jane', "'Jane", 'Jane<script>', 'J@ne', '😀', '12'])(
    'refuses %s — a test value, not a legal name',
    (name) => {
      expect(refused('firstName', name)).toBe(true);
    },
  );

  it('collapses whitespace and composes accents, so one name is one string', () => {
    expect(ok('firstName', '  Jane   Mary  ')).toBe('Jane Mary');
    // "é" typed as e + combining acute is the same name as the composed "é".
    expect(ok('lastName', 'René')).toBe('René');
  });

  it('refuses a control character hidden inside a name', () => {
    expect(refused('firstName', 'Ja\u0000ne')).toBe(true);
    expect(refused('lastName', 'Doe\u0085')).toBe(true);
  });

  it('refuses a name longer than its column', () => {
    expect(ok('firstName', 'A'.repeat(PROFILE_MAX_LENGTH.firstName))).toHaveLength(100);
    expect(refused('firstName', 'A'.repeat(PROFILE_MAX_LENGTH.firstName + 1))).toBe(true);
  });
});

describe('a date of birth is a real day, in the past, of an adult', () => {
  it('accepts an ordinary date, unchanged', () => {
    expect(ok('dateOfBirth', '1990-06-15')).toBe('1990-06-15');
  });

  it.each(['1990-02-30', '1990-13-01', '1990-00-10', '1990-1-1', '15/06/1990', 'next spring', ''])(
    'refuses %s — not a real calendar day in YYYY-MM-DD',
    (value) => {
      expect(refused('dateOfBirth', value)).toBe(true);
    },
  );

  it('refuses a future date', () => {
    expect(one('dateOfBirth', '2030-01-01')).toMatchObject({ ok: false, message: /future/ });
  });

  it('turns 18 ON the birthday, not a day before', () => {
    expect(ok('dateOfBirth', '2008-09-25')).toBe('2008-09-25'); // 18 today
    expect(one('dateOfBirth', '2008-09-26')).toMatchObject({
      ok: false,
      message: new RegExp(`at least ${MINIMUM_AGE_YEARS}`),
    });
  });

  it('treats a leap-day birthday by the calendar, never by dividing days', () => {
    const born = parseCalendarDate('2008-02-29')!;
    expect(ageInYears(born, new Date(Date.UTC(2026, 1, 28)))).toBe(17);
    expect(ageInYears(born, new Date(Date.UTC(2026, 2, 1)))).toBe(18);
  });

  it('refuses an age no living person has — a typo in the year', () => {
    expect(one('dateOfBirth', '1850-01-01')).toMatchObject({ ok: false, message: /year/ });
    expect(ok('dateOfBirth', '1910-01-01')).toBe('1910-01-01');
  });
});

describe('a phone number is stored in ONE shape, whatever was typed', () => {
  it.each([
    ['+961 70 123 456', '+96170123456'],
    ['+96170123456', '+96170123456'],
    ['+971 (50) 123-4567', '+971501234567'],
    ['+44 20 7946 0958', '+442079460958'],
    ['+966 50 123 4567', '+966501234567'],
  ])('stores %s as %s', (typed, stored) => {
    expect(ok('phone', typed)).toBe(stored);
  });

  it.each([
    '70123456',
    '0096170123456',
    '+961 70 12',
    '+961',
    '+',
    'call me',
    '+961 70 123 456 789',
  ])('refuses %s — not a number anyone can dial', (typed) => {
    expect(refused('phone', typed)).toBe(true);
  });

  it('makes the same number typed two ways the same value — no change at all', () => {
    expect(toE164('+961 70 123 456')).toBe(toE164('+961-70-123-456'));
  });
});

describe('a country or nationality is one of the platform’s own', () => {
  it('accepts the list’s spelling, and only that', () => {
    expect(ok('country', 'Lebanon')).toBe('Lebanon');
    expect(ok('country', 'United Arab Emirates')).toBe('United Arab Emirates');
    for (const value of ['lebanon', 'LB', 'UAE', 'Lebanon ', 'Atlantis']) {
      if (value === 'Lebanon ') {
        // Surrounding space is tidied, not refused.
        expect(ok('country', value)).toBe('Lebanon');
        continue;
      }
      expect(refused('country', value), value).toBe(true);
    }
  });

  it('asks for a nationality as a demonym — "Lebanon" is a country, not a nationality', () => {
    expect(ok('nationality', 'Lebanese')).toBe('Lebanese');
    expect(one('nationality', 'Lebanon')).toMatchObject({ ok: false, message: /nationality/ });
  });

  it('holds the legal exclusion the list carries', () => {
    expect(refused('country', 'Israel')).toBe(true);
    expect(refused('nationality', 'Israeli')).toBe(true);
  });

  it('accepts every entry the served lists offer — a choice the form shows is always storable', () => {
    for (const key of ['country', 'nationality'] as const) {
      for (const choice of PROFILE_CHOICES[key]!) expect(ok(key, choice)).toBe(choice);
    }
  });
});

describe('an address is a place', () => {
  it('accepts a street address, a city with a number in it, and a postal code', () => {
    expect(ok('address', 'Hamra Street, Building 12, 3rd floor')).toBe(
      'Hamra Street, Building 12, 3rd floor',
    );
    expect(ok('address', 'P.O. Box 11-2020')).toBe('P.O. Box 11-2020');
    expect(ok('city', '6th of October City')).toBe('6th of October City');
    expect(ok('city', 'Dubai')).toBe('Dubai');
  });

  it('refuses what cannot be an address', () => {
    expect(refused('address', 'ab')).toBe(true);
    expect(refused('address', '!!!')).toBe(true);
    expect(refused('address', 'x'.repeat(201))).toBe(true);
    expect(refused('city', '12345')).toBe(true);
    expect(refused('city', 'Bei<rut>')).toBe(true);
  });

  it.each([
    ['1103', '1103'],
    ['sw1a 1aa', 'SW1A 1AA'],
    ['1100-2080', '1100-2080'],
    ['10001', '10001'],
    ['a', 'A'],
  ])('stores the postal code %s as %s', (typed, stored) => {
    expect(ok('postalCode', typed)).toBe(stored);
  });

  it.each(['-1103', '1103-', '1103_20', '12345678901234', 'SW1A  1AA#'])(
    'refuses the postal code %s',
    (typed) => {
      expect(refused('postalCode', typed)).toBe(true);
    },
  );
});

describe('checkProfile — absent is untouched, blank is cleared, names never are', () => {
  it('leaves a field the caller did not send alone', () => {
    const check = checkProfile({ city: 'Beirut' }, { asOf: AS_OF });
    expect(check.values).toEqual({ city: 'Beirut' });
    expect(check.errors).toEqual({});
  });

  it('clears a blank optional field, as an explicit null', () => {
    const check = checkProfile({ postalCode: '   ', phone: '' }, { asOf: AS_OF });
    expect(check.values).toEqual({ postalCode: null, phone: null });
  });

  it('never clears a name, whoever asks', () => {
    const check = checkProfile({ firstName: '', lastName: ' ' }, { asOf: AS_OF });
    expect(check.errors.firstName).toMatch(/required/);
    expect(check.errors.lastName).toMatch(/required/);
  });

  it('refuses a required field that is blank OR missing', () => {
    const check = checkProfile(
      { firstName: 'Jane', lastName: 'Doe', country: '' },
      { required: ['firstName', 'lastName', 'country', 'dateOfBirth'], asOf: AS_OF },
    );
    expect(Object.keys(check.errors).sort()).toEqual(['country', 'dateOfBirth']);
  });

  it('refuses a value that is not text at all', () => {
    const check = checkProfile({ firstName: 42, phone: ['+961'] }, { asOf: AS_OF });
    expect(check.errors.firstName).toMatch(/must be text/);
    expect(check.errors.phone).toMatch(/must be text/);
  });

  it('reports every field at once, and names the first in form order', () => {
    const check = checkProfile(
      { postalCode: '#', firstName: 't1', dateOfBirth: '2020-01-01' },
      { asOf: AS_OF },
    );
    expect(Object.keys(check.errors).sort()).toEqual(['dateOfBirth', 'firstName', 'postalCode']);
    expect(firstProfileError(check.errors)).toBe(check.errors.firstName);
  });

  it('ignores keys that are not profile fields — they are not its business', () => {
    const check = checkProfile(
      { firstName: 'Jane', email: 'x@y.z', customField_1: 'Acme' } as Record<string, unknown>,
      { asOf: AS_OF },
    );
    expect(check.values).toEqual({ firstName: 'Jane' });
  });
});

describe('deskLocks — what the support desk may change, by where the verification is', () => {
  const ALL = [...PROFILE_FIELD_KEYS];

  it.each([undefined, 'not_started', 'in_progress', 'rejected'])(
    'locks nothing while the verification is the client’s own (%s)',
    (status) => {
      expect(deskLocks(ALL, status)).toEqual({});
    },
  );

  it.each(['submitted', 'under_review'])(
    'locks everything but the phone while a reviewer is checking it (%s)',
    (status) => {
      const locked = deskLocks(ALL, status);
      expect(Object.keys(locked).sort()).toEqual(ALL.filter((k) => k !== 'phone').sort());
      expect(locked.firstName).toMatch(/checked against the client's documents/);
    },
  );

  it('once approved, sends the date of birth and address to the correction, the rest to a new verification', () => {
    const locked = deskLocks(ALL, 'approved');
    expect(locked.phone).toBeUndefined();
    for (const key of KYC_CORRECTABLE_KEYS) expect(locked[key], key).toMatch(/KYC review/);
    for (const key of ['firstName', 'lastName', 'nationality', 'country'] as const) {
      expect(locked[key], key).toMatch(/new verification/);
    }
  });

  it('only ever judges the fields that are CHANGING', () => {
    expect(deskLocks(['phone'], 'approved')).toEqual({});
    expect(Object.keys(deskLocks(['city'], 'submitted'))).toEqual(['city']);
  });
});
