import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.node,
      },
      parserOptions: {
        project: [
          './tsconfig.json',
          './packages/*/tsconfig.json',
          './workers/*/tsconfig.json',
        ],
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    ignores: ['**/dist/**', '**/.wrangler/**', '**/node_modules/**'],
  },
);
