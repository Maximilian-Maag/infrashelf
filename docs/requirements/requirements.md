# Requirements Open Hybrid Cloud

## 1. Functional Requirements

### FA-01 User Roles and Access Rights

| ID | Requirement | Traceability |
|----|-------------|--------------|
| FA-01.1 | The system recognizes three roles: **Admin**, **Project Manager**, and **Root**. | Shipped — role enum in `apps/backend/src/lib/db/schema.ts`, checked throughout `apps/backend/src/lib/auth/middleware.ts` |
| FA-01.2 | Admins and Project Managers authenticate with email and password. Microsoft Entra ID (OIDC) SSO is optionally supported and configurable via environment variables. | Shipped — `apps/backend/src/app/api/auth/login/route.ts`, `apps/backend/src/app/api/auth/callback/route.ts` |
| FA-01.3 | The Root uses a local account. Local accounts can only be created by the Root. | Shipped — `apps/frontend/src/app/(dashboard)/admin/users/UsersManager.tsx` (root-only page) |
| FA-01.4 | Admins can see all orders, projects, and infrastructure elements of all users. | Shipped — `apps/backend/src/lib/services/orders.ts:77,107` |
| FA-01.5 | Project Managers can only see their own orders, projects, and infrastructure elements. | Shipped — same scoping in `orders.ts` |
| FA-01.6 | The Root can see all projects and infrastructure elements, but cannot place orders. | Partially shipped — the UI never offers ordering to Root, but `POST /api/orders` has no role check and treats `root` the same as `admin` (`apps/backend/src/lib/services/orders.ts:77,298`), so a Root session can place an order directly through the API today. |

---

### FA-02 Product Catalog

| ID | Requirement | Traceability |
|----|-------------|--------------|
| FA-02.1 | Products are organized into categories. Categories are manageable by the Root. | Shipped — `apps/backend/src/lib/db/schema.ts` `categories`; `docs/guides/root.md` §3 |
| FA-02.2 | Each product has: name, description, image, category, parameter sets, and prices per deployment environment. | Shipped — `schema.ts` `products`/`productEnvironments` |
| FA-02.3 | Product images are stored in the database (PostgreSQL `bytea`). | Shipped — `schema.ts` products `imageData`/`imageMime`/`imageAlt` |
| FA-02.4 | Product content (name, description) is multilingual (all 24 EU official languages + Russian). | Shipped — `productTranslations` table; all 25 offered when a product is written or translated (`LANGUAGE_OPTIONS`), where the admin forms used to list four |
| FA-02.5 | Each product can be available in one or more deployment environments. | Shipped — `productEnvironments` join table |
| FA-02.6 | Price and cost center configuration can be defined separately per product and environment. | Shipped — same table, per-row `price`/`costCenterMode` |

---

### FA-03 AI-Assisted Translation

| ID | Requirement | Traceability |
|----|-------------|--------------|
| FA-03.1 | The translation feature is optional. Without a configured AI provider, it is hidden. | Shipped |
| FA-03.2 | The Root selects an AI provider in the admin panel and provides the endpoint, API key, and model. | Shipped — `apps/frontend/src/app/(dashboard)/admin/config/ai/AiConfigForm.tsx`; endpoint is optional (defaults per provider) |
| FA-03.3 | Supported providers: Claude (Anthropic), OpenAI, Azure OpenAI (Cloud); Ollama, LocalAI (On-Premise). | Shipped — same form's `PROVIDERS` list; `apps/backend/src/lib/ai/index.ts` |
| FA-03.4 | The admin creates product content in a base language and can trigger AI translation with a single click. | Shipped — product edit page "Generate AI Translation" |
| FA-03.5 | All AI-generated translations can be manually corrected before saving. | Shipped |

---

### FA-04 Product Parameters

| ID | Requirement | Traceability |
|----|-------------|--------------|
| FA-04.1 | Parameters are inherited in a hierarchy: Global → Category → Product → Environment. | Shipped — `apps/backend/src/lib/db/schema.ts` `parameters.scope` |
| FA-04.2 | When creating a product, the Root can import `variables.tf` files from configured GitLab repositories. Parameters are extracted via an HCL parser (name, type, description, default value, validation, sensitive flag). | Partially shipped, and not as described — there is no browse-and-pick UI at product-creation time. The actual mechanism is **Sync from template** on the product edit page (`docs/guides/root.md` §4.1), which requires a Pipeline Stack to already exist, reads only that stack's *first step's* fixed template path, and — because it derives the CI project id from the environment's Webhook URL with a GitLab-shaped regex — only works when the environment's CI source is GitLab. See `apps/backend/src/app/api/admin/products/[id]/sync-parameters/route.ts`. The HCL parser itself (`apps/backend/src/lib/tfparser`) is shipped. |
| FA-04.3 | Parameters can be created, edited, and deleted manually. | Shipped |
| FA-04.4 | Global parameter sets can be defined that apply to all products and environments. | Shipped |
| FA-04.5 | Category parameter sets can be defined that apply to all products within a category. | Shipped |
| FA-04.6 | Parameters can be marked as environment-specific (apply only to selected environments). | Shipped |

---

### FA-05 Deployment Environments and GitLab Sources

| ID | Requirement | Traceability |
|----|-------------|--------------|
| FA-05.1 | Multiple GitLab instances can be configured as sources (name, URL, access token). | Shipped, and broader than written — sources are no longer GitLab-only: `apps/backend/src/lib/db/schema.ts:77-83` `ciSources.provider` enum is `gitlab \| github \| bitbucket`, configured under **Administration → CI Sources** (`apps/frontend/src/app/(dashboard)/admin/ci-sources/CiSourcesManager.tsx`). There is no connectivity test on this form. |
| FA-05.2 | Multiple deployment environments can be configured (e.g., "AWS Frankfurt", "On-Premise Vienna"). | Shipped |
| FA-05.3 | Each deployment environment references a GitLab source and a specific repo/webhook. | Shipped, provider-agnostic — references any configured CI source, not GitLab specifically |
| FA-05.4 | When creating a product, the Root can browse repositories on configured GitLab sources and select `variables.tf` files. | Not shipped as written — no such browse-and-pick UI exists; see the FA-04.2 note on what "Sync from template" actually does and its GitLab-only limitation. |
| FA-05.5 | Each deployment environment stores two independent secrets: a **webhook token** used by the portal to trigger pipelines outbound (`POST /projects/:id/trigger/pipeline`), and a portal-generated **callback secret** used to authenticate inbound pipeline-event webhooks (validated against the `X-Gitlab-Token` header). Both can be rotated independently via the admin UI. | Shipped for GitLab exactly as described; for GitHub/Bitbucket sources the same callback secret is instead used as an HMAC key checked against `X-Hub-Signature-256`/`X-Hub-Signature` — see `apps/backend/src/app/api/webhooks/{github,bitbucket}/*/route.ts`. |

---

### FA-06 Order Process

| ID | Requirement | Traceability |
|----|-------------|--------------|
| FA-06.1 | Orders must be assigned to a project. | Shipped |
| FA-06.2 | The orderer selects the deployment environment during the ordering process. | Shipped |
| FA-06.3 | The order form is generated dynamically from the applicable parameter sets. | Shipped |
| FA-06.4 | Each order item must be assigned to a cost center (mode: project, selection, or shared cost center). | Shipped — labelled "From Project" / "User Selection" / "Overhead" in the UI |
| FA-06.5 | Admins trigger the GitLab provisioning webhook directly after checkout. | Shipped, provider-agnostic — triggers whichever CI provider the environment's source uses, not GitLab specifically |
| FA-06.6 | Orders from Project Managers wait for approval by an Admin after checkout. | Shipped |
| FA-06.7 | An existing project can be used as a template for a new order (parameters are pre-filled). | Shipped, beyond what's written — a **cart** (`cart_items` table, `/cart`) and **trials** (opt-in per offering, auto-scheduled decommission) also ship now; neither is mentioned by this requirement. See `docs/guides/admin.md` §2.2–2.5. |

---

### FA-07 Approval Workflow

| ID | Requirement | Traceability |
|----|-------------|--------------|
| FA-07.1 | Any Admin can approve or reject pending orders from Project Managers. | Shipped |
| FA-07.2 | A comment is mandatory when rejecting an order. | Shipped |
| FA-07.3 | Approval triggers the GitLab provisioning webhook with the order parameters. | Shipped, provider-agnostic (see FA-06.5) |
| FA-07.4 | Rejection with the mandatory comment is delivered to the Project Manager via email. | Shipped — `apps/backend/src/lib/notification/index.ts` `sendOrderRejected`; note the email contains no link back to the order |

---

### FA-08 Infrastructure Overview

| ID | Requirement | Traceability |
|----|-------------|--------------|
| FA-08.1 | Deployed infrastructure elements are displayed grouped by project and deployment environment. | Shipped |
| FA-08.2 | Admins and Root users can see all projects. Project Managers only see their own. | Shipped |
| FA-08.3 | Each infrastructure element shows: product, environment, order parameters, status, price, cost center. | Shipped, and the detail page shows more than listed: OpenTofu outputs, pipeline ids/status, redacted-parameter notes, and a scheduled-decommission time. See `docs/guides/admin.md` §5. |

---

### FA-09 Decommissioning

| ID | Requirement | Traceability |
|----|-------------|--------------|
| FA-09.1 | Infrastructure elements can be decommissioned from within the infrastructure overview. | Shipped, plus a **scheduled** decommission not mentioned here — see README "Scheduled decommissioning" and `docs/guides/admin.md` §5.2 |
| FA-09.2 | Admins can decommission all infrastructure elements. Project Managers can only decommission their own. | Shipped |
| FA-09.3 | Decommissioning triggers the GitLab destroy webhook of the associated OpenTofu module. | Shipped, provider-agnostic (see FA-06.5) |
| FA-09.4 | The decommissioning status is updated via CI provider webhook callback (`POST /api/webhooks/{provider}/pipeline`). | Partially false as written — that exact path pattern only holds for GitLab (`/api/webhooks/gitlab/pipeline`) and Bitbucket (`/api/webhooks/bitbucket/pipeline`); GitHub's route is `/api/webhooks/github/workflow`. The underlying behavior (status updated via webhook callback) is shipped. |
| FA-09.5 | When a **project** is deleted, all active infrastructure elements belonging to that project are automatically decommissioned (destroy webhook fired) before the project record is removed. | Shipped |
| FA-09.6 | When a **product** is deleted, all active infrastructure elements provisioned from that product are automatically decommissioned before the product record is removed. | Shipped |
| FA-09.7 | When a **category** is deleted, all active infrastructure elements belonging to any product in that category are automatically decommissioned before the category record is removed. | Shipped |
| FA-09.8 | Infrastructure already in status *Decommissioning* or *Decommissioned* is skipped during cascade decommissioning. | Shipped |

---

### FA-10 Projects and Cost Centers

| ID | Requirement | Traceability |
|----|-------------|--------------|
| FA-10.1 | Users can create and manage projects. | Shipped |
| FA-10.2 | Project Managers must be able to assign a cost center to each project. | Shipped |
| FA-10.3 | The Root maintains a list of available cost centers. | Shipped — **Administration → Cost Centers** |
| FA-10.4 | The Root can configure the cost center assignment mode per product: **Project** (cost center of the project), **Selection** (orderer selects from list), **Shared Cost Center** (fixed overhead). | Shipped — mode is set per product **environment**, not per product as a whole; UI labels are "From Project" / "User Selection" / "Overhead" |
| FA-10.5 | The Root can set a mode as default and either enforce it or only suggest it. | Shipped — the **Forced CC** checkbox; see `docs/guides/root.md` §4.1 Step 6 |

---

### FA-11 Prices and Currencies

| ID | Requirement | Traceability |
|----|-------------|--------------|
| FA-11.1 | Prices are informational only (no payment processing). | Shipped |
| FA-11.2 | Prices are stored per product and deployment environment in the base currency. | Shipped, but "the base currency" is a fixed constant, not a setting — see FA-11.3 |
| FA-11.3 | The base currency is globally configurable (default: EUR). | **Not shipped** — EUR is hardcoded; there is no `baseCurrency` field anywhere and no admin control to change it. `apps/backend/src/lib/db/schema.ts` has no such column, and `apps/frontend/src/app/(dashboard)/admin/exchange-rates/ExchangeRatesTable.tsx` only shows rates "to EUR" with no currency selector. `docs/guides/root.md` §2.4 previously claimed this control existed; corrected in this pass. |
| FA-11.4 | The displayed currency is based on the user's locale (e.g., pl → PLN, cs → CZK). | Shipped — `apps/frontend/src/lib/locale.ts` |
| FA-11.5 | Exchange rates are fetched from an external API and cached in the database. | Shipped — `apps/backend/src/lib/exchange`, `EXCHANGE_RATE_API_URL` |
| FA-11.6 | The Root can manually refresh the exchange rates. | Shipped for the **refresh** action (**Refresh Rates** button) — but "manually refresh" here does not extend to manually editing an individual rate; there is no such control (see `docs/guides/root.md` §2.4). |

---

### FA-12 Localization

| ID | Requirement | Traceability |
|----|-------------|--------------|
| FA-12.1 | The UI is available in all 24 EU official languages and Russian. | Shipped — `apps/frontend/src/lib/i18n.ts` `SUPPORTED_LANGUAGES` (25 entries) |
| FA-12.2 | Language selection is based on the user's session preference, with fallback to the Accept-Language header. | Shipped |
| FA-12.3 | Product content (name, description) is loaded language-specifically from a translation table. | Shipped — one shared lookup, `apps/backend/src/lib/services/productName.ts`, used by every read path that names a product. Until issue #162 only the catalogue honoured the requested language and nine other surfaces hardcoded English |

---

### FA-13 Notifications

| ID | Event | Recipient | Traceability |
|----|-------|-----------|--------------|
| FA-13.1 | Order received (Project Manager) | Orderer (confirmation) + all Admins (approval request) | Shipped — `sendOrderCreated` + `sendApprovalRequest` in `apps/backend/src/lib/notification/index.ts` |
| FA-13.2 | Order received (Admin) | Orderer (confirmation) | Shipped |
| FA-13.3 | Approval granted | Orderer | Shipped — `sendOrderApproved` |
| FA-13.4 | Rejection with mandatory comment | Orderer | Shipped — `sendOrderRejected` |
| FA-13.5 | Deployment completed | Orderer | Shipped — `sendProvisioningCompleted` |
| FA-13.6 | Deployment failed | Orderer + all Admins | Shipped — `apps/backend/src/lib/webhook/handler.ts:287-296` sends `sendProvisioningFailed` to the orderer and every admin (deduplicated) |
| FA-13.7 | Decommissioning completed | Orderer | Shipped — `sendDecommissioned` |
| — | *(not in this requirement)* | — | Additional notification not listed here: a non-internal order comment emails the orderer and Admins (`sendOrderComment`) |

---

### FA-14 Audit Log

| ID | Requirement | Traceability |
|----|-------------|--------------|
| FA-14.1 | All relevant actions are logged immutably: order, approval, rejection (with comment), deployment start, deployment completion, deployment failure, decommissioning, configuration changes. | Partly shipped. The order, deployment and decommission events log, and the list has grown past the requirement (comment, cart, retry and version-recorded events also log) — see `docs/guides/root.md` §7. **Configuration changes do not log**: there is no `config.*` action among the 20 action literals in the code. Tracked as #137 |
| FA-14.2 | The audit log is viewable and filterable by Admins and Root users. | Shipped |
| FA-14.3 | The audit log can be exported as CSV or PDF. The format is selectable at export time. | Shipped — `GET /api/audit/export` |
| FA-14.4 | The audit log is paginated (50 entries per page) and filterable by user, action type, and date range. | Shipped — `apps/backend/src/app/api/audit/route.ts`; there is no project filter, contrary to what `docs/guides/admin.md` previously claimed (corrected in this pass) |

---

### FA-15 Branding

| ID | Requirement | Traceability |
|----|-------------|--------------|
| FA-15.1 | The Root can configure primary color, secondary/accent color, logo (PNG/SVG), shop name, subtitle/tagline, and imprint text via `/admin/branding`. | Shipped, but "logo (PNG/SVG)" undersells the actual (lack of) validation: the upload accepts any browser-declared `image/*` type with no server-side allowlist, sniffing, or size limit at all — see `apps/backend/src/app/api/admin/branding/logo/route.ts`. Default colors are `#131921`/`#febd69`, not blue — `docs/guides/root.md` §9.1 previously had the wrong defaults, corrected in this pass. |
| FA-15.2 | The logo is served at `/branding/logo`. When a logo is uploaded it replaces the shop name text in the header. | Partially shipped — the actual route is `GET /api/admin/branding/logo` (`apps/backend/src/app/api/admin/branding/logo/route.ts`), not `/branding/logo`. The header-replacement behavior is shipped. |
| FA-15.3 | The imprint text is publicly accessible at `/impressum` without requiring a login. If no imprint text is configured, the footer link is hidden. | Shipped — `apps/frontend/src/app/impressum` |
| FA-15.4 | Shop name and subtitle configured via the branding UI override the `APP_NAME` and `APP_SUBTITLE` environment variables at runtime. | **Not shipped** — there is no `APP_NAME` or `APP_SUBTITLE` environment variable anywhere in the codebase (repo-wide grep: zero matches). Shop name/subtitle exist only as database-backed settings with hardcoded defaults (`apps/backend/src/lib/db/schema.ts:306-307`: `'Open Hybrid Cloud'` / `''`) — there is nothing to "override." `docs/guides/root.md` §9.3 repeated this claim; corrected in this pass. |

---

### FA-16 Multiple Webhooks per Product-Environment

| ID | Requirement | Traceability |
|----|-------------|--------------|
| FA-16.1 | A product can have multiple webhook endpoints configured per deployment environment, stored in the `product_webhooks` table. | Shipped, and it now runs alongside a second, newer mechanism (**Pipeline Stacks**, `pipeline_stacks` table) not mentioned by this requirement — both fire in parallel on order approval/creation. See `docs/guides/root.md` §4.6. |
| FA-16.2 | Each webhook entry has: name, webhook URL, webhook token, and execution order (`exec_order`). | Shipped |
| FA-16.3 | Webhooks with the same `exec_order` value fire concurrently. Webhooks with a lower `exec_order` fire before those with a higher value. | Shipped |
| FA-16.4 | If no `product_webhooks` rows are configured for a given product-environment combination, the system falls back to the deployment environment's default webhook URL. | Shipped |
| FA-16.5 | Product webhooks are managed via the admin UI at `POST /admin/products/{id}/webhooks` and deleted via `POST /admin/products/{id}/webhooks/{wid}/delete`. | Not independently re-verified in this pass (out of the guides' scope); flagged for a future traceability pass if the product-webhooks admin UI is touched. |

---

### FA-17 Infrastructure Outputs

| ID | Requirement | Traceability |
|----|-------------|--------------|
| FA-17.1 | After a successful OpenTofu apply, the CI pipeline writes key-value outputs that the webhook handler parses and stores per infrastructure element. | Partially shipped — this only happens for a **GitLab**-backed environment. `supportsJobTrace` (`apps/backend/src/lib/ci/index.ts:82-83`) is `provider === 'gitlab'` only; on GitHub/Bitbucket, `fetchJobTraces` returns `[]` (same file, lines 106-110), so no outputs are ever parsed there. |
| FA-17.2 | Outputs are stored per infrastructure element in `infrastructure_elements.outputs` (JSONB). | Shipped |
| FA-17.3 | Outputs (e.g. IP addresses, hostnames, resource IDs) are displayed on the order detail page and the infrastructure element detail page. | Shipped, when there are any to show (see FA-17.1) |

---

## 2. Non-Functional Requirements

### NFA-01 Deployment and Operations

| ID | Requirement | Traceability |
|----|-------------|--------------|
| NFA-01.1 | The application runs as two stateless Docker containers: `frontend` (Next.js UI) and `backend` (Next.js API). | Shipped, with the caveat noted at NFA-02.1 |
| NFA-01.2 | **Docker Host:** An Nginx container (official image) handles HTTPS termination and forwards requests via reverse proxy. | Shipped only in `infra/docker-host/` (TLS via mounted certs); the *other* Docker Host path, `infra/docker-compose.yml` + `infra/nginx/default.conf`, terminates HTTP only, no TLS — see README "Docker Host" |
| NFA-01.3 | **Docker Host:** The application images (`maximilianmaag/open-hybrid-cloud-backend`, `maximilianmaag/open-hybrid-cloud-frontend`) are publicly available on Docker Hub — no registry authentication required. All other images (nginx, postgres) are official images. | Shipped |
| NFA-01.4 | **Kubernetes:** Nginx Ingress Controller + cert-manager handle TLS termination (Let's Encrypt or internal CA). No `imagePullSecret` is required; the image is public. | Shipped — `infra/helm/open-hybrid-cloud/templates/ingress.yaml`, `values.yaml` |
| NFA-01.5 | Configuration is done exclusively via environment variables (12-Factor App). No configuration files inside the container. | Shipped, with the documented exception that SMTP/AI (and, per this pass, nothing else) can also be set at runtime in the database, overriding the env var — see NFA-06 |
| NFA-01.6 | The GitLab server is reachable via a configurable URL. | Shipped, and broader than written — any of GitLab/GitHub/Bitbucket, via CI Sources (see FA-05.1) |
| NFA-01.7 | The deployment configuration for the Docker Host is located under `infra/docker-host/` and contains: `docker-compose.yml`, `nginx.conf.example`, and `setup.sh`. | Shipped, but this is only one of two Docker Host deployment paths that exist — `infra/docker-compose.yml` (build from source) is the other, and this requirement does not mention it. See README "Docker Host". |

---

### NFA-02 Scalability and Statelessness

| ID | Requirement | Traceability |
|----|-------------|--------------|
| NFA-02.1 | The application container is fully stateless. No local state between requests. | Partially contradicted — the login rate limiter keeps its attempt counters in an in-process `Map` (`apps/backend/src/app/api/auth/login/route.ts`), which is local state that does not survive a restart and is not shared across replicas; each replica enforces its own limit independently. |
| NFA-02.2 | Sessions are stored in encrypted HttpOnly cookies — no server-side session store required. | Shipped |
| NFA-02.3 | No polling service is used. CI providers push status updates via webhook callbacks — stateless and safe with multiple container replicas. | Shipped |
| NFA-02.4 | Horizontal scaling (multiple replicas) must work without any configuration changes. | Shipped in the sense the app doesn't require per-replica config, though see NFA-02.1 for the one place replica count actually changes observed behavior |

---

### NFA-03 Authentication and Security

| ID | Requirement | Traceability |
|----|-------------|--------------|
| NFA-03.1 | SSO authentication is performed via Microsoft Entra ID using the OpenID Connect Authorization Code Flow. | Shipped — `apps/backend/src/app/api/auth/callback/route.ts` |
| NFA-03.2 | Local accounts (email/password) are used by all roles. The Root creates and manages accounts via the admin UI. | Shipped |
| NFA-03.3 | All external connections (GitLab, Entra ID, SMTP, APIs) use HTTPS/TLS. | Shipped in the sense nothing forces plaintext; not independently verified for every provider in this pass |
| NFA-03.4 | API keys and secrets (GitLab tokens, SMTP credentials, session secret) are configured exclusively via environment variables. | Partially false as written — CI source access tokens and the AI provider's API key are entered through the admin UI and stored in the database (`ciSources.accessToken`, `appConfig.aiApiKey`), not exclusively via environment variables. Only the bootstrap secrets (`JWT_SECRET`, initial `ADMIN_PASSWORD`, `NEXTAUTH_SECRET`, `DECOMMISSION_SWEEP_SECRET`, SMTP env defaults) are env-var-only. |

---

### NFA-04 Data

| ID | Requirement | Traceability |
|----|-------------|--------------|
| NFA-04.1 | All webshop data is stored in PostgreSQL. No filesystem dependencies at runtime. | Shipped |
| NFA-04.2 | Product images are stored as `bytea` in PostgreSQL. | Shipped |
| NFA-04.3 | The audit log is immutable (no UPDATE/DELETE operations on audit entries). | Shipped in the sense no route updates or deletes an audit row; not independently re-verified against every service in this pass |

---

### NFA-05 Security

| ID | Requirement | Traceability |
|----|-------------|--------------|
| NFA-05.1 | Login attempts are rate-limited per IP address to prevent brute-force attacks. | Shipped, but undersells the real mechanism: the limiter (`apps/backend/src/app/api/auth/login/route.ts`) is dual-keyed — a **per-account** limit that always applies, and a **per-IP** limit that only applies when the deployment opts in via `TRUST_PROXY` (undocumented by this requirement and, until this pass, missing from the README env var table entirely). Without `TRUST_PROXY`, brute-forcing is still capped per account, just not per IP. |
| NFA-05.2 | The local Root account can be protected with a TOTP second factor (RFC 6238, SHA-1, 30 s window, 6 digits), compatible with standard authenticator apps. SSO accounts are covered by Entra ID MFA instead. | Shipped (#36) — `lib/auth/totp.ts`, verified against the RFC 4226/6238 published vectors. |
| NFA-05.3 | The TOTP shared secret is encrypted at rest (AES-256-GCM) and is never returned by the API after enrollment. | Shipped (#36) — AES-256-GCM in `lib/auth/totpSecret.ts`, with the user id as additional authenticated data. |
| NFA-05.4 | Where a second factor is enrolled, the backend issues no usable session token until a valid code is presented. The password check yields only a short-lived challenge, signed with a key distinct from the session key. | Shipped (#36) — the challenge is signed with an HMAC-derived key and carries no `user` claim, so it cannot verify as a session. |
| NFA-05.5 | An accepted code is single-use: the accepted time step is recorded and any code at or below it is refused, so a code observed inside its ±1-step window cannot be replayed. | Shipped (#36) — `last_used_step` is claimed by one conditional UPDATE, so two concurrent requests cannot both spend the same code. |
| NFA-05.6 | A set of ten one-time recovery codes is generated at enrollment, displayed exactly once, stored hashed, and each is usable once. | Shipped (#36) — ten 100-bit codes from `crypto.randomInt`, SHA-256, each spent by a conditional UPDATE. |
| NFA-05.7 | Second-factor attempts are rate-limited per account in the database: five consecutive failures lock the factor for 15 minutes. Failures, lockouts and attempts made while locked are recorded in the audit log. | Shipped (#36) — counted in the database, not in process memory, so a restart or a second replica does not reset the lockout. |
| NFA-05.8 | A confirmed second factor cannot be disabled through the API — only replaced by a new enrollment, which itself requires the password plus a current code or a recovery code. An operator with database access is the documented emergency path. | Shipped (#36) — `DELETE` answers 405 by design; the emergency path is documented in `docs/guides/root.md`. |

---

### NFA-06 Configuration Persistence

| ID | Requirement | Traceability |
|----|-------------|--------------|
| NFA-06.1 | SMTP and AI translation configuration can be updated via the Root UI and is persisted in the `app_config` database table. | Shipped |
| NFA-06.2 | Database-stored configuration overrides the corresponding environment variable defaults at runtime and persists across container restarts. | Shipped for SMTP and AI only — this override mechanism does not extend to exchange rates (see FA-11.3) or to shop name/subtitle (see FA-15.4), which have no environment variable to override in the first place. |
| NFA-06.3 | If a credential field (SMTP password, AI API key) is left blank during a UI update, the existing stored value is preserved. | Shipped |
