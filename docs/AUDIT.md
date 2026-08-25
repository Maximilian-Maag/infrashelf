# Codebase Audit — 2026-08-12

Full audit of the monorepo (backend Next.js API, frontend, shared types, infra).
This document is organized in phases (see the dated sections below).

- **Pre-audit baseline:** 719 backend + 20 frontend tests.
- **Round 1 (this section):** security/correctness fixes → 722 backend tests.
- **Final (all rounds incl. deferred-item follow-up + PR-review fixes):**
  typecheck ✅, lint ✅, **747 backend + 53 frontend tests ✅**.

The fixes below are applied on this branch. The "Deferred" section lists confirmed
findings that need a product/architecture decision or cannot be safely verified
without a live external system (GitHub/Entra), and so were intentionally not
changed blind.

---

## Fixed on this branch

### Security

1. **GitHub & Bitbucket callbacks verified the wrong secret** — both routes
   computed the inbound HMAC against `webhook_token` (the *outbound* trigger
   token) instead of `callback_secret`. GitLab was already migrated (0004).
   The moment an operator rotates the two apart, every GitHub/Bitbucket callback
   would 401 (orders never complete), and the outbound token — which is readable
   by any admin and shared to the CI system — could forge callbacks. Now both
   validate against `callback_secret`, matching GitLab.
   *Files:* `webhooks/github/workflow/route.ts`, `webhooks/bitbucket/pipeline/route.ts`.
   *Regression tests added* (distinct outbound/inbound secrets).

2. **`JWT_SECRET` silently fell back to `''`** — with no secret set, tokens were
   signed/verified with an empty key, letting anyone mint a `root` session.
   Now fails fast at module load if the secret is missing or < 32 chars, and
   `verifyToken` pins `algorithms: ['HS256']`.
   *File:* `lib/auth/jwt.ts`.

3. **Audit export was broken and leaked the token** — the frontend opened the
   export via `window.open(...&token=…)`, but the endpoint only authenticates via
   the `Authorization` header, so every export 401'd; the token was also placed
   in the URL (history/Referer/logs). Now fetched with the header and downloaded
   from the response blob.
   *File:* `audit/AuditTable.tsx`.

4. **CSV formula injection in audit export** — cells beginning with `= + - @`
   (tab/CR) are executed as formulas by Excel/Sheets. Audit fields capture
   user-supplied values. Such cells are now prefixed with `'`.
   *File:* `audit/export/route.ts`. *Regression test added.*

5. **Email header hardening** — subjects were HTML-escaped (wrong for plain-text
   subjects → double-escaped names) and relied on escaping for header safety.
   Subjects now use the raw product name with CR/LF stripped.
   *File:* `lib/notification/index.ts`.

### Correctness

6. **Race conditions in approve / reject / decommission** — all three read the
   row, checked its status, then triggered pipelines and updated non-atomically.
   Two concurrent calls (or a double-click) could both pass the check and
   double-provision / double-destroy, or leave an active infra element attached
   to a rejected order. Each now claims the row with a conditional
   `UPDATE … WHERE status = <expected> RETURNING` and rolls back on trigger
   failure, so only one caller can win the transition.
   *Files:* `services/approvals.ts`, `services/infrastructure.ts`.

7. **SMTP config changes never took effect** — the transporter/settings were
   cached at module scope and never invalidated, so admin-UI SMTP edits were
   ignored until restart. Added `resetSmtpCache()`, called on SMTP config update.
   *Files:* `lib/notification/index.ts`, `services/admin/config.ts`.

8. **AI endpoint default ignored the provider and blank values** — a blank
   endpoint (which the UI explicitly allows) never fell back because the column
   is a non-null `''`, and the single hardcoded default was an OpenAI host even
   for Claude. Blank now normalizes to a per-provider default, and a malformed
   AI JSON response throws a clear error instead of a raw `JSON.parse` crash.
   *File:* `lib/ai/index.ts`.

9. **AI-translate errors were swallowed in the UI** — the handler had an empty
   `catch`, so a failed translation silently stopped the spinner. Errors are now
   surfaced in a banner.
   *File:* `admin/products/[id]/ProductEditForm.tsx`.

10. **Decommission confirmation warning only shown in English** — a hardcoded
    English string replaced the existing localized `cannotBeUndone` key.
    *File:* `infrastructure/InfraActions.tsx`.

11. **Root `.env.example` was stale and misleading** — wrong var names
    (`SESSION_SECRET`, `ENTRA_REDIRECT_URL`, `SMTP_USERNAME/PASSWORD`), unused
    vars, missing required vars (`JWT_SECRET`, `FRONTEND_URL`, `NEXTAUTH_SECRET`,
    `API_URL`, `NEXT_PUBLIC_API_URL`), and a DB name that didn't match compose.
    Rewritten to match the code.
    *File:* `.env.example`.

---

## Fixed since the audit

- **GitHub-backed orders never complete (HIGH).** `triggerGitHubWorkflow`
  returned a synthetic id `owner/repo/workflow@branch` while the callback stored
  the numeric `workflow_run.id`, so the two never matched and GitHub orders
  stayed `provisioning` forever. `workflow_dispatch` still answers 204 with no
  body; the run is now looked up afterwards on
  `/actions/workflows/{workflow}/runs`, filtered to `event=workflow_dispatch`,
  the dispatched branch, and a `created_at` no earlier than the dispatch.

  A correlation, not an identity: two orders dispatching the same workflow on
  the same branch within the lookup window are indistinguishable, and eliminating
  that needs the customer's workflow to echo a portal-generated input into
  `run-name:` — which cannot be required of an existing workflow. A dispatch
  whose run cannot be found raises an error that says the workflow may be running
  untracked, rather than recording an id that will never match.
  *File:* `lib/ci/github.ts`. Issue #207.

---

## Deferred — confirmed findings needing a decision (not changed)

- **Multi-pipeline orders complete on the first success (HIGH).**
  `handlePipelineEvent` completes an order as soon as *any* pipeline in its array
  succeeds; a later failure is dropped. Needs per-pipeline status tracking.
  *File:* `lib/webhook/handler.ts`.

- **`createOrder` does no server-side parameter validation (MEDIUM).** Required
  params aren't enforced and types aren't coerced/validated against the
  `parameters` table before an order is accepted and sent to provisioning.
  *File:* `services/orders.ts`.

- **`createOrder` has no project-ownership check (MEDIUM / IDOR).** A PM can
  submit an order against another PM's `projectId`; the resulting infra element
  (and cost) is attributed to — and manageable by — the other owner. Needs an
  ownership check for non-admins. *File:* `services/orders.ts`.

- **Cascade delete races with in-flight destroy (MEDIUM).** `deleteProject` /
  `deleteProduct` fire-and-forget the destroy webhook then immediately delete the
  rows (`ON DELETE CASCADE`), losing tracking of the running decommission.
  *Files:* `services/projects.ts`, `services/admin/products.ts`.

- **Drizzle meta snapshots for migrations 0002–0004 are missing (HIGH for
  `db:generate`).** `meta/_journal.json` lists five migrations but only 0000/0001
  snapshots exist, and 0001 is stale. The runtime migrator is unaffected, but the
  next `drizzle-kit generate` will fail or emit a corrupt duplicate migration.
  Regenerate the snapshots with `drizzle-kit`. *Dir:* `drizzle/meta/`.

- **OAuth login flow (LOW–MEDIUM).** The Entra `id_token` is decoded but not
  verified (no JWKS/`aud`/`iss`), there's no `state`/`nonce` (login-CSRF), and
  the session JWT is delivered as a URL query param. Needs an auth-flow rework.
  *File:* `auth/callback/route.ts`.

- **Login rate-limit is bypassable (MEDIUM).** Keyed on the spoofable
  `X-Forwarded-For`; the in-memory bucket is also unbounded. Derive the IP from
  the trusted proxy hop and bound the map. *File:* `auth/login/route.ts`.

- **No pagination on CI provider listings (MEDIUM).** GitLab/GitHub/Bitbucket
  repo/branch/file listings cap at 100 with no cursor follow, silently
  truncating large orgs. *Files:* `lib/ci/{gitlab,github,bitbucket}.ts`.

- **Test-setup schema drift (LOW–MEDIUM).** `src/test/setup.ts` gives
  `callback_secret`/`exchange_rates.rate` defaults prod lacks, and branding color
  defaults that differ from `schema.ts`. No live bug today (all insert paths
  supply the values), but it weakens the suite's ability to catch future prod
  drift. The branding default mismatch also needs a decision on the canonical
  color. *File:* `src/test/setup.ts`.

---

# Frontend Audit — Usability / Accessibility / Localization — 2026-08-12

Three focused audits of `apps/frontend/src` (React components, pages, i18n).
After changes: typecheck ✅, lint ✅, 20 frontend tests ✅.

## Fixed on this branch

### Accessibility

- **`<html lang>` hardcoded to `en`** despite 25 supported languages — screen
  readers announced every localized page in English. Root layout now derives it
  from `getLang()`. *File:* `app/layout.tsx`.
- **Form controls not linked to their error/hint text** — `Input`/`Select` now
  set `aria-invalid` and `aria-describedby` pointing at id'd error/hint nodes.
- **Table headers had no `scope`**, and clickable rows weren't keyboard-operable
  — added `scope="col"`, plus `role="button"`/`tabIndex`/Enter-Space handling and
  a focus ring when `onRowClick` is used. *File:* `components/ui/Table.tsx`.
- **Modal had no accessible name** — linked the `<h2>` via `aria-labelledby`.
- **Error toasts weren't announced assertively** — error toasts now use
  `role="alert"` (success/info stay `role="status"`); decorative icon hidden.
- **Global search input had no accessible name** — added `aria-label`.
  *File:* `components/layout/Header.tsx`.
- **Full-page loading spinner announced nothing** — added `role="status"`.
- **No skip-to-content link** — added one targeting `<main id="main">`.
- **LanguageSwitcher dropdown couldn't be closed with the keyboard** — added
  Escape-to-close.
- **Low-contrast meaningful text** (`text-slate-400` on white, ~2.5:1) — bumped
  to `text-slate-500` for the table empty state and catalog counts/empty text.

### Usability

- **False "Saved!" on a failed price save (HIGH)** — a per-environment pricing
  save swallowed the error and always showed "Saved!". It now propagates the
  failure and the row shows the error. *File:* `admin/products/[id]/ProductEditForm.tsx`.
- **Silent delete/toggle/load failures in admin managers** — cost-centers,
  parameters, ci-sources, users and categories managers swallowed errors, so a
  failed delete left the modal stuck with no feedback and a failed list-load was
  indistinguishable from an empty list. Each now surfaces the error in the delete
  modal and/or a card banner. Same fix for the webhook/pipeline-stack/parameter
  delete handlers in `ProductEditForm`.

### Localization

- **Prices formatted with a hardcoded `en` locale** — `convertPrice` now takes a
  `locale` and formats grouping/decimals accordingly (e.g. `1.234,56` for de);
  callers pass the active language. *Files:* `lib/locale.ts`, `catalog/[id]/page.tsx`,
  `components/forms/OrderForm.tsx`.
- **Dates rendered in the server/browser default locale** — passed the active
  `lang` to `toLocale*` on the six list/detail sites where `lang` was already in
  scope (orders, projects, audit, dashboard, approvals, infrastructure).

## Deferred — needs translation resources or a larger rework

- **The entire `admin/**` subtree is not internationalized (systemic, HIGH).** No
  admin file uses `t()` — every PageHeader, Card/Modal title, table header, form
  label/placeholder/hint, button, option array and error string is hardcoded
  English. Fixing it means adding ~100+ new keys **and translating them into all
  25 languages**; that needs real translation (the app already ships an
  AI-translate feature for product content that could be leveraged), not
  hand-fabricated strings. Not attempted blind.
- **`StatusBadge` labels are hardcoded English** (7 of 8 status keys don't exist)
  — shown on orders, infrastructure, approvals, dashboard. Needs 7 keys × 25
  languages. *File:* `components/ui/StatusBadge.tsx`.
- **Order-detail and project-detail pages are fully hardcoded** (many keys already
  exist and could be wired up; a few are new). `lang` also needs plumbing there,
  which is why their date formatting wasn't localized above.
- **Dashboard footer + imprint page hardcoded**; **OrderForm** concatenates a
  hardcoded English sentence onto a translated string.
- **Hardcoded a11y labels** (`Modal` "Close", `Toast` "Dismiss", `Header` search
  button "Search", skip link) — English literals pending translation keys.
- **SSR/first-paint language flash** — `TopNav` and `(dashboard)/error.tsx` call
  `useLang()` with no server-provided initial value, so nav/error text renders in
  English until hydration. Thread the server `lang` in as the initial value.
- **Remaining usability polish**: audit filters aren't debounced (a request per
  keystroke); several managers lack success toasts for consistency; server list
  pages (orders/projects/catalog) swallow fetch errors and render as empty rather
  than routing to the error boundary; `EnvironmentsManager` uses a native
  `confirm()` for callback-secret regeneration (inconsistent with the app's modal
  pattern) and copy has no "Copied" feedback.
- **`Sidebar.tsx` is dead code** (not imported anywhere) and is fully hardcoded —
  delete it or translate it if it will be used.

---

# Deferred-Items Follow-up — 2026-08-12

Applied the remaining deferred fixes that were safe and verifiable, and added
regression tests. After this round: **743 backend** (+21) and **51 frontend**
(+31, from 20) tests. A subsequent **PR-review round** (CodeRabbit + Copilot)
addressed their inline findings and brought the suite to **747 backend + 53
frontend tests**, typecheck + lint clean across both apps. Test recommendations
at all levels are in `docs/TEST_PLAN.md`.

## Now fixed

### Backend
- **createOrder server-side validation + ownership (IDOR).** Loads the applicable
  parameter definitions (shared `loadApplicableParameters` in `catalog.ts`) and
  rejects missing-required / bad-typed params (400); a PM ordering into a project
  they don't own → 403; a product not offered in the chosen environment → 400.
- **Multi-pipeline order completion.** New `pipeline_status` JSONB column
  (migration `0005`) tracks per-pipeline status; an order completes only when all
  its pipelines succeed and fails if any fails.
- **Login rate-limit bypass.** `X-Forwarded-For` is trusted only when
  `TRUST_PROXY` is set; the attempts map is now bounded.
- **CI listing pagination.** GitLab/GitHub/Bitbucket list calls follow next-page
  cursors (capped at 10 pages).
- **Cascade-delete race.** `deleteProject`/`deleteProduct` await the destroy
  trigger before deleting so cascaded infra rows aren't removed mid-destroy.

### Frontend
- **StatusBadge i18n** (7 new status keys × 25 languages) — status labels now
  localize everywhere they appear.
- **SSR language flash** fixed for `TopNav` (server lang threaded in).
- **Audit filters debounced** (300ms) — no request per keystroke.
- **Server list pages** (orders/projects/catalog) surface fetch failures (error
  boundary / explicit error state) instead of a misleading empty state.
- **EnvironmentsManager** replaces native `confirm()` with the app's Modal, adds
  error handling and a "Copied" confirmation.
- **Order-detail, project-detail, footer, and imprint** pages internationalized
  (existing + new keys) with locale-aware dates.

### Tests added
- Backend: +21 regression tests (order validation/ownership, multi-pipeline,
  rate-limit spoofing, CI pagination, cascade ordering).
- Frontend: +31 tests — new component tests for `Input`, `Select`, `Table`,
  `Modal`, `Toast`, `StatusBadge`, plus `AuditTable` debounce, and lib tests for
  `i18n` (key/lang completeness + fallback) and `locale` (conversion + locale
  formatting).

## Still deferred (with reasons)

- **CI trigger-helper launch-failure contract.** `triggerProductWebhooks` /
  `triggerPipelineStacks` catch per-trigger launch errors and return only the
  IDs that launched. Consequences flagged in review: an approved order can
  complete when only a subset of its pipelines actually launched, and
  `deleteProject`/`deleteProduct` proceed with the cascade even if no destroy
  pipeline started (the awaited call can't signal that). Fixing this cleanly
  means changing the helpers to surface launch failures and having every caller
  (approve, decommission, project/product delete) react — a cross-cutting change
  beyond this PR's safe scope. This round hardened what it safely could: the
  status transitions are now atomic, the destroy rows are claimed before
  triggering, and the misleading "destroy complete before delete" comment was
  corrected. Full launch-failure propagation is tracked as a follow-up.
  *Resolved (issues #132/#134).* The pipelines-only wrappers are gone: every
  caller now uses the `*Tracked` variants and records a `trigger-failed:*`
  sentinel, so an order waiting on a trigger that never started cannot complete,
  and `deleteCategory` joined `deleteProject`/`deleteProduct` in refusing to
  cascade when a destroy could not be launched (issue #133).
- **Full `admin/**` CRUD form/manager i18n.** StatusBadge, detail pages, footer
  and imprint are done, but the admin create/edit/delete forms and manager
  headers remain hardcoded English — ~100 strings needing accurate translation
  into all 25 languages. This should be driven through the app's own AI-translate
  pipeline rather than hand-fabricated; not attempted blind.
- **Drizzle meta snapshots (0002–0005) — intentionally NOT regenerated.** The six
  SQL migrations are already applied to real databases (tracked by hash), so
  rewriting migration history would break deployed environments, and hand-writing
  accurate drizzle v7 snapshots for the manual migrations is error-prone. The
  runtime migrator (`readMigrationFiles`) is unaffected; only `drizzle-kit
  generate` is impacted. Fix in a dedicated effort: regenerate the snapshot chain
  with drizzle-kit and verify against a fresh DB before relying on `db:generate`.
- **GitHub workflow-run ID correlation** — needs a design decision (correlate via
  a unique dispatch input / run-name) and live-GitHub testing.
- **OAuth hardening** (id_token signature/`aud`/`iss` verification, `state`/`nonce`,
  moving the session JWT out of the callback URL) — a larger auth-flow rework.
- **`error.tsx` SSR language** — left as a `// TODO(i18n)` (an error boundary has
  no server-resolved lang; a synchronous cookie read risks a hydration mismatch).
- **Dropdown option-list validation** — the `parameters` table stores no allowed-
  options column, so dropdown values can't be constrained server-side yet.
