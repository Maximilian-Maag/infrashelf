# Gap analysis and next work — 2026-10-26

A survey of InfraShelf as it actually stands, what is missing, and an ordered
proposal for what to work next. Written from the code, the requirement
traceability table (`docs/requirements/requirements.md`), the issue tracker and
`docs/AUDIT.md` — not from what the README claims.

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
"shipped" row in the audit and the requirements is real; the remaining gaps are
either **half-built mechanisms**, **requirement-to-product drift**, or **the
non-functional tail** (statelessness, pagination, metrics). There is no large
un-started feature left except the externally-created-resource adoption queue
(#109) and the two integration kinds with no code behind them.

## Gaps, by kind

### A. Half-built: the external-system model (#111)

The integration registry **is shipped and is good** — `integrations` table with
kinds `foreman | ansible | nexus | pulp | loki | grafana | opa`, encrypted
credentials, per-environment binding, an enable flag, a stored `failure_mode`
(`blocking`/`best_effort`), a probe/health path, and audit on every mutation
including credential rotation. But only three of the declared kinds have a
consumer:

- **Loki** — `lib/integrations/loki.ts` ✔
- **Grafana** — `lib/integrations/grafana.ts` ✔
- **Foreman** — `lib/integrations/foreman.ts` + `services/admin/foremanReconcile.ts` ✔
- **Ansible** (#113) — kind declared, **no module**. No day-2 actions on an
  element (patch, restart, rotate, re-run). The infrastructure list is still
  read-only apart from retry / schedule / tear-down.
- **Nexus / Pulp** (#114) — kinds declared, **no module**. Nothing records what
  content an order was built from; "rebuild it the way it was" is not answerable
  for the artefact side.
- **OPA** — declared kind; the portal's own policy engine is in-process
  (`lib/policy/*`), so the `opa` kind is a placeholder for an external evaluator.

This is the single largest remaining "missing system". The model already exists;
what is missing is the two consumers it was built to carry.

### B. Requirement-to-product drift (decide, don't just build)

These rows in `docs/requirements/requirements.md` say "Not shipped" and the
product has deliberately diverged. Each needs a decision — fund it or edit the
requirement — rather than being left ambiguous:

1. **FA-01.2 / NFA-03.1 — Entra ID SSO.** `#250` closed as "drop it": the
   hand-built callback was insecure and dead, so it was removed rather than
   reworked. The requirement still reads as a deliverable. Either delete the SSO
   rows or fund a real OIDC flow (needs a tenant to test against).
2. **FA-04.2 / FA-05.4 — browse-and-pick `variables.tf`.** This is the one
   substantive *product* feature genuinely not built. What exists
   ("Sync from template") requires a Pipeline Stack, reads only that stack's
   *first* step's fixed template path, and — because it derives the CI project id
   from the environment's Webhook URL with a GitLab-shaped regex — only works for
   GitLab sources. The HCL parser (`lib/tfparser`) is done; the browse UI is not.
3. **FA-11.3 — configurable base currency.** EUR is hardcoded; there is no
   `baseCurrency` column anywhere. Rates are only shown "to EUR".
4. **FA-15.4 — `APP_NAME` / `APP_SUBTITLE` override.** Neither env var exists in
   the codebase; the requirement describes an override of nothing.

### C. Non-functional tail (small, concrete, real)

- **NFA-02.1 — the login rate limiter is in-process state.** It keeps its
  counters in a `Map`, so it does not survive a restart and each replica enforces
  its own limit. This is the *only* remaining violation of "the container is
  stateless", and the 2FA limiter already shows the right pattern (a conditional
  `UPDATE` in the database, shared across replicas).
- **NFA-02.5 — unbounded list endpoints.** `orders.ts` and `infrastructure.ts`
  paginate (`pageWindow`/`toPage`); **the rest do not** — approvals, projects,
  cart, favourites, comments, product versions, admin products, and the cost
  rows still return whole tables. A list's response size still grows with the
  installation for those.
- **FA-01.6 — Root can place orders through the API.** The UI never offers it,
  but `POST /api/orders` has no role check and treats `root` as `admin`.

### D. Observability

- **#550 — no per-request metrics.** `#548` added `GET /api/internal/metrics`
  for stored state (element status, drift, policy verdicts, queue depth,
  integration health). There is still no request rate, error rate or latency, and
  the reason is a decision, not code: the Helm chart defaults to `replicaCount: 2`
  with an HPA to 6, so an in-handler counter lives in one pod. Scraping every pod
  and summing works only while every pod is scraped; scraping the Service gets a
  random sample that *looks* like a rate. This needs a chosen strategy.
- **Logging is `console.*` only** (~25 calls in `lib/`). The Loki integration is
  now in, so shipping those lines somewhere readable is a small follow-on.

### E. Quality gates

- **#245 — mutation score.** Backend **72.89** (target 90); frontend **37.48**.
  The frontend is the cliff and its shape is known: roughly **half its mutants
  have no test near them at all**, so most of the distance is untested files, not
  weak assertions. `break` is a ratchet, not 90, on purpose.
- **#307 — standing suite quality.** A permanent task: assertions that cannot
  fail, tests passing for the wrong reason, wrong test level.
- **#584 — frontend flake under parallel load.** `ProductEditForm.test.tsx`
  times out only in a full 138-file run; passes 35/35 alone. Fix per the issue: a
  shared async budget (`configure({ asyncUtilTimeout })` / higher `testTimeout`).

### F. Brownfield

- **#109 — adopt resources created outside Terraform.** The drift sweep (#108,
  closed) reconciles what Terraform already manages; a hand-made object is absent
  from state and no refresh will find it. Adoption needs a resource address, the
  provider id, and matching config — and the issue is explicit that an automatic
  import + apply is "a way to delete production by cron". The shape is an admin
  **review queue** of candidates, not an automatic job. Not started.

## Proposal — what to work next, in order

### Wave 1 — finish what is half-built (highest value per unit effort)

1. **Nexus/Pulp read-only binding (#114).** The registry is done; add the
   consumer that *reads* repositories/content-views and lets an environment name
   them, so provisioning passes them instead of each product hardcoding a URL,
   and an order records the pinned version. Reading first, writing later.
2. **Terraform outputs for GitHub/Bitbucket via Loki (FA-17.1).** Today only
   GitLab job traces are fetched (`supportsJobTrace`), so non-GitLab elements
   get no parsed outputs. The Loki integration now exists — pipeline logs are
   readable whatever the provider — so this hole can close with the mechanism
   already in the tree.
3. **Ansible day-2 actions (#113).** The most user-visible missing capability:
   the element list becomes operable (patch/restart/re-run) with the same audit
   and role gate as retry/decommission. Decide AWX/Controller vs. a pipeline step
   first — that is the open question.

### Wave 2 — small correctness/hygiene fixes (one PR each, low risk)

4. **Root role check on `POST /api/orders` (FA-01.6).** Reject `root`; assert it
   in `e2e/roles.spec.ts`, which is the executable role table.
5. **Move the login rate limiter to the database (NFA-02.1).** Copy the 2FA
   limiter's conditional-`UPDATE` pattern. Removes the last statelessness
   violation and makes the limit correct across replicas.
6. **Paginate the remaining list endpoints (NFA-02.5).** Apply `pageWindow`
   endpoint by endpoint: approvals, projects, cart, favourites, comments, product
   versions, admin products, cost rows.

### Wave 3 — reconcile the requirements with reality (decide, then document)

7. **Edit or fund the four drift rows** (SSO, browse-and-pick `variables.tf`,
   base currency, `APP_NAME` override). Recommended split:
   - *Delete* the SSO rows (the product decided against it in #250) and the
     `APP_NAME`/`APP_SUBTITLE` row (the vars never existed).
   - *Fund* the browse-and-pick `variables.tf` UI (FA-04.2/FA-05.4) — it is the
     one real product feature left, and the parser it needs is already written.
   - *Fund* a `baseCurrency` setting (FA-11.3) — small, and it makes the
     exchange-rate screen honest.

### Wave 4 — quality gates (continuous)

8. **#245 frontend mutation:** add tests to the untested frontend files first —
   that is where the score is: for the frontend, half the mutants have no test
   near them, so most of the climb is files with no test rather than weak
   assertions in tested ones. Raise the backend ratchet alongside.
9. **#584 flake fix**, then **#307** as the standing task.

### Wave 5 — larger arcs (pick up when the above is done)

10. **#550 request-path metrics** — settle the per-replica strategy first, then
    instrument the request path and extend the metrics endpoint.
11. **#109 brownfield adoption** — the admin review queue.

## Recommended single next step

If one thing is taken now: **Wave 1.2 — close FA-17.1 and parse Terraform
outputs for non-GitLab providers through the Loki integration already in the
tree.** It is bounded, it turns an existing mechanism (Loki) loose on a
documented capability hole, and it is the shortest path from "ordered infra" to
"infra whose outputs are visible" for the two providers that currently get none.
Wave 2 items 4–6 are the natural filler between it and the bigger arcs.
