// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

/** Where money is computed and moved. `partners/` was renamed `ib/` on 6 Aug 2026. */
const MONEY_MODULES = [
  'src/modules/wallet/**/*.ts',
  'src/modules/ib/**/*.ts',
  'src/modules/payments/**/*.ts',
];

/** The commission engine's pure seam (ARCHITECTURE §8.6). */
const COMMISSION_SEAM = 'src/modules/ib/commission.ts';

const NO_HTTP = {
  name: '@nestjs/common',
  importNames: [
    'HttpException',
    'BadRequestException',
    'UnauthorizedException',
    'ForbiddenException',
    'NotFoundException',
    'ConflictException',
    'InternalServerErrorException',
    'HttpStatus',
  ],
  message:
    'Throw a DomainError from common/errors/domain-errors.ts instead. AllExceptionsFilter maps it to a status code — that mapping lives in exactly one place on purpose.',
};

/** Layering: the shared layers are depended UPON by modules, never the reverse. */
const NO_FEATURE_MODULES = {
  regex: '(^|/)modules/',
  message:
    'Layering inversion: store/, common/, config/ and database/ are depended UPON by modules, never the reverse. Move the shared piece down, or invert with an interface.',
};

/**
 * The identity core (the client's profile and identity record) never depends on
 * the KYC layer — the process that fills it, which may one day be an external
 * tool. `(^|/)compliance/` catches both `../compliance/…` from a sibling module
 * and `…/modules/compliance/…`.
 */
const NO_KYC_LAYER = {
  regex: '(^|/)compliance/|(^|/)store/kyc[.-]',
  message:
    'The identity core never imports the KYC layer (modules/compliance, the KYC stores): KYC is a replaceable process that writes INTO the core. Ask through a port instead — see common/provisioning/identity-review.port.ts.',
};

/**
 * THE PAYMENTS CORE AND ITS PROVIDERS (0173). An adapter TRANSLATES for one
 * provider; the core DECIDES. So a provider's folder (`payments/providers/<code>/`)
 * may import only the shared contract (`../payment-provider`) and the shared
 * layers (common/, a few stores for its own settings) — never another
 * provider, never the payments module's services or the core, never another
 * feature module, never the database. An adapter cannot move money.
 * Regexes over the import string, which is RELATIVE from inside the folder.
 */
const PROVIDER_BOUNDARY = [
  {
    regex: '^\\.\\./[a-z0-9_-]+/',
    message:
      'A payment provider may not import another provider’s folder — each adapter translates for ONE provider (0173).',
  },
  {
    regex: '^\\.\\./\\.\\./(?!\\.\\./)',
    message:
      'A payment provider may not reach into the payments module or its core: adapters translate, the core decides (0173). Declare what you need in ../payment-provider.',
  },
  {
    regex: '^\\.\\./\\.\\./\\.\\./(?!\\.\\./)',
    message:
      'A payment provider may not import another feature module (wallet, admin, …): an adapter cannot move money (0173).',
  },
  {
    regex:
      '^drizzle-orm|^\\.\\./\\.\\./\\.\\./\\.\\./database/|^\\.\\./\\.\\./\\.\\./\\.\\./store/(?!(payment-providers|app-settings|payment-provider-events)\\.store$)',
    message:
      'A payment provider does not touch the database or the money stores (0173) — its settings come through its own store, and the core records everything else.',
  },
];

/**
 * …and the core never names a provider: nothing in the payments module outside
 * `providers/<code>/` imports a provider's folder, except `payments.module.ts`,
 * which wires them (0173).
 */
const NO_PROVIDER_FOLDER = {
  regex: '(^|/)providers/[a-z0-9_-]+/',
  message:
    'The payments core never names a provider (0173): reach it through PaymentProviderRegistry and the contract in providers/payment-provider.ts. Only payments.module.ts wires provider folders.',
};

const NO_GETDB = {
  name: '../../database/db',
  importNames: ['getDb'],
  allowTypeImports: true,
  message:
    'Inject the db instead: `@Inject(DRIZZLE_DB) private readonly db: Db`. Type-only imports (Db, Executor, typeof getDb) are fine.',
};

// This config exists because it did not. `npm run lint` was defined in
// package.json and wired into CI, but with no config file ESLint 9 exits
// immediately — and CI hid that with `continue-on-error: true`. A floating
// promise on an authorization check shipped as a result.
//
// The type-aware rules below are the ones that matter on a money system:
// an unawaited guard is a security hole, not a style issue.
export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'coverage/**',
      'src/database/migrations/**',
      // Build tooling, deliberately outside the tsconfig project: the type-aware
      // parser cannot place a file it has no program for, and adding these to
      // tsconfig would put non-application code into the compiled output — the
      // drizzle.config.ts trap that once moved dist/main.js and broke npm start.
      'scripts/**',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // ── The rules that would have caught real defects ──────────────────
      // A discarded promise on assertGrantable() was a live privilege
      // escalation; a discarded audit write loses money history.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      // `as any` / unchecked casts on a money state machine.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'warn',
      '@typescript-eslint/no-unsafe-member-access': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      '@typescript-eslint/no-unsafe-call': 'warn',
      '@typescript-eslint/no-unsafe-return': 'warn',
      // Dead code the compiler will not flag.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrors: 'none',
          // `const { passwordHash, ...safe } = admin` is the idiomatic way to
          // strip secrets from a response object; the binding is meant to be unused.
          ignoreRestSiblings: true,
        },
      ],
      // The working agreement mandates structured logging with a correlation
      // ID. console.* bypasses it and has leaked verification tokens to stdout.
      'no-console': 'error',
      // Empty catch blocks swallowed failures on a destructive delete path.
      'no-empty': ['error', { allowEmptyCatch: false }],
      eqeqeq: ['error', 'always'],
    },
  },
  {
    // ── §6.1: monetary values are strings and decimals, never floats ────────
    // Verified 0 violations when this landed; the rule keeps it that way.
    // `money.ts` owns every arithmetic operation and uses decimal.js.
    files: ['src/modules/wallet/**/*.ts', 'src/modules/ib/**/*.ts', 'src/modules/payments/**/*.ts'],
    ignores: ['**/*.spec.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        {
          name: 'parseFloat',
          message:
            'ARCHITECTURE §6.1: never coerce a monetary value to a float. Use decimal.js via modules/wallet/money.ts.',
        },
        {
          name: 'parseInt',
          message:
            'Suspicious in a money path. If this is not money, use Number.parseInt with an explicit radix.',
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.name='Number']",
          message:
            'ARCHITECTURE §6.1: Number() on a monetary string silently truncates past 2^53. Use decimal.js via modules/wallet/money.ts.',
        },
      ],
    },
  },

  {
    /*
     * ── decimal.js reads the SIGN, so `isPositive()` is TRUE for ZERO ───────
     *
     * `new Decimal(0).isPositive()` is true and `new Decimal('-0').isNegative()`
     * is true, because both read the sign field rather than comparing a value.
     * So `if (!amount.isPositive()) throw` — which reads exactly like "reject
     * anything that is not greater than zero" — NEVER FIRES FOR ZERO.
     *
     * This repo learned that in the IB module and wrote it down three times
     * (`ib-wallet.service.ts`, `commission.ts` twice), and the identical idiom
     * stayed live in five other money guards, including `WalletService.hold`.
     * A comment beside one fix does not travel; a rule does. It propagates by
     * IMITATION — the next reader copies the line that looks right, which is
     * how it was reintroduced into `release` on 11 Sep while the person doing
     * it had read those three comments an hour earlier.
     *
     * WIDENED TO `modules/payments/**` on 11 Sep, once its three violations
     * were fixed — `transactions.service.ts` (deposit and withdrawal) and
     * `transfers.service.ts` (transfer). The list was deliberately narrow for a
     * few hours rather than shipping with inline `eslint-disable` comments at
     * the violation sites: a disable is a thing people stop seeing within a
     * week, whereas a `files` list that visibly omits a directory is a question
     * anybody opening this config will ask.
     *
     * Same shrink-only ratchet as `max-lines` and `--max-warnings`: WIDEN this
     * as each remaining money path is cleaned. Never narrow it.
     */
    files: [
      'src/modules/wallet/**/*.ts',
      'src/modules/ib/**/*.ts',
      'src/modules/payments/**/*.ts',
      'src/config/money-limits.ts',
    ],
    ignores: ['**/*.spec.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "CallExpression[callee.property.name='isPositive'], CallExpression[callee.property.name='isNegative']",
          message:
            'decimal.js reads the SIGN: isPositive() is TRUE for zero and isNegative() is TRUE for -0, so these never fire on the boundary they look like they guard. Compare explicitly: greaterThan(0), lessThan(0), lessThanOrEqualTo(0).',
        },
      ],
    },
  },

  // ── IMPORT BANS, composed so none can erase another ─────────────────────
  //
  // Flat config does not MERGE a rule's options across the blocks matching a
  // file: the LAST block replaces them outright. Until 28 Sep 2026 every ban
  // below sat on the one rule `no-restricted-imports`, and `eslint
  // --print-config` showed what that cost:
  //   - every store file had lost the "no HTTP in domain code" ban (the
  //     layering block replaced it);
  //   - every money service had lost the `getDb` ban (the HTTP block
  //     replaced it);
  //   - the commission seam was protected by nothing at all: three blocks
  //     named `src/modules/partners/`, which f5e257a removed on 6 Aug when the
  //     engine was rebuilt in `src/modules/ib/`; and the seam's
  //     `'**/database/*'` pattern never matches a RELATIVE import such as
  //     `'../../database/db'` anyway.
  //
  // So: PATH bans (HTTP, getDb) live on `@typescript-eslint/no-restricted-imports`
  // and PATTERN bans (layering, pure seams) on `no-restricted-imports`, and
  // wherever two path bans meet on one file, ONE block states both. Patterns
  // are regexes over the import string, which see relative paths.
  // `test/lint-composition.spec.ts` lints a real violation in every place —
  // add a case there when you add a ban here.
  {
    // ── The money path declares its dependencies ────────────────────────────
    // These services used to call the module-level getDb() singleton from
    // inside each method. They take the db by constructor injection now, which
    // is behaviour-identical (DRIZZLE_DB's factory *is* getDb) but visible.
    files: MONEY_MODULES,
    ignores: ['**/*.spec.ts'],
    rules: { '@typescript-eslint/no-restricted-imports': ['error', { paths: [NO_GETDB] }] },
  },
  {
    // ── Domain code must not know about HTTP ────────────────────────────────
    // Services and stores throw DomainError subclasses; AllExceptionsFilter is
    // the single place that maps them to status codes. HttpException belongs to
    // controllers, guards, strategies and the filter — the transport edge.
    files: ['src/**/*.service.ts', 'src/store/**/*.ts', COMMISSION_SEAM],
    rules: { '@typescript-eslint/no-restricted-imports': ['error', { paths: [NO_HTTP] }] },
  },
  {
    // Where the two path bans MEET: a money service, and the commission seam.
    // Stated together, because either block alone would erase the other here.
    files: [
      ...MONEY_MODULES.map((glob) => glob.replace(/\*\.ts$/, '*.service.ts')),
      COMMISSION_SEAM,
    ],
    ignores: ['**/*.spec.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': ['error', { paths: [NO_HTTP, NO_GETDB] }],
    },
  },
  {
    // ── Layering direction ─────────────────────────────────────────────────
    // The repository and shared layers may not depend on feature modules. This
    // is what actually prevents import cycles, and it does so without pulling in
    // eslint-plugin-import (whose no-cycle rule rebuilds the whole module graph
    // on every run). Measured: 0 cycles across src/ when this landed.
    files: [
      'src/store/**/*.ts',
      'src/common/**/*.ts',
      'src/config/**/*.ts',
      'src/database/**/*.ts',
    ],
    rules: { 'no-restricted-imports': ['error', { patterns: [NO_FEATURE_MODULES] }] },
  },
  {
    // ── The identity core never imports the KYC layer (28 Sep 2026) ─────────
    // The owner's direction: the client's identity is the core, and KYC is a
    // process that may be replaced. The core's MODULES take this ban alone…
    files: ['src/modules/profile/**/*.ts', 'src/modules/client-identity/**/*.ts'],
    ignores: ['**/*.spec.ts'],
    rules: { 'no-restricted-imports': ['error', { patterns: [NO_KYC_LAYER] }] },
  },
  {
    // …and its shared-layer files take it WITH the layering ban, in one block —
    // on their own, this block would erase the layering ban above for them.
    files: ['src/store/client-identity.store.ts', 'src/common/profile/**/*.ts'],
    ignores: ['**/*.spec.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [NO_FEATURE_MODULES, NO_KYC_LAYER] }],
    },
  },
  {
    // ── The payments core and its providers (0173) ─────────────────────────
    // Inside a provider's folder: the contract and the shared layers only.
    files: ['src/modules/payments/providers/*/**/*.ts'],
    ignores: ['**/*.spec.ts'],
    rules: { 'no-restricted-imports': ['error', { patterns: PROVIDER_BOUNDARY }] },
  },
  {
    // The core and the rest of the payments module: no provider folder.
    files: ['src/modules/payments/**/*.ts'],
    ignores: [
      '**/*.spec.ts',
      'src/modules/payments/providers/**',
      'src/modules/payments/payments.module.ts',
    ],
    rules: { 'no-restricted-imports': ['error', { patterns: [NO_PROVIDER_FOLDER] }] },
  },
  {
    // The providers/ root (the registry, the provider page, the webhook doors)
    // is core too: it reaches a provider only through the registry.
    files: ['src/modules/payments/providers/*.ts'],
    ignores: ['**/*.spec.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            NO_PROVIDER_FOLDER,
            {
              regex: '^\\./[a-z0-9_-]+/',
              message: NO_PROVIDER_FOLDER.message,
            },
          ],
        },
      ],
    },
  },
  {
    // The two pure seams (ARCHITECTURE §8.6). No DB, no HTTP, no Nest — that is
    // what makes them unit-testable without Testcontainers.
    files: [COMMISSION_SEAM, 'src/modules/wallet/money.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '^@nestjs/|^drizzle-orm|(^|/)(database|store)(/|$)',
              message:
                'ARCHITECTURE §8.6: this file is a pure seam — no DB, no HTTP, no framework. Put anything needing those in the sibling *.service.ts.',
            },
          ],
        },
      ],
    },
  },

  {
    // Root-level config files are not part of the app's tsconfig project graph,
    // so type-aware rules cannot resolve them and report a parse error instead.
    // `npm run lint` used to dodge this by globbing only {src,apps,libs,test},
    // which meant nothing linted these files at all.
    files: ['*.mjs', '*.mts', '*.js', 'drizzle.config.ts'],
    ...tseslint.configs.disableTypeChecked,
  },

  {
    // Bootstrap and seeding legitimately write to stdout before a logger exists.
    files: ['src/main.ts', 'src/database/seed.ts'],
    rules: { 'no-console': 'off' },
  },
  {
    // Tests may use loose typing against fixtures.
    files: ['test/**/*.ts', 'src/**/*.spec.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      // no-console guards the structured-logging path and once caught a leaked
      // verification token on stdout. Neither concern applies in a spec, where
      // writing a diagnostic for the person reading the run IS the point.
      'no-console': 'off',
    },
  },
);
