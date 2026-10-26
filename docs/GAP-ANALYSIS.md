# Gap analysis and next work — 2026-10-26

A survey of InfraShelf as it actually stands, what is missing, and an ordered
proposal for what to work next. Written from the code, the requirement
traceability table (`docs/requirements/requirements.md`), the issue tracker and
`docs/AUDIT.md` — not from what the README claims.

> **Revision note.** An earlier draft of this doc listed three "gaps" that do not
> survive a read of the code. They are retracted in §0 below, because a gap that
> is already closed is worse than no gap: it costs someone a second implementation
> and it hides the ones that are real. Everything else here was re-checked against
> `HEAD` on the `docs/gap-analysis` branch.

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

Six issues are open in total (#111, #109, #245, #307, #550, #584). Every
"shipped" row in the audit and the requirements is real. What is left is **one
half-built mechanism**, **requirement-to-product drift**, and **the
non-functional tail** (pagination, metrics). No large un-started feature remains
except the brownfield adoption queue (#109), and the two integration kinds with
no code behind them.

## Gaps, by kind

### A. Half-built: the external-system model (#111)

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

Two declared kinds have **no implementation module**:

- **Ansible** (#113) — no day-2 actions on an element (patch, restart, re-run).
  The infrastructure list is still read-only apart from retry / schedule /
  tear-down. Open question before any code: AWX / Automation Controller vs. a
  playbook run as just another pipeline step — very different amounts of work.
- **Nexus / Pulp** (#114) — nothing records what content an order was built
  from; "rebuild it the way it was" is not answerable for the artefact side. Open
  question: read-only reference first (the smaller, safer step, already unlocks
  the snapshot and policy uses) vs. writing on order.
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
4. **FA-11.3 — configurable base currency.** EUR is hardcoded; `grep baseCurrency`
   is empty; rates are shown only "to EUR".
5. **FA-15.4 — `APP_NAME` / `APP_SUBTITLE` override.** Neither var exists in the
   codebase; the requirement describes an override of nothing.

### C. Non-functional tail (small, concrete, real)

- **NFA-02.5 — unbounded list endpoints.** The pagination machinery is fully
  built and used by `orders.ts` and `infrastructure.ts` (`pageWindow` / `toPage`
  / `parsePageWindow` in `services/page.ts`). **The rest return whole tables:**
  approvals, projects, cart, favourites, comments, product versions, admin
  products, and the cost rows. A list's response still grows with the
  installation there. This is the cleanest, most bounded remaining item.
- **NFA-02.1 — the login rate limiter is in-process** (see §0): a documented
  trade-off; act only when replica count makes it binding.

### D. Observability

- **#550 — no per-request metrics.** `#548` added `GET /api/internal/metrics`
  for stored state; request rate / error rate / latency are still absent, and the
  reason is a decision: the Helm chart defaults to `replicaCount: 2` with an HPA
  to 6, so an in-handler counter lives in one pod (see the issue).
- **Logging is `console.*` only** (~25 calls in `lib/`). The Loki integration is
  now in, so shipping those lines somewhere readable is a small follow-on.

### E. Quality gates

- **#245 — mutation score.** Backend **72.89** (target 90); frontend **37.48**.
  The frontend is the cliff: roughly **half its mutants have no test near them**,
  so most of the distance is untested files, not weak assertions.
- **#307 — standing suite quality.** Assertions that cannot fail; tests passing
  for the wrong reason.
- **#584 — frontend flake under parallel load.** `ProductEditForm.test.tsx`
  times out only in a full 138-file run (passes 35/35 alone). Fix per the issue:
  a shared async budget.

### F. Brownfield

- **#109 — adopt resources created outside Terraform.** Needs a resource address,
  the provider id, and matching config; the issue is explicit that an automatic
  import + apply is "a way to delete production by cron". The shape is an admin
  **review queue**, not an automatic job. Not started — the one large un-started arc.

## Proposal — what to work next, in order

### Wave 1 — the bounded non-functional tail (implement now)

1. **Paginate the remaining list endpoints (NFA-02.5).** The helpers exist; apply
   `pageWindow` + `parsePageWindow` + `toPage` endpoint by endpoint, starting
   with the ones #158 named that genuinely grow: **approvals, projects, admin
   products, cost rows** (cart / favourites / comments are per-entity and small —
   decide last). Each is service + route + frontend + tests.
2. **Correct the requirement traceability rows** for the shell-verified cases
   (FA-17.1 → "via Loki"; the SSO and `APP_NAME` rows → removed). Cheap, and it
   stops the next reader rediscovering that the rows are wrong.

### Wave 2 — the design conversation for the half-built registry (#111)

3. **Ansible (#113) and Nexus/Pulp (#114).** Settle the open questions first
   (AWX vs pipeline step; read-only vs write), then build the consumer. Numbers
   first, then one implementation each.

### Wave 3 — drift that needs a decision (the owner's call)

4. **FA-04.2/FA-05.4 browse-and-pick UI** — fund it or drop it. If funded, the
   parser is done and this is the largest genuine product feature left.
5. **FA-11.3 base currency** — decide whether EUR is a constant by design.

### Wave 4 — quality gates (continuous)

6. **#245 frontend mutation** — add tests to the untested frontend files first
   (that is where the score is); raise the backend ratchet alongside.
7. **#584 flake fix**, then **#307** as the standing task.

### Wave 5 — larger arcs

8. **#550 request-path metrics** — settle the per-replica strategy, then
   instrument.
9. **#109 brownfield adoption** — the admin review queue.

## Recommended single next step

**Wave 1.1 — paginate the remaining list endpoints (NFA-02.5), starting with the
approvals list.** It is the cleanest real gap: the requirement is explicit, the
helpers already exist, the work is bounded and testable at every level, and it
closes a row that has been open since #158. Wave 1.2 (the requirement-row
corrections) is the natural companion. The Ansible/Nexus work in Wave 2 is
larger and should follow the design conversation, not precede it.
