import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export default tseslint.config(
  { ignores: ['dist/**', 'coverage/**', 'reports/**', 'node_modules/**', 'tools/**', '.stryker-tmp/**', 'src/core/auth/breached-list.data.ts'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: { parserOptions: { project: resolve(root, 'tsconfig.lint.json'), tsconfigRootDir: root } },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: false }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_', ignoreRestSiblings: true }],
      'no-console': 'error',
    },
  },
);
