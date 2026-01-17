import tseslint from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import prettierPlugin from 'eslint-plugin-prettier';
import simpleImportSort from 'eslint-plugin-simple-import-sort';

export default [
  {
    files: ['**/*.{ts,tsx}'],
    ignores: ['dist', 'build', 'out', 'coverage', 'node_modules'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
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
