import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default [
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      // PostgREST row shapes are runtime-validated; generated Supabase types are an optional deployment artifact.
      '@typescript-eslint/no-explicit-any': 'off',
      // State updates occur in async data-loading effects and are intentional.
      'react-hooks/set-state-in-effect': 'off',
    },
  },
  {
    // ES5 runtime for the TV browser: `catch (error)` bindings and unused callback arguments are
    // structural (optional catch binding is ES2019), so they must not be reported as dead code.
    files: ['public/player/**/*.js'],
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { caughtErrors: 'none', args: 'none', varsIgnorePattern: '^(noop|_)$' }],
      // `var self = this;` is how ES5 code keeps a reference inside `then()` callbacks.
      '@typescript-eslint/no-this-alias': 'off',
    },
  },
  {
    ignores: ['.next/**', 'node_modules/**', 'coverage/**'],
  },
];
