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
    },
  },
);
