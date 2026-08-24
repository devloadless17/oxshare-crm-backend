/**
 * Fill a NON-PRODUCTION database with enough data to find out what is slow.
 *
 * ## What this is for
 *
 * Every screen in the console was built and reviewed against a few dozen rows.
 * That is the one dataset where nothing is slow: no index is missed, no N+1 is
 * visible, no unpaginated list hurts, and a count(*) over the whole table is
 * instant. This creates twenty thousand clients and the traffic around them so
 * those questions have real answers.
 *
 * ## Everything it writes is MARKED and REVERSIBLE
 *
 * This codebase has already been bitten once by invented data that could not be
 * told apart from real data afterwards — `purge-fake-trading-accounts.mjs`
 * exists because of it. So every row here carries a marker that no genuine row
 * can accidentally match:
 *
 *   users                 email @{SEED_DOMAIN}
 *   client_tags           slug  seed-*
 *   roles / api_keys      name  "Seed *"
 *   trading_products      name  "Seed *", groups seed\*
 *   payment_methods       key   seed-*
 *   trading_accounts      login SEED-*        (real MT5 logins are numeric)
 *
 * `--purge` removes exactly those and nothing else, in dependency order.
 *
 * ## Two things it deliberately does NOT do
 *
 *  - It never touches `ib_levels`. The payout ladder is real configuration with
 *    real partners standing on it, and renumbering levels cascades.
 *  - Seeded PRODUCTS and PAYMENT METHODS are created DISABLED. Both drive live
 *    client journeys — a product is offered in the portal's account-opening
 *    dialog and a payment method in the deposit flow — and a seeded one points
 *    at an MT5 group and a provider that do not exist. Disabled, they still
 *    fill the admin tables they are here to stress, and no client can reach
 *    them.
 *
 * Seeded clients get an UNUSABLE password hash. Twenty thousand accounts with a
 * known password is a liability that outlives the afternoon it was convenient.
 *
 * Usage:
 *   node scripts/seed-load-test.mjs                 # plan only, writes nothing
 *   node scripts/seed-load-test.mjs --apply
 *   node scripts/seed-load-test.mjs --apply --clients 50000
 *   node scripts/seed-load-test.mjs --purge --apply
 */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const value = (flag, fallback) => {
  const at = argv.indexOf(flag);
  return at >= 0 && argv[at + 1] ? Number.parseInt(argv[at + 1], 10) : fallback;
};

const APPLY = has('--apply');
const PURGE = has('--purge');
const CLIENTS = value('--clients', 20_000);

/** Marks every row this script creates. Chosen so no real address can match. */
const SEED_DOMAIN = 'loadtest.invalid';

/*
 * `.invalid` is reserved by RFC 2606 and can never be registered, so a seeded
 * address can never collide with a client's and can never receive mail if
 * something tries to send to one.
 */
const UNUSABLE_HASH = '$2b$12$seedseedseedseedseedseedseedseedseedseedseedseedseedse';

const BATCH = 1_000;

const db = new pg.Client({ connectionString: process.env.DATABASE_URL });

/** Refuse to run anywhere that looks like production, whatever the flags say. */
function assertNotProduction() {
  const url = process.env.DATABASE_URL ?? '';
  const env = process.env.NODE_ENV ?? 'development';

  if (env === 'production') {
    throw new Error('NODE_ENV=production. This script does not run against production.');
  }
  if (/\b(prod|production)\b/i.test(url)) {
    throw new Error(`DATABASE_URL names a production database: ${redact(url)}`);
  }
}

const redact = (url) => url.replace(/\/\/[^@]*@/, '//***@');

/** Multi-row insert in batches, so 20k rows is 20 round trips rather than 20k. */
async function insertMany(table, columns, rows, { onConflict = '' } = {}) {
  let written = 0;
  for (let at = 0; at < rows.length; at += BATCH) {
    const slice = rows.slice(at, at + BATCH);
    const params = [];
    const tuples = slice.map((row) => {
      const placeholders = row.map((cell) => {
        params.push(cell);
        return `$${params.length}`;
      });
      return `(${placeholders.join(',')})`;
    });

    const result = await db.query(
      `INSERT INTO ${table} (${columns.join(',')}) VALUES ${tuples.join(',')} ${onConflict}`,
      params,
    );
    written += result.rowCount ?? 0;
  }
  return written;
}

const pick = (list, at) => list[at % list.length];
const money = (whole, cents = 0) => `${whole}.${String(cents).padStart(2, '0')}`;

/*
 * Dates spread across the past two years, DERIVED from the row index rather
 * than random. A seeded dataset that differs run to run makes "is this slower
 * than yesterday" unanswerable, and the charts this feeds are read by date.
 */
const EPOCH = Date.UTC(2024, 0, 1);
const dayMs = 86_400_000;
const dateFor = (index, spreadDays = 730) =>
  new Date(EPOCH + ((index * 7919) % spreadDays) * dayMs + (index % 86_400) * 1_000);

async function purge() {
  const order = [
    ['ib_accruals', `client_user_id IN (SELECT id FROM users WHERE email LIKE '%@${SEED_DOMAIN}')`],
    [
      'ledger_entries',
      `wallet_id IN (SELECT w.id FROM wallets w JOIN users u ON u.id = w.user_id WHERE u.email LIKE '%@${SEED_DOMAIN}')`,
    ],
    ['transactions', `user_id IN (SELECT id FROM users WHERE email LIKE '%@${SEED_DOMAIN}')`],
    [
      'kyc_submission_attempts',
      `user_id IN (SELECT id FROM users WHERE email LIKE '%@${SEED_DOMAIN}')`,
    ],
    ['kyc_submissions', `user_id IN (SELECT id FROM users WHERE email LIKE '%@${SEED_DOMAIN}')`],
    ['ib_applications', `user_id IN (SELECT id FROM users WHERE email LIKE '%@${SEED_DOMAIN}')`],
    [
      'client_tag_assignments',
      `user_id IN (SELECT id FROM users WHERE email LIKE '%@${SEED_DOMAIN}')`,
    ],
    ['trading_accounts', `login LIKE 'SEED-%'`],
    ['wallets', `user_id IN (SELECT id FROM users WHERE email LIKE '%@${SEED_DOMAIN}')`],
    ['users', `email LIKE '%@${SEED_DOMAIN}'`],
    ['client_tags', `slug LIKE 'seed-%'`],
    ['trading_product_groups', `mt5_group LIKE 'seed\\\\%'`],
    ['trading_products', `name LIKE 'Seed %'`],
    ['payment_methods', `key LIKE 'seed-%'`],
    ['api_keys', `name LIKE 'Seed %'`],
    ['roles', `name LIKE 'Seed %'`],
  ];

  for (const [table, where] of order) {
    const { rowCount } = await db.query(`DELETE FROM ${table} WHERE ${where}`);
    console.log(`  ${table.padEnd(24)} ${rowCount} removed`);
  }
}

async function main() {
  assertNotProduction();
  await db.connect();

  console.log(`database : ${redact(process.env.DATABASE_URL ?? '')}`);
  console.log(
    `mode     : ${PURGE ? 'PURGE' : 'SEED'}${APPLY ? '' : '  (dry run — nothing is written)'}`,
  );

  if (PURGE) {
    if (!APPLY) {
      console.log('\nWould remove every row marked with the seed markers. Re-run with --apply.');
      return;
    }
    console.log('\n=== purging ===');
    await purge();
    return;
  }

  const wallets = Math.round(CLIENTS * 1.5);
  const txns = CLIENTS * 8;
  console.log(`
=== plan ===
  clients                ${CLIENTS.toLocaleString()}
  wallets                ~${wallets.toLocaleString()}
  transactions           ~${txns.toLocaleString()}  (a fifth of them pending)
  trading accounts       ~${Math.round(CLIENTS / 2).toLocaleString()}
  KYC submissions        ~${Math.round(CLIENTS * 0.6).toLocaleString()}
  partner applications   ~${Math.round(CLIENTS * 0.05).toLocaleString()}
  commission accruals    ~${Math.round(CLIENTS * 0.1).toLocaleString()}
  plus tags, roles, API keys, currencies, products, payment methods
`);

  if (!APPLY) {
    console.log('Dry run. Re-run with --apply to write it.');
    return;
  }

  const started = Date.now();
  const step = async (label, fn) => {
    const at = Date.now();
    const written = await fn();
    console.log(`  ${label.padEnd(24)} ${String(written).padStart(8)} rows  ${Date.now() - at}ms`);
  };

  console.log('=== writing ===');

  // ── Reference data first: everything below references it ─────────────────
  await step('currencies', async () => {
    const rows = [
      ['EUR', 'Euro', '€', 2, true, false, 10],
      ['GBP', 'British Pound', '£', 2, true, false, 11],
      ['AED', 'UAE Dirham', 'د.إ', 2, true, false, 12],
      ['TRY', 'Turkish Lira', '₺', 2, true, false, 13],
    ];
    return insertMany(
      'currencies',
      ['code', 'name', 'symbol', 'decimals', 'enabled', 'is_default', 'sort_order'],
      rows,
      { onConflict: 'ON CONFLICT (code) DO NOTHING' },
    );
  });

  const currencies = ['USD', 'EUR', 'GBP', 'AED'];

  await step('client tags', async () => {
    const labels = ['VIP', 'High risk', 'Dormant', 'Chargeback', 'Institutional', 'Newsletter'];
    return insertMany(
      'client_tags',
      ['id', 'slug', 'label', 'color', 'description'],
      labels.map((label, at) => [
        randomUUID(),
        `seed-${label.toLowerCase().replace(/\s+/g, '-')}`,
        label,
        pick(['#ef4444', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6'], at),
        'Created by the load-test seeder.',
      ]),
      { onConflict: 'ON CONFLICT (slug) DO NOTHING' },
    );
  });

  await step('roles', async () => {
    const defs = [
      ['Seed Support', ['clients.view', 'kyc.view']],
      ['Seed Dealer', ['trading.view', 'trading.create', 'wallets.view']],
      ['Seed Finance', ['wallets.view', 'withdrawals.view', 'withdrawals.approve']],
      ['Seed Read Only', ['clients.view']],
    ];
    return insertMany(
      'roles',
      ['id', 'name', 'description', 'permissions', 'is_system'],
      defs.map(([name, permissions]) => [
        randomUUID(),
        name,
        'Created by the load-test seeder.',
        JSON.stringify(permissions),
        false,
      ]),
      { onConflict: 'ON CONFLICT (name) DO NOTHING' },
    );
  });

  await step('api keys', async () =>
    insertMany(
      'api_keys',
      ['id', 'name', 'secret_hash', 'prefix', 'permissions'],
      Array.from({ length: 12 }, (_, at) => [
        randomUUID(),
        `Seed integration ${at + 1}`,
        // DISTINCT per key: `api_keys.secret_hash` is unique, which is right —
        // two keys hashing the same would mean two names for one credential.
        `${UNUSABLE_HASH}${at}`,
        `seed${String(at + 1).padStart(2, '0')}`,
        JSON.stringify(['clients.view']),
      ]),
      // Re-runnable: a second run must not fail on the keys the first wrote.
      { onConflict: 'ON CONFLICT DO NOTHING' },
    ),
  );

  await step('payment methods', async () =>
    insertMany(
      'payment_methods',
      ['key', 'name', 'currency', 'enabled', 'sort_order'],
      Array.from({ length: 8 }, (_, at) => [
        `seed-method-${at + 1}`,
        `Seed Method ${at + 1}`,
        pick(currencies, at),
        // DISABLED — a seeded method points at no provider, and an enabled one
        // would appear in a client's deposit flow.
        false,
        100 + at,
      ]),
      { onConflict: 'ON CONFLICT (key) DO NOTHING' },
    ),
  );

  const productIds = [];
  await step('products', async () => {
    const names = ['Seed Standard', 'Seed ECN', 'Seed Raw', 'Seed Islamic'];
    const rows = names.map((name, at) => {
      const id = randomUUID();
      productIds.push(id);
      // DISABLED, for the reason at the top of this file.
      return [id, name, 'Created by the load-test seeder.', false, 900 + at];
    });
    const written = await insertMany(
      'trading_products',
      ['id', 'name', 'description', 'enabled', 'sort_order'],
      rows,
      { onConflict: 'ON CONFLICT (name) DO NOTHING' },
    );

    await insertMany(
      'trading_product_groups',
      ['id', 'product_id', 'environment', 'mt5_group', 'currency'],
      productIds.flatMap((productId, at) =>
        ['live', 'demo'].map((environment) => [
          randomUUID(),
          productId,
          environment,
          `seed\\${environment}\\group-${at}`,
          pick(currencies, at),
        ]),
      ),
      { onConflict: 'ON CONFLICT (mt5_group) DO NOTHING' },
    );
    return written;
  });

  // ── Clients ──────────────────────────────────────────────────────────────
  /*
   * Read BACK from the database after the insert, never trusted from the ids
   * this script generated.
   *
   * The users insert is `ON CONFLICT DO NOTHING` so the script can be re-run.
   * On a second run it writes nothing — and the generated ids then name rows
   * that do not exist, so every foreign key below points at nothing. Selecting
   * the seeded users is correct on the first run and the tenth.
   */
  let userIds = [];
  const countries = ['LB', 'AE', 'SA', 'EG', 'JO', 'TR', 'GB', 'DE', 'FR', 'NG'];
  const statuses = ['active', 'active', 'active', 'pending', 'suspended'];

  await step('users', async () => {
    const rows = Array.from({ length: CLIENTS }, (_, at) => {
      return [
        randomUUID(),
        `loadtest+${at}@${SEED_DOMAIN}`,
        UNUSABLE_HASH,
        pick(['Omar', 'Layla', 'Youssef', 'Nour', 'Karim', 'Rana', 'Ali', 'Sara'], at),
        pick(['Haddad', 'Khoury', 'Nasser', 'Aziz', 'Farah', 'Saleh', 'Mansour'], at * 3),
        'individual',
        pick(statuses, at),
        at % 3,
        at % 4 !== 0,
        pick(countries, at),
        `+9617${String(100000 + (at % 900000))}`,
        dateFor(at),
      ];
    });
    return insertMany(
      'users',
      [
        'id',
        'email',
        'password_hash',
        'first_name',
        'last_name',
        'type',
        'status',
        'verification_level',
        'email_verified',
        'country',
        'phone',
        'created_at',
      ],
      rows,
      { onConflict: 'ON CONFLICT (email) DO NOTHING' },
    );
  });

  userIds = (
    await db.query(
      `SELECT id FROM users WHERE email LIKE '%@${SEED_DOMAIN}' ORDER BY created_at, id`,
    )
  ).rows.map((row) => row.id);
  console.log(`  ${'seeded clients on file'.padEnd(24)} ${String(userIds.length).padStart(8)}`);

  const tagIds = (await db.query("SELECT id FROM client_tags WHERE slug LIKE 'seed-%'")).rows.map(
    (r) => r.id,
  );

  await step('tag assignments', async () =>
    insertMany(
      'client_tag_assignments',
      ['user_id', 'tag_id'],
      userIds.flatMap((userId, at) =>
        // Roughly half the clients carry one or two tags.
        at % 2 === 0
          ? [[userId, pick(tagIds, at)]]
          : at % 7 === 0
            ? [[userId, pick(tagIds, at + 1)]]
            : [],
      ),
      { onConflict: 'ON CONFLICT DO NOTHING' },
    ),
  );

  // ── Wallets, and the money that moves through them ───────────────────────
  const walletsByUser = new Map();
  await step('wallets', async () => {
    const rows = [];
    userIds.forEach((userId, at) => {
      const count = at % 2 === 0 ? 2 : 1;
      const owned = [];
      for (let n = 0; n < count; n += 1) {
        const id = randomUUID();
        owned.push({ id, currency: pick(currencies, at + n) });
        /*
         * `on_hold` is a TENTH of the balance, not an independent number.
         *
         * `wallets_hold_within_balance` refuses a hold larger than the balance
         * — correctly, since held funds are a reservation against money that is
         * there. Two independent figures violate it on every small balance.
         */
        const balance = (at * 37) % 25_000;
        rows.push([
          id,
          userId,
          pick(currencies, at + n),
          money(balance, at % 100),
          money(Math.floor(balance / 10), 0),
          dateFor(at),
        ]);
      }
      walletsByUser.set(userId, owned);
    });
    return insertMany(
      'wallets',
      ['id', 'user_id', 'currency', 'balance', 'on_hold', 'created_at'],
      rows,
    );
  });

  await step('transactions', async () => {
    /*
     * A fifth PENDING, deliberately. The approvals queue is the screen most
     * likely to be slow and the one an operator lives in — a dataset where
     * everything has settled would leave it empty and untested.
     */
    const states = ['success', 'success', 'success', 'pending', 'rejected', 'approved', 'failure'];
    const rows = [];
    userIds.forEach((userId, at) => {
      const owned = walletsByUser.get(userId) ?? [];
      if (owned.length === 0) return;
      for (let n = 0; n < 8; n += 1) {
        const wallet = owned[n % owned.length];
        const index = at * 8 + n;
        rows.push([
          randomUUID(),
          userId,
          wallet.id,
          n % 3 === 0 ? 'withdrawal' : 'deposit',
          money((index * 13) % 9_000 || 25, index % 100),
          wallet.currency,
          pick(states, index),
          'seed-method-1',
          'seed',
          `SEED-${index}`,
          dateFor(index, 540),
        ]);
      }
    });
    return insertMany(
      'transactions',
      [
        'id',
        'user_id',
        'wallet_id',
        'direction',
        'amount',
        'currency',
        'state',
        'method_key',
        'provider',
        'provider_ref',
        'created_at',
      ],
      rows,
    );
  });

  // ── Trading accounts. CRM rows only; the bridge is never called ──────────
  await step('trading accounts', async () =>
    insertMany(
      'trading_accounts',
      [
        'id',
        'user_id',
        'login',
        'mt5_group',
        'environment',
        'currency',
        'balance',
        'leverage',
        'status',
        'created_at',
      ],
      userIds
        .filter((_, at) => at % 2 === 0)
        .map((userId, at) => [
          randomUUID(),
          userId,
          // Alphabetic, so it can never collide with a real MT5 login.
          `SEED-${String(at).padStart(7, '0')}`,
          `seed\\live\\group-${at % 4}`,
          at % 5 === 0 ? 'demo' : 'live',
          pick(currencies, at),
          money((at * 53) % 40_000, at % 100),
          pick([50, 100, 200, 500], at),
          pick(['active', 'active', 'active', 'suspended'], at),
          dateFor(at),
        ]),
      { onConflict: 'ON CONFLICT DO NOTHING' },
    ),
  );

  // ── The two review queues ────────────────────────────────────────────────
  await step('KYC submissions', async () => {
    const states = ['submitted', 'under_review', 'approved', 'rejected', 'in_progress'];
    return insertMany(
      'kyc_submissions',
      ['user_id', 'status', 'personal_info', 'submitted_at', 'created_at'],
      userIds
        .filter((_, at) => at % 5 !== 0)
        .map((userId, at) => [
          userId,
          pick(states, at),
          JSON.stringify({
            firstName: 'Seed',
            lastName: `Client ${at}`,
            country: pick(countries, at),
          }),
          dateFor(at, 400),
          dateFor(at, 400),
        ]),
      { onConflict: 'ON CONFLICT (user_id) DO NOTHING' },
    );
  });

  await step('partner applications', async () => {
    /*
     * NEVER 'approved', and the omission is the point.
     *
     * Approving an application CREATES the partner account, atomically, in the
     * same transaction — so an approved application with no `ib_accounts` row
     * is a state the running system cannot reach. Seeding one produced exactly
     * that: 250 "approved partners" in the review queue and 5 on the partners
     * page, which reads as a bug in the app and was a bug in this script.
     *
     * A seeder may only write states the system itself can produce. Approval
     * has a consequence, so it is not this script's to fake — and creating 250
     * real partner accounts would put 250 strangers in the commission tree.
     */
    const states = ['pending', 'pending', 'pending', 'rejected'];
    return insertMany(
      'ib_applications',
      ['id', 'user_id', 'motivation', 'status', 'rejection_reason', 'submitted_at'],
      userIds
        .filter((_, at) => at % 20 === 0)
        .map((userId, at) => {
          const status = pick(states, at);
          return [
            randomUUID(),
            userId,
            'Created by the load-test seeder.',
            `${(at + 1) * 10} lots / month`,
            status,
            // A rejected application the client can read a reason on, because
            // the portal renders it and a blank one renders as nothing.
            status === 'rejected' ? 'Insufficient trading history at this time.' : null,
            dateFor(at, 300),
          ];
        }),
      // `ib_applications_one_pending_uq` allows one pending row per user.
      { onConflict: 'ON CONFLICT DO NOTHING' },
    );
  });

  // ── Commissions, so that screen has something to render ──────────────────
  await step('commission accruals', async () => {
    const partners = (await db.query('SELECT user_id, level FROM ib_accounts LIMIT 50')).rows;
    if (partners.length === 0) {
      // No partners on this database. Not an error — the accruals table is
      // meaningless without one, and inventing a partner would touch ib_accounts.
      return 0;
    }
    const states = ['pending', 'confirmed', 'confirmed', 'reversed'];
    return insertMany(
      'ib_accruals',
      [
        'id',
        'ib_user_id',
        'client_user_id',
        'source_type',
        'source_id',
        'depth',
        'level',
        'rate_value',
        'base_amount',
        'amount',
        'currency',
        'status',
        'created_at',
      ],
      userIds
        .filter((_, at) => at % 10 === 0)
        .map((clientId, at) => {
          const partner = pick(partners, at);
          const base = (at * 17) % 5_000 || 100;
          return [
            randomUUID(),
            partner.user_id,
            clientId,
            'transaction',
            randomUUID(),
            1,
            partner.level,
            '30.0000',
            money(base, 0),
            money(Math.floor(base * 0.3), 0),
            'USD',
            pick(states, at),
            dateFor(at, 300),
          ];
        }),
    );
  });

  console.log(`\ndone in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  console.log(`\nRemove it all again with:  node scripts/seed-load-test.mjs --purge --apply`);
}

main()
  .catch((error) => {
    console.error(`\n${error.message}`);
    process.exitCode = 1;
  })
  .finally(() => db.end());
