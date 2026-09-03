import tseslint from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import prettierPlugin from 'eslint-plugin-prettier';
import simpleImportSort from 'eslint-plugin-simple-import-sort';

export default [
  // Global ignores
  {
    ignores: [
      '.claude',
      'dist',
      'build',
      'out',
      'coverage',
      'node_modules',
      'dist-electron',
      'dist-react',
      'dist-remotion',
      // velocity is a self-contained workspace package with its own linter (oxlint)
      // and prettier config; running the app's eslint over it double-lints with
      // conflicting rules.
      'velocity',
    ],
  },
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        // Type-aware linting — required by switch-exhaustiveness-check below.
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
      prettier: prettierPlugin,
      'simple-import-sort': simpleImportSort,
    },
    rules: {
      // ✅ Prettier runs as a lint rule
      'prettier/prettier': 'error',

      // ✅ Discriminated unions stay exhaustive: add a variant and every switch
      // that fails to handle it becomes a lint error. This is the guarantee
      // Rust's `match` gives for free; TypeScript needs it turned on.
      '@typescript-eslint/switch-exhaustiveness-check': [
        'error',
        { considerDefaultExhaustiveForUnions: true },
      ],

      // ✅ TS hygiene
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],

      // ✅ Auto sort imports + divisions
      'simple-import-sort/imports': [
        'error',
        {
          groups: [
            // side effects
            ['^\\u0000'],

            // node builtins
            ['^node:'],

            // electron
            ['^electron$'],

            // packages
            ['^@?\\w'],

            // internal aliases (edit if you use @/)
            ['^@/'],

            // relative imports
            ['^\\./(?=.*/)(?!/?$)', '^\\.(?!/?$)', '^\\./?$'],

            // styles
            ['^.+\\.css$'],
          ],
        },
      ],
      'simple-import-sort/exports': 'error',
    },
  },
];
