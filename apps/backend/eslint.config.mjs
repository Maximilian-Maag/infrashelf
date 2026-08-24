import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FlatCompat } from '@eslint/eslintrc'

/**
 * ESLint flat config, replacing `.eslintrc.json` driven by `next lint` — which is
 * deprecated in Next.js 15 and gone in 16 (issue #93). The rule set is unchanged;
 * only the mechanism moved, so `pnpm lint` still means the same thing.
 *
 * `eslint-config-next` is still eslintrc-shaped (it has no flat export at 15.5), so
 * `FlatCompat` is what translates `next/core-web-vitals` and `next/typescript` into
 * flat entries. It goes when that package ships a flat config of its own.
 */
const compat = new FlatCompat({ baseDirectory: dirname(fileURLToPath(import.meta.url)) })

const config = [
  {
    // `next lint` only ever looked at a few source directories; `eslint .` looks at
    // everything, so the generated and copied trees have to be named. `.stryker-tmp`
    // matters most: a mutation run fills it with copies of the whole source tree.
    ignores: [
      '.next/**',
      '.stryker-tmp/**',
      'reports/**',
      'coverage/**',
      'next-env.d.ts',
      'drizzle/**',
      // Swagger UI's minified bundle, vendored verbatim (issue #146). Linting
      // someone else's build output produces 8000 findings and no information.
      'public/swagger-ui/**',
    ],
  },
  ...compat.extends('next/core-web-vitals', 'next/typescript'),
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": ["error", {"argsIgnorePattern": "^_", "varsIgnorePattern": "^_"}],
      "@typescript-eslint/no-unused-expressions": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/consistent-type-imports": ["error", {"prefer": "type-imports", "fixStyle": "inline-type-imports"}],
      "@typescript-eslint/no-empty-object-type": "error",
      "@typescript-eslint/no-wrapper-object-types": "error",
      "import/no-anonymous-default-export": "error",
      "jsx-a11y/aria-props": "error",
      "jsx-a11y/aria-proptypes": "error",
      "jsx-a11y/aria-unsupported-elements": "error",
      "jsx-a11y/role-has-required-aria-props": "error",
      "jsx-a11y/role-supports-aria-props": "error",
      "react-hooks/exhaustive-deps": "error",
      "eqeqeq": ["error", "always"],
      "no-var": "error",
      "prefer-const": "error",
      "no-console": ["error", {"allow": ["error", "warn"]}],
      "no-duplicate-imports": "error",
      "object-shorthand": "error",
      "no-useless-rename": "error",
      "no-throw-literal": "error"
    },
  },
]

export default config
