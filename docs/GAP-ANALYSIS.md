# Gap analysis and next work — 2026-10-26 (revised 2026-10-29)

A survey of InfraShelf as it actually stands, what is missing, and an ordered
proposal for what to work next. Written from the code, the requirement
traceability table (`docs/requirements/requirements.md`), the issue tracker and
`docs/AUDIT.md` — not from what the README claims.

> **Revision note.** An earlier draft of this doc listed three "gaps" that do not
> survive a read of the code. They are retracted in §0 below, because a gap that
> is already closed is worse than no gap: it costs someone a second implementation
> and it hides the ones that are real. Everything else here was re-checked against
> `HEAD` on the `docs/gap-analysis` branch.
>
> **2026-10-29.** Five more "gaps" were re-checked while working through the
> backlog and five more turned out to be built or already decided — §0 has grown
> accordingly. The pattern is worth naming: the ISSUE BODIES are the stale
> artefact, not this doc. Four separate items in this revision were picked up as
> pending work and found complete one command later. When starting anything from
> an issue body, grep for the thing first.

## 0. Retracted — verified already done or deliberately decided

- **FA-17.1 (Terraform outputs on GitHub/Bitbucket) is BUILT.** The requirement
  row and an earlier draft of this doc both say outputs are GitLab-only. That was
  true of `supportsJobTrace` (`lib/ci/index.ts:83`, still `provider === 'gitlab'`)
  but is no longer true of the *output path*: `readOutputsForElement`
  (`lib/webhook/outputs.ts:154`) reads the element's log from a **Loki**
  integration first and falls back to the provider job API only when there is no
  Loki or it gave nothing; both callers (`webhook/settle.ts:200`,
  `services/infrastructure.ts:1077`) resolve `resolveIntegration('loki', envId)`
  and pass it. So a GitHub/Bitbucket element *does* get parsed outputs whenever
  its environment has a Loki. The accurate requirement verdict is "Shipped —
  natively on GitLab; on any provider via a Loki integration", and the row should
  be corrected rather than a feature built.
- **FA-01.6 (Root may not place orders) conflicts with a shipped feature.**
  `createOrder` treats `root` as `admin` on purpose: root's audited escape from a
  policy refusal (`overridePolicy`) and from an exhausted budget
  (`overrideBudget`) only mean anything if root can reach the order path
  (`services/orders.ts:1231`, `:1314`). The requirement is drift — either root
  may order (and the requirement is wrong), or the two override rights need a
  different home. **Decide; do not "fix" by blocking root.**
- **NFA-02.1 (statelessness) is a documented, accepted trade-off.**
  `lib/rateLimit.ts` states it plainly: the counter is in-process, the effective
  cap is "the configured one times the number of instances", that is accepted for
  both callers today, and a shared store is the fix *when it becomes the binding
  constraint*. Not an oversight — reclassify as "decide when multi-replica".
- **#111's own bullets are BUILT, not half-built.** §A below calls this a
  half-built mechanism; the registry, the encrypted credentials, the health
  surface and the failure semantics all exist. `integrations` sits deliberately
  beside `ci_sources` (`schema.ts:524`, "TAKEN AND DEFERRED, not overlooked");
  credentials are AES-256-GCM at rest in both tables, with a legacy-token
  backfill (`encryptLegacyCiTokens`), a refusal to store a token with no key, and
  boot validation of `SECRET_ENCRYPTION_KEY`; health is `lastContactedAt` +
  `lastError` in `publicColumns`, rendered by `IntegrationsManager`, audited on
  probe and exposed as `infrashelf_integration_health` with `never_probed` as a
  state and not a gap; and failure semantics are `blocksProvisioning()` →
  `blocking` on `resolveIntegration`'s result → **consumed** at
  `policy/gate.ts:113`. The audit-of-outbound-calls bullet is vacuous — every
  call site is a read. What is left in #111 is the **five systems**, each gated on
  a product decision.
- **#550's estate half is shipped** (the 2026-10-29 split). `lib/metrics/catalog.ts`
  now states the split in the code: per-request numbers are out by design, and
  everything answerable from stored rows belongs in the endpoint —
  `infrashelf_order_placed_timestamp_seconds` +
  `infrashelf_element_deployed_timestamp_seconds` make provisioning duration a
  subtraction (#601), and the approval-queue depth was already there. Pipeline
  success rate and the sweep outcomes are ratios over families that exist. Only
  rate / error-rate / latency remain, and only behind the per-replica decision.
- **#109 is blocked on a prerequisite in ANOTHER repository.** Its own body asks
  whether provisioning tags resources with the order/element id. It does not:
  `schema.ts:1313` records that `infra-templates` filters `ORDER_ID` and
  `INFRA_ID` out of the `TF_VAR` export, and there is not one `.tf` file in this
  repo (`docs/guides/gitlab-opentofu-workflow.md`). Discovery has nothing to look
  for until that changes. The in-repo half that IS detectable is `unclaimed_states`
  (#108, `schema.ts:1322`) — a state file the portal cannot account for.
- **#245's gap is uncovered LINES, not missing files.** The body and
  `stryker.config.mjs` both say "roughly two thirds of the frontend gap is files
  with no test near them at all". A scan of every frontend source file's stem
  across all `*.test.ts(x)` finds exactly ONE file with no test referencing it
  (`app/offline/OfflineRetry.tsx`, covered in #599). Everything else is imported
  by some test. The target list has to come from a Stryker survivor report, not a
  file scan.

## Where the system stands

The roadmap is essentially **spent**. Eight milestones, seven complete:

| Milestone | Open | Closed |
|---|---:|---:|
| 1 Access, sessions and approvals | 0 | 43 |
| 2 Ordering model: size, quantity, product page | 0 | 20 |
| 3 Accessibility and internationalisation | 0 | 26 |
| 4 Brownfield: drift, adoption and policy | 1 | 10 |
| 5 External systems | 1 | 27 |
| 6 Reporting, docs and tooling | 1 | 130 |
| 7 Review sweep: setup, images, infrastructure detail | 0 | 28 |
| 8 Role journeys and e2e parallelism | 1 | 35 |

Five issues are open in total (#111, #109, #245, #307, #550) — #584, the
frontend flake, was fixed by a shared async budget for the suite rather than one
`it` at a time. Every
"shipped" row in the audit and the requirements is real. What is left is **five
un-built integration kinds, all behind a product decision**, **requirement-to-
product drift**, and **the non-functional tail** (the last of the pagination, and
the per-request half of the metrics). No large un-started feature remains
except the brownfield adoption queue (#109), and the two integration kinds with
no code behind them.

## Gaps, by kind

### A. Built model, unbuilt systems (#111) — *heading corrected 2026-10-29*

The integration registry **is shipped and is good** — the `integrations` table
carries kinds `foreman | ansible | nexus | pulp | loki | grafana | opa`
(`INTEGRATION_KINDS`, `schema.ts:515`), encrypted credentials, per-environment
binding, an enable flag, a stored `failure_mode` (`blocking`/`best_effort`), a
probe/health path, and audit on every mutation including credential rotation.
Three kinds have consumers, and each is complete:

- **Loki** — `lib/integrations/loki.ts`: read-only `query_range`, per-element
  selector, `X-Scope-OrgID` tenant, truncation reporting. Doubles as the
  provider-independent output channel above.
- **Grafana** — `lib/integrations/grafana.ts` ✔
- **Foreman** — `lib/integrations/foreman.ts` + `services/admin/foremanReconcile.ts` ✔

Two unfinished workstreams cover **three declared kinds with no implementation
module** — `nexus` and `pulp` are separate `INTEGRATION_KINDS` values but one
item, so the count of kinds and the count of workstreams differ:

- **Ansible** (#113) — one kind, `ansible`. No day-2 actions on an element (patch, restart, re-run).
  The infrastructure list is still read-only apart from retry / schedule /
  tear-down. Open question before any code: AWX / Automation Controller vs. a
  playbook run as just another pipeline step — very different amounts of work.
- **Nexus / Pulp** (#114) — two kinds, `nexus` and `pulp`. Nothing records what
  content an order was built from; "rebuild it the way it was" is not answerable
  for the artefact side. Open question: read-only reference first (the smaller,
  safer step, already unlocks the snapshot and policy uses) vs. writing on order.
- **OPA** — declared kind; the portal's own policy engine is in-process
  (`lib/policy/*`) with an optional external evaluator (`policy/client.ts`). Fine
  as-is.

This is the largest remaining "missing system", but the two items left have
**open design questions**, so they are a design conversation, not just work.

### B. Requirement-to-product drift (decide, don't build)

Rows in `docs/requirements/requirements.md` that say "Not shipped" while the
product deliberately diverged. None should be built blind:

1. **FA-01.2 / NFA-03.1 — Entra ID SSO.** `#250` closed as "drop it" (the
   callback was insecure and dead). The requirement rows still read as a
   deliverable — delete them, or fund a real OIDC flow (needs a tenant to test).
2. **FA-01.6 — root cannot order** (see §0). Decide whether root ordering is
   intended (it currently is, and the override rights depend on it).
3. **FA-04.2 / FA-05.4 — browse-and-pick `variables.tf`.** The one substantive
   *product* feature genuinely not built. "Sync from template" requires a
   Pipeline Stack, reads only that stack's *first* step's template path, and —
   via a GitLab-shaped regex over the environment's Webhook URL — only works for
   GitLab sources. The HCL parser (`lib/tfparser`) is done; the browse UI is not.
4. ~~**FA-11.3 — configurable base currency.**~~ **DONE (#591 backend, #592
   frontend).** The base currency is a setting (`app_config.base_currency`, default
   EUR), root-settable, re-basing the stored rates onto the chosen anchor; the
   conversion helpers and the exchange-rate screen now follow it.
5. **FA-15.4 — `APP_NAME` / `APP_SUBTITLE` override.** Neither var exists in the
   codebase; the requirement describes an override of nothing.

### C. Non-functional tail (small, concrete, real)

- **NFA-02.5 — unbounded list endpoints.** Mostly closed. The machinery
  (`pageWindow` / `toPage` / `parsePageWindow` in `services/page.ts`) now backs
  the catalogue, orders, infrastructure, audit, the admin product list and the
  cost-row export (counted, refused 413 past `EXPORT_MAX_ROWS`). What an
  inspection of the rest found: the approval queue is already the paged
  `/api/orders?status=pending` (`GET /api/approvals` is unused), and `projects`,
  `cart`, `favourites`, `comments` and product `versions` are bounded by one
  user's or one entity's data rather than by the installation — `projects` also
  feeds four dropdowns, so it is not pageable as-is. The remaining real work here
  is small.
- **NFA-02.1 — the login rate limiter is in-process** (see §0): a documented
  trade-off; act only when replica count makes it binding.

### D. Observability

- **#550 — the estate half shipped; the request half is a decision.**
  `GET /api/internal/metrics` (`#548`) carries the stored state, and since
  2026-10-29 that includes provisioning duration, as the two timestamps it is a
  subtraction of (`#601`). Request rate / error rate / latency are still absent,
  for a reason that is a decision and not a gap: the Helm chart defaults to
  `replicaCount: 2` with an HPA to 6, so an in-handler counter lives in one pod.
  Reading them from the ingress controller instead needs no per-pod choice at all
  and is the smaller answer (see the issue).
- **Logging is `console.*` only** (~25 calls in `lib/`). The Loki integration is
  now in, so shipping those lines somewhere readable is a small follow-on.

### E. Quality gates

- **#245 — mutation score.** Backend **72.89** (target 90); frontend **37.48**.
  The earlier claim here that "most of the distance is untested files" is
  **wrong** — see §0. Exactly one frontend source file had no test (now covered);
  the gap is uncovered lines inside tested files, so the target list has to come
  from a Stryker survivor report rather than a file scan.
- **#307 — standing suite quality.** Assertions that cannot fail; tests passing
  for the wrong reason. One instance of the "skipped assertion" class was fixed in
  `#600` (three sites, each proven by mutation); the class is mechanically
  detectable and is the obvious candidate for a **policy rule** rather than
  another manual sweep.
- ~~**#584 — frontend flake under parallel load.**~~ **DONE.** Fixed with a
  shared async budget for the suite (`vitest.config.ts` per-test budget,
  `src/test/setup.ts` RTL wait ceiling) rather than one `it` at a time: the same
  load made a different file fail each run (ProductEditForm, then InfraFilters,
  then IntegrationsManager), so a per-test fix could not hold.

### F. Brownfield

- **#109 — adopt resources created outside Terraform.** Needs a resource address,
  the provider id, and matching config; the issue is explicit that an automatic
  import + apply is "a way to delete production by cron". The shape is an admin
  **review queue**, not an automatic job. **Blocked on a prerequisite in another
  repository** — see §0: `infra-templates` filters `ORDER_ID`/`INFRA_ID` out of
  the `TF_VAR` export, so nothing provisioned carries an id for discovery to find.
  The in-repo piece that can be built today is `unclaimed_states` (#108).

## Proposal — what to work next, in order

### Wave 1 — the bounded non-functional tail (implement now)

1. ~~**Paginate the remaining list endpoints (NFA-02.5).**~~ **DONE** for the
   endpoint that genuinely grew: the **admin product list** (paged, with a Pager)
   and the **cost-row export** (counted, refused 413 past `EXPORT_MAX_ROWS`).
   The rest named in #158 was inspected rather than changed — the approval queue
   is already the paged `/api/orders?status=pending`, `GET /api/approvals` is
   unused, and cart / favourites / comments / versions are per-entity. See §C.
   The one open item is `projects`, which cannot be paged as-is because it feeds
   four dropdowns that need the whole list.
2. **Correct the requirement traceability rows** for the shell-verified cases
   (FA-17.1 → "via Loki"; the SSO and `APP_NAME` rows → removed). Cheap, and it
   stops the next reader rediscovering that the rows are wrong.

### Wave 2 — the design conversation for the unbuilt SYSTEMS (#111)

3. **Ansible (#113) and Nexus/Pulp (#114).** Settle the open questions first
   (AWX vs pipeline step; read-only vs write), then build the consumer.
   Decisions first, then one implementation each.

### Wave 3 — drift that needs a decision (the owner's call)

4. **FA-04.2/FA-05.4 browse-and-pick UI** — fund it or drop it. If funded, the
   parser is done and this is the largest genuine product feature left.
5. ~~**FA-11.3 base currency** — decide whether EUR is a constant by design.~~
   **Decided and shipped**: not a constant — configurable, EUR by default (#591/#592).

### Wave 4 — quality gates (continuous)

6. **#245 mutation** — the target list comes from a Stryker survivor report, NOT
   from hunting untested files (see §0: there was exactly one). Then raise the
   ratchet, and decide whether the release gate stays at 90.
7. ~~**#584 flake fix**~~ **DONE** (shared async budget). **#307** continues as
   the standing task; the highest-value item in it is a **policy rule** for the
   skipped-assertion pattern, which is mechanically detectable.

### Wave 5 — larger arcs

8. **#550 request-path metrics** — the estate half is shipped; settle the
   per-replica strategy (or read them from the ingress controller) and instrument
   only if the portal is to own them.
9. **#109 brownfield adoption** — blocked on the `infra-templates` tagging change;
   the buildable piece here is `unclaimed_states` (#108).

## Recommended single next step

**Wave 3 — answer the decision list.** Almost everything above that is NOT a
decision has now been done, and the remainder is blocked on one: the five
integration kinds (AWX vs pipeline step; Nexus read vs write; whether Katello is
in play; Loki's tenant model; whether Grafana alerts POST back), whether to fund
the `variables.tf` picker, the mutation thresholds, and the brownfield tagging.

The one large piece of work that needs no decision at all is **`unclaimed_states`
(#108)** — the state files the portal cannot account for. It is modelled in the
schema already, it needs no cross-repo change, and it is the honest half of the
brownfield arc that is buildable today.

Do NOT start from an issue body without grepping first. Five items in this
revision were picked up as pending and found complete (§0) — the bodies are the
stale artefact.
