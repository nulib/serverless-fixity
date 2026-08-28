// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: ['.aws-sam/**', '**/node_modules/**'],
  },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      'no-console': 'off',
      'prefer-const': 'error',
      'no-var': 'error',
      'object-shorthand': 'error',
      'prefer-template': 'error',
      eqeqeq: ['error', 'always'],
      'no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        /* `const { $metadata, ...rest }` is how we drop SDK response noise */
        ignoreRestSiblings: true,
      }],
    },
  },
];
