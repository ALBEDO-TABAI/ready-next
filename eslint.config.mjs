import js from '@eslint/js'
import tsParser from '@typescript-eslint/parser'
import tsPlugin from '@typescript-eslint/eslint-plugin'
import reactPlugin from 'eslint-plugin-react'
import reactHooksPlugin from 'eslint-plugin-react-hooks'
import reactRefreshPlugin from 'eslint-plugin-react-refresh'
import readyPlugin from './eslint-rules/index.mjs'

export default [
  {
    ignores: ['out/**', 'dist/**', 'exports/**', 'outputs/**', 'Packer/.staging/**', 'node_modules/**', '.claude/codex-audit/**', '.claude/worktrees/**', '.worktrees/**']
  },
  js.configs.recommended,
  {
    files: ['**/*.{js,jsx,ts,tsx,mjs,cjs}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: {
          jsx: true
        }
      },
      globals: {
        console: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        window: 'readonly',
        document: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly'
      }
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
      react: reactPlugin,
      'react-hooks': reactHooksPlugin,
      'react-refresh': reactRefreshPlugin,
      ready: readyPlugin
    },
    settings: {
      react: {
        version: 'detect'
      }
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      ...reactPlugin.configs.recommended.rules,
      ...reactHooksPlugin.configs.recommended.rules,
      'no-undef': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-irregular-whitespace': ['error', {
        skipComments: true,
        skipRegExps: true,
        skipStrings: true,
        skipTemplates: true,
      }],
      'react/react-in-jsx-scope': 'off',
      'react/jsx-uses-react': 'off',
      'no-redeclare': 'off',
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
      }],
      '@typescript-eslint/no-explicit-any': 'warn',
      'ready/no-source-grep-test': 'error',
      'ready/no-legacy-backdoor': 'error',
      'ready/no-migration-todo': 'error',
      'ready/no-subagent-leak': 'error',
      'ready/no-coordinator-id-leak': 'error',
      'ready/no-inline-system-reminder-write': 'error',
      'ready/no-task-card-run-cast': 'error'
    }
  },
  {
    files: ['src/main/**/*.{ts,tsx}', 'src/__tests__/**/*.{ts,tsx}'],
    rules: {
      'ready/test-helper-must-declare-invariant-breach': 'error'
    }
  },
  {
    // Historical AgentSdk Dynamic Delivery support; the current Codex graph is
    // guarded separately and cannot import this retired subtree.
    files: [
      'src/main/modules/agent-control/runtime-core/dynamic-delivery/dynamic-delivery-coordinator.ts',
      'src/main/modules/agent-control/runtime-core/dynamic-delivery/specialist-model-subagent.ts',
    ],
    rules: {
      'ready/no-subagent-leak': 'off',
    },
  }
]
