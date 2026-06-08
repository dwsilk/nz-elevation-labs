// ESLint 9 flat config. Hand-picked rule set, errors-only — every rule below
// is here because it catches a real bug class, not for style. Type-aware
// rules (the most valuable ones for this codebase) require the parser to
// have access to the tsconfig, hence `projectService: true` below.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';
import prettierConfig from 'eslint-config-prettier';

export default tseslint.config(
  // Don't try to lint generated artefacts or vendored code.
  { ignores: ['dist/**', 'node_modules/**'] },

  js.configs.recommended,

  // Type-aware linting over every .ts file in the project.
  {
    files: ['src/**/*.ts'],
    extends: [tseslint.configs.recommended],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: { ...globals.browser },
    },
    rules: {
      // ── Promise correctness ── highest-leverage rules for this codebase.
      // No-floating-promises catches unhandled async returns (DEM-cache
      // fetches, MapLibre style.load awaits, etc.); no-misused-promises
      // catches async functions handed to event listeners where the
      // returned Promise is silently dropped.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/require-await': 'error',

      // ── Type-aware bug catchers ──
      '@typescript-eslint/no-base-to-string': 'error',
      '@typescript-eslint/no-confusing-non-null-assertion': 'error',
      '@typescript-eslint/no-for-in-array': 'error',
      '@typescript-eslint/no-implied-eval': 'error',
      '@typescript-eslint/no-misused-new': 'error',
      '@typescript-eslint/no-unnecessary-type-assertion': 'error',
      '@typescript-eslint/restrict-plus-operands': 'error',

      // ── Consistency / code-quality (not stylistic — each prevents a bug
      //    class or makes intent unambiguous) ──
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/prefer-as-const': 'error',
      '@typescript-eslint/prefer-nullish-coalescing': 'error',
      '@typescript-eslint/prefer-optional-chain': 'error',
      '@typescript-eslint/non-nullable-type-assertion-style': 'error',

      // Unused vars at error severity; allow `_`-prefixed args and caught
      // errors for cases where the slot must exist for typing reasons.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
      // Use the TS-aware version; turn the core rule off so we don't double-fire.
      'no-unused-vars': 'off',

      // ── Core JS rules — narrow, high-signal ──
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-debugger': 'error',
      'no-throw-literal': 'error',
      'no-var': 'error',
      'prefer-const': 'error',
    },
  },

  // Test files: same rule set; nothing to relax — Vitest's expect chain
  // doesn't trip any of the rules above.

  // Defer all stylistic ESLint rules to Prettier — currently a no-op since
  // we've hand-picked only non-stylistic rules above, but this protects us
  // if a future preset re-enables one (e.g. quote style, indent, semi).
  prettierConfig,
);
