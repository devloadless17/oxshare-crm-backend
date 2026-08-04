// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

// This config exists because it did not. `npm run lint` was defined in
// package.json and wired into CI, but with no config file ESLint 9 exits
// immediately — and CI hid that with `continue-on-error: true`. A floating
// promise on an authorization check shipped as a result.
//
// The type-aware rules below are the ones that matter on a money system:
// an unawaited guard is a security hole, not a style issue.
export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'src/database/migrations/**'] },
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
    files: ['src/modules/wallet/**/*.ts', 'src/modules/partners/**/*.ts', 'src/modules/payments/**/*.ts'],
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
    // ── The money path declares its dependencies ────────────────────────────
    // These four services used to call the module-level getDb() singleton from
    // inside each method. They now take the db by constructor injection, which
    // is behaviour-identical (DRIZZLE_DB's factory *is* getDb) but visible.
    // Reaching for the global again would silently undo that.
    files: [
      'src/modules/wallet/**/*.ts',
      'src/modules/partners/**/*.ts',
      'src/modules/payments/**/*.ts',
    ],
    ignores: ['**/*.spec.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '../../database/db',
              importNames: ['getDb'],
              message:
                'Inject the db instead: `@Inject(DRIZZLE_DB) private readonly db: Db`. Type-only imports (Db, Executor) from this module are fine.',
            },
          ],
        },
      ],
    },
  },

  {
    // ── Domain code must not know about HTTP ────────────────────────────────
    // Services and stores throw DomainError subclasses; AllExceptionsFilter is
    // the single place that maps them to status codes. Verified 0 violations
    // when this landed — HttpException appears only in controllers, guards,
    // strategies and the filter, which is the transport edge and correct.
    files: ['src/**/*.service.ts', 'src/store/**/*.ts', 'src/modules/partners/commission.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
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
            },
          ],
        },
      ],
    },
  },

  {
    // ── Layering direction ─────────────────────────────────────────────────
    // The repository and shared layers may not depend on feature modules. This
    // is what actually prevents import cycles, and it does so without pulling in
    // eslint-plugin-import (whose no-cycle rule rebuilds the whole module graph
    // on every run). Measured: 0 cycles across src/ when this landed.
    files: ['src/store/**/*.ts', 'src/common/**/*.ts', 'src/config/**/*.ts', 'src/database/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/modules/**', '../modules/*', '../../modules/*'],
              message:
                'Layering inversion: store/, common/, config/ and database/ are depended UPON by modules, never the reverse. Move the shared piece down, or invert with an interface.',
            },
          ],
        },
      ],
    },
  },

  {
    // The two pure seams (ARCHITECTURE §8.6). No DB, no HTTP, no Nest — that is
    // what makes them unit-testable without Testcontainers.
    files: ['src/modules/partners/commission.ts', 'src/modules/wallet/money.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@nestjs/*', 'drizzle-orm*', '**/database/*', '**/store/*'],
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
