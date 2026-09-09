import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import pluginVue from 'eslint-plugin-vue';
import vueParser from 'vue-eslint-parser';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      'data/**',
      'packages/server/drizzle/**',
      '**/*.d.ts',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },

  {
    files: ['**/*.{ts,mts,cts,vue}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
    },
  },

  // The scheduler is a pure package (spec §3.3, plan operating brief #5): plain data in,
  // plain data out. It must never reach for infrastructure or the wall clock.
  {
    files: ['packages/scheduler/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                'drizzle-orm',
                'drizzle-orm/*',
                'postgres',
                'pg',
                'hono',
                'hono/*',
                '@ambitime/server',
                '@ambitime/server/*',
                'node:*',
                'fs',
                'path',
                'http',
                'https',
              ],
              message:
                'packages/scheduler must stay pure: no DB, HTTP, or Node built-in imports (plan operating brief #5).',
            },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        {
          name: 'Date',
          message: 'The scheduler is deterministic: `now` is an explicit input (spec §6.3).',
        },
        { name: 'fetch', message: 'packages/scheduler must stay pure: no I/O.' },
      ],
      'no-restricted-properties': [
        'error',
        { object: 'Math', property: 'random', message: 'No randomness in the solver (spec §6.3).' },
      ],
    },
  },

  ...pluginVue.configs['flat/recommended'],
  {
    files: ['packages/client/**/*.{ts,vue}'],
    languageOptions: {
      parser: vueParser,
      globals: { ...globals.browser },
      parserOptions: {
        parser: tseslint.parser,
        extraFileExtensions: ['.vue'],
        sourceType: 'module',
      },
    },
    rules: {
      // shadcn-vue components are single-word by convention (Button, Card, ...).
      'vue/multi-word-component-names': 'off',
      // TypeScript already expresses optionality; an optional prop being
      // `undefined` is the intended contract, and cva supplies variant defaults.
      'vue/require-default-prop': 'off',
    },
  },

  {
    files: [
      '**/*.config.{js,ts}',
      '**/vitest.config.ts',
      '**/drizzle.config.ts',
      'eslint.config.js',
    ],
    rules: { 'no-console': 'off' },
  },

  prettier,
);
