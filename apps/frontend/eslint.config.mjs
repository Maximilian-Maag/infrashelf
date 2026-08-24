import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FlatCompat } from '@eslint/eslintrc'

/**
 * ESLint flat config, replacing `.eslintrc.json` driven by `next lint` — which is
 * deprecated in Next.js 15 and gone in 16 (issue #93).
 *
 * `eslint-config-next` is still eslintrc-shaped (it has no flat export at 15.5), so
 * `FlatCompat` is what translates `next/core-web-vitals` and `next/typescript` into
 * flat entries. It goes when that package ships a flat config of its own.
 *
 * Both apps run `eslint . --max-warnings 0`, so every rule here is a gate on the
 * first PR that trips it. Each one below was switched on, counted against the tree,
 * and kept only where the count was zero or where every violation was worth fixing;
 * the ones that found a hundred edits and no defects were left off on purpose.
 * This file and its frontend/backend twin are kept identical.
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
    ],
  },
  ...compat.extends('next/core-web-vitals', 'next/typescript'),
  {
    // Type-aware linting, for the four rules below and nothing else. It is what
    // makes them possible at all — without a type checker ESLint cannot tell an
    // ignored Promise from an ignored number.
    //
    // It roughly doubles lint time, and CI runs this on every PR. Measured on an
    // idle machine: `eslint .` was 5.2-6.5s with no type information and 10.9s
    // with the program built and one type-aware rule running. Most of the
    // increase is building the program once, so the fixed toll is what was being
    // decided here — but it is not free per rule either: all 23 type-aware rules
    // that were trialled together came to 18.8s, and the ones left off below are
    // the expensive ones. Four cheap rules were kept.
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: dirname(fileURLToPath(import.meta.url)),
      },
    },
    rules: {
      // The rule that pays for the type checker. A dropped `await` on a database
      // write or a revoke fails silently; `EnvironmentsManager.load` was a live
      // example — its `try` had a `finally` but no `catch`, so an admin-API outage
      // produced an unhandled rejection and a silently empty environments list
      // while every sibling manager showed an error. Deliberate fire-and-forget
      // stays legal, spelled `void f()`.
      "@typescript-eslint/no-floating-promises": "error",
      // `checksVoidReturn.attributes` is off: React genuinely supports
      // `onClick={async () => …}` and turning it on flagged 85 of them, every one
      // a `void` wrapper that would catch nothing. The remaining checks are the
      // ones that hide bugs — an async function in an `if` is always truthy, and
      // an async callback passed where a sync one is expected is never awaited.
      "@typescript-eslint/no-misused-promises": ["error", { "checksVoidReturn": { "attributes": false } }],
      // The inverse mistake: an `await` left behind after a function stops being
      // async reads as if it still suspends. Free here — zero violations — and it
      // costs nothing extra now that the program is built.
      "@typescript-eslint/await-thenable": "error",
      // `defaultEndpoint` in `src/lib/ai/index.ts` switches on `AiProviderType`;
      // adding a provider without a case routes its prompt and API key to the
      // wrong host. `considerDefaultExhaustiveForUnions` keeps the deliberate
      // catch-all `default:` clauses this tree already writes legal — the rule
      // fires on a union switch that has no default at all.
      "@typescript-eslint/switch-exhaustiveness-check": ["error", { "considerDefaultExhaustiveForUnions": true }],
    },
  },
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      // No `varsIgnorePattern`: it was the one hole left in the rule that catches
      // this repo's most frequent CI failure — an import left behind by a move —
      // because renaming the dead import to `_Foo` silenced it. The four names it
      // was actually covering are all `const { drop: _x, ...rest }` omissions, so
      // they moved to `ignoreRestSiblings`, which allows that and nothing else.
      // `argsIgnorePattern` stays: ten parameters exist only to reach the ones
      // after them. `caughtErrors` is pinned rather than left to the default so a
      // future default cannot reopen the `catch (e)`-and-ignore-it case.
      "@typescript-eslint/no-unused-vars": ["error", {"argsIgnorePattern": "^_", "caughtErrors": "all", "ignoreRestSiblings": true}],
      "@typescript-eslint/no-unused-expressions": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/consistent-type-imports": ["error", {"prefer": "type-imports", "fixStyle": "inline-type-imports"}],
      "@typescript-eslint/no-empty-object-type": "error",
      "@typescript-eslint/no-wrapper-object-types": "error",
      // `catch (e)` inside `handleSubmit(e: React.FormEvent)` rebinds `e` to the
      // error for the rest of that block: 26 of these existed in the frontend, and
      // an `e.preventDefault()` reached from one is a runtime crash the compiler
      // accepts. The same shape hid the module-level `t` translation helper behind
      // a local `t` in two components.
      "@typescript-eslint/no-shadow": "error",
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
      "no-throw-literal": "error",
      // #136, half one. An empty block is a failure nobody wrote down. A comment
      // inside it satisfies the rule, which is exactly the convention the tree
      // already uses (`catch { /* empty */ }`) — so this asks for the reason, not
      // for a rethrow. Zero violations when switched on.
      "no-empty": ["error", {"allowEmptyCatch": false}],
      // #136, half two, which `no-empty` cannot see: it exempts function bodies,
      // so `.catch(() => {})` sails past it. Two did, both of them a `useEffect`
      // load whose failure left a section of the product form permanently empty.
      // A selector cannot read comments, so unlike `no-empty` this one is not
      // satisfied by writing the reason down — a genuinely deliberate drop takes
      // a disable line. That is the intended cost: there is one such drop in the
      // tree, and it should be visible in review rather than indistinguishable
      // from the two accidents.
      "no-restricted-syntax": ["error", {
        "selector": "CallExpression[callee.property.name='catch'] > :matches(ArrowFunctionExpression, FunctionExpression)[body.body.length=0]",
        "message": "An empty .catch() discards the failure. Handle it, or disable this line with the reason it is right to drop."
      }],
      // `eslint-config-next` carries no `eslint:recommended`, so these four were
      // simply absent, and TypeScript catches none of them: `noFallthroughCasesInSwitch`
      // is not set in either tsconfig, and the other three are runtime shapes the
      // compiler accepts. All four are already at zero here, so they are a floor,
      // not a cleanup.
      "no-cond-assign": "error",
      "no-fallthrough": "error",
      "no-unsafe-optional-chaining": "error",
      "no-constant-binary-expression": "error"
    },
  },
]

export default config
