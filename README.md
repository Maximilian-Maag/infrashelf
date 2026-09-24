# InfraShelf

Self-service portal through which Admins and Project Managers can order, manage, and decommission IT infrastructure. The backend triggers CI/CD pipelines (GitLab, GitHub, Bitbucket) via webhook, which deploy the desired infrastructure using OpenTofu. Pipeline status is pushed back to the backend via CI provider webhooks — no polling worker required.

## Technology Stack

| Layer | Technology |
|-------|------------|
| Frontend | Next.js 15 · React 19 · Tailwind CSS v4 · NextAuth.js v5 |
| Backend | Next.js 15 · Drizzle ORM · Zod · JWT (jose) |
| Shared types | TypeScript workspace package (`packages/types`) |
| Database | PostgreSQL 16 |
| CI integration | GitLab · GitHub · Bitbucket (webhook-based, pipeline stacks) |
| Package manager | pnpm (workspaces) |
| Deployment | Two containers: `frontend` + `backend` |

## Architecture

```
Browser → Frontend (Next.js / NextAuth) → Backend REST API (Next.js)
                                               ↕
                                          PostgreSQL
                                               ↕
                              GitLab / GitHub / Bitbucket  (outbound triggers)
                              GitLab / GitHub / Bitbucket  (inbound webhooks → /api/webhooks/{provider}/pipeline)
                                          Exchange Rate API
                                          SMTP
```

Only the backend container communicates with external systems.

GitHub and Bitbucket are wired up the same way as GitLab for triggering pipelines and receiving status callbacks, but only GitLab pipeline job traces are fetched to parse OpenTofu outputs (`supportsJobTrace` in `apps/backend/src/lib/ci/index.ts`) — infrastructure provisioned through GitHub or Bitbucket gets no parsed outputs on its detail page.

## Roles

| Role | Description |
|------|-------------|
| **root** | Manages the product catalog, system configuration, and users. Local account only. |
| **admin** | Can order directly, approve/reject all orders, view all projects and infrastructure. |
| **project_manager** | Can place orders (approval by Admin required), manage own projects and infrastructure. |

The executable version of this table is `e2e/roles.spec.ts`, which asserts every
endpoint's guard and every page's reachability as each of the three roles. If you
change what a role may do, that file is where it has to be said — a rank is not
always enough to express it (root, for instance, is deliberately refused approval
delegation despite outranking admin).

## Order Process

```
project_manager:  Orders → Pending Approval → [Approved] → Provisioning → Completed
                                            ↘ [Rejected + Mandatory Comment]

admin:            Orders → Provisioning → Completed
```

On approval/creation the backend fires two sets of CI triggers in parallel:
- **Product Webhooks** (`product_webhooks` table) — ordered, multi-target webhook list per product+environment
- **Pipeline Stacks** (`pipeline_stacks` table) — step sequences sent as `PIPELINE_STACK` JSON to an orchestrator pipeline. Each step carries an `execOrder` (steps sharing a value run in parallel, higher values wait) and zero or more `upstreamRefs` mapping named CI variables to earlier steps' Terraform state — so portal-defined DAGs with cross-step data passing work without touching CI YAML

Orders can also be placed one at a time (`POST /api/orders`) or collected in a **cart** (`cart_items` table, `/cart`) and checked out together against one project (`POST /api/cart/checkout`) — checkout creates one order per cart item and reports any that failed validation without discarding the rest of the cart. Either path can be flagged as a **trial** when the chosen environment has `trialEnabled` set: the infrastructure gets an automatic `scheduledDecommissionAt` equal to the configured trial duration (see "Scheduled decommissioning" below) instead of running indefinitely. Every order has a **comment thread** (`order_comments`, `GET/POST /api/orders/{id}/comments`); admins/root can additionally mark a comment **internal**, hiding it from the project manager who placed the order.

## Environment Variables

### Backend (`apps/backend/.env`)

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `JWT_SECRET` | Yes | HS256 signing secret (min. 32 chars) |
| `ADMIN_EMAIL` | Yes | Email of the initial root account (created on first start) |
| `ADMIN_PASSWORD` | Yes | Password of the initial root account |
| `FRONTEND_URL` | No | Frontend origin (default: `http://localhost:3000`) |
| `EXCHANGE_RATE_API_URL` | No | Exchange rate API endpoint |
| `SMTP_HOST` | No | SMTP server hostname — leave blank to disable email |
| `SMTP_PORT` | No | SMTP server port (default: `587`) |
| `SMTP_FROM` | No | Sender address |
| `SMTP_USER` | No | SMTP authentication username |
| `SMTP_PASS` | No | SMTP authentication password |
| `SMTP_TLS` | No | Enable TLS (`true`/`false`, default: `true`) |
| `TOTP_ENCRYPTION_KEY` | No | Encrypts stored TOTP secrets at rest. When it is unset, the key is derived from `JWT_SECRET` — and in that case rotating `JWT_SECRET` makes every enrolled authenticator unreadable and forces re-enrolment |
| `SESSION_TTL_SECONDS` | No | How long a session lives |
| `SESSION_REMEMBER_ME_TTL_SECONDS` | No | How long a "remember me" session lives |
| `ALLOW_DEMO_SEED_IN_PRODUCTION` | No | When `NODE_ENV=production`, demo seeding is refused unless this is set to `1`. Outside production it has no effect. The demo writes a catalogue, a CI source and two environments that are not real, which is why production needs the extra word |
| `DEMO_CI_URL` | No | Points the demo catalogue at a CI that will answer, which is what makes it seed a pipeline stack. When it is blank, the demo uses `gitlab.example.invalid`, which cannot resolve, so nothing it seeds is orderable |
| `ALLOW_INSECURE_CI_TRANSPORT` | No | Set to `1` to permit plaintext http to a CI host that is not loopback. Every call to a CI source carries a credential, so this is refused by default — see [CI transport security](#ci-transport-security) |
| `DECOMMISSION_SWEEP_SECRET` | No | Shared secret for the scheduled-decommission sweep. Blank leaves `POST /api/internal/decommission-sweep` disabled (503) — see [Scheduled decommissioning](#scheduled-decommissioning) |
| `TRUST_PROXY` | No | Set to `1`/`true` when the backend sits behind a reverse proxy you trust to set `X-Forwarded-For` (nginx, an Ingress). Enables the **per-IP** half of the login rate limiter (`apps/backend/src/app/api/auth/login/route.ts`); the per-account half applies regardless. Leave unset when the backend is reachable directly, or the header becomes a spoofable bypass. |
| `WEBAUTHN_RP_ID` | In production | The **bare domain** security keys are scoped to — no scheme, no port, no path (`portal.example.com`, or `example.com` to work across subdomains). Blank falls back to `localhost`, so a fresh clone works with a key straight away; required when `NODE_ENV=production`. Changing it invalidates every registered credential |
| `WEBAUTHN_RP_ORIGIN` | In production | The full origin the browser sees, **with scheme** (`https://portal.example.com`). Comma-separate several if the portal answers on more than one hostname; `WEBAUTHN_RP_ID` must be a suffix of each. Validated at first use — getting either wrong works perfectly on localhost and breaks every key on the deployed instance |
| `SECRET_ENCRYPTION_KEY` | **Effectively yes** | 64 hex characters (`openssl rand -hex 32`) encrypting every stored credential: external-system integrations (Foreman, Ansible, Nexus, Pulp, Loki, Grafana), **CI source access tokens (#111)**, and the SMTP password and AI API key in `app_config` (#556). Blank means no new credential of either kind can be stored — those endpoints answer 503 rather than writing plain text — and CI source tokens or `app_config` secrets already in the database stay plain text until a key is set, at which point the backend encrypts them once at boot. Blank is reported at boot as a `[config]` warning and on `/api/health` (#414); the server still starts. Not rotatable in place: a new key cannot decrypt what the old one wrote |

Only `JWT_SECRET` and `DATABASE_URL` are enforced at startup (`apps/backend/src/lib/config/validate.ts`) — an invalid or missing one is reported on `GET /api/health` rather than crashing the process. `ADMIN_EMAIL`/`ADMIN_PASSWORD` are listed as required because a blank value produces a broken root account on first boot, not because anything currently refuses to start without them.

### Frontend (`apps/frontend/.env`)

| Variable | Required | Description |
|----------|----------|-------------|
| `NEXT_PUBLIC_API_URL` | Yes | Backend URL reachable from the **browser**. Only for unauthenticated assets (product images): every authenticated call from client JavaScript goes to the frontend's own `/api/proxy`, which attaches the token server-side (#146) |
| `API_URL` | Yes | Backend URL reachable from the **frontend server** (used for SSR) |
| `NEXTAUTH_URL` | Yes | Canonical frontend URL |
| `NEXTAUTH_SECRET` | Yes | NextAuth.js signing secret (min. 32 chars) |

## Project Structure

```
infrashelf/
├── apps/
│   ├── backend/                  # Next.js API-only app (port 3001)
│   │   ├── src/
│   │   │   ├── app/api/          # Thin route handlers (auth → service → toResponse)
│   │   │   └── lib/
│   │   │       ├── auth/         # JWT sign/verify, role middleware
│   │   │       ├── bootstrap/    # Root user seed on first start
│   │   │       ├── ci/           # GitLab/GitHub/Bitbucket dispatch + webhook triggering
│   │   │       ├── db/           # Drizzle client, schema, shared query helpers
│   │   │       ├── http.ts       # toResponse() — maps Result<T> to NextResponse
│   │   │       ├── notification/ # nodemailer email notifications
│   │   │       ├── services/     # Domain services: all business logic, returns Result<T>
│   │   │       │   └── admin/    # Admin-domain services (catalog, config, users, pipeline-stacks, …)
│   │   │       └── webhook/      # CI pipeline event handler
│   │   ├── Dockerfile
│   │   └── drizzle.config.ts
│   └── frontend/                 # Next.js UI app (port 3000)
│       ├── src/
│       │   ├── app/              # App Router pages
│       │   └── lib/
│       │       ├── api.ts        # Typed fetch wrappers
│       │       └── auth.ts       # NextAuth.js config
│       └── Dockerfile
├── packages/
│   └── types/                    # Shared TypeScript interfaces
├── policy/                       # Rego codebase invariants enforced by `make policy`
├── scripts/
│   ├── policy-facts.ts           # Extracts the JSON the Rego policies evaluate
│   ├── policy-check.ts           # `make policy` — opa test, then opa eval
│   └── opa.ts                    # The pinned opa binary, by version and checksum
├── infra/
│   ├── docker-compose.dev.yml    # Local dev: postgres, mailpit, wiremock, structurizr
│   ├── docker-compose.yml        # Docker host deployment
│   ├── nginx/                    # Reverse proxy config
│   ├── wiremock/                 # External API stubs for local dev
│   └── helm/                     # Kubernetes Helm chart
├── docs/
│   ├── architecture/
│   │   └── workspace.dsl         # Structurizr C4 architecture
│   ├── requirements/
│   │   └── requirements.md
│   └── guides/
│       ├── root.md
│       ├── admin.md
│       └── gitlab-opentofu-workflow.md
├── Makefile
├── package.json
└── pnpm-workspace.yaml
```

## Local Development

### Prerequisites

Install these three yourself. Everything else — Node, pnpm, and every workspace
dependency — comes from `make install`.

| Tool | Why | Install |
|------|-----|---------|
| **make** | runs everything below | `apt install build-essential` · `xcode-select --install` · preinstalled on most Linux |
| **mise** | installs and pins the toolchain | `curl https://mise.run \| sh` — see [mise.jdx.dev](https://mise.jdx.dev) |
| **Docker + Docker Compose** | Postgres, Mailpit, WireMock, Structurizr | https://docs.docker.com/get-docker/ |

That is the whole list. You do **not** need Node or pnpm on the machine first:

```bash
make install
```

reads `mise.toml`, installs the exact **Node 22.23.2** and **pnpm 11.9.0** this
repository is pinned to, and then installs the workspace. (If mise happens to be
missing it will fetch it for you, but installing it yourself is the documented
path.)

Every Make target runs its tools through `mise exec`, so the pinned versions are
what actually execute — you do not have to activate mise in your shell for the
build to be correct. If you want the same versions in your own terminal:

```bash
echo 'eval "$(mise activate bash)"' >> ~/.bashrc
```

**The pins are checked, not trusted.** `scripts/toolchain.test.ts` fails if
`mise.toml` disagrees with `packageManager` in `package.json`, if its Node major
disagrees with the one `.github/actions/setup/action.yml` installs, or if either
pin is a range instead of an exact version. CI pins the Node **major** and takes
the latest patch; `mise.toml` pins the patch, so local builds are reproducible.

### Make Targets

Run `make help` to see all available commands.

| Target | Description |
|--------|-------------|
| `make install` | Install the toolchain (mise → Node, pnpm) **and** all workspace dependencies |
| `make tools` | Install just the pinned Node and pnpm from `mise.toml` |
| `make dev` | Start infra containers (postgres, mailpit, wiremock, structurizr) |
| `make dev-down` | Stop infra containers |
| `make run` | Start backend **and** frontend dev servers together |
| `make run-backend` | Start only the backend dev server (`:3001`) |
| `make run-frontend` | Start only the frontend dev server (`:3000`) |
| `make build` | Build all apps |
| `make lint` | Lint all apps |
| `make type-check` | TypeScript type-check all apps |
| `make policy` | Run the OPA codebase-invariant gate — the same check CI runs (see [Policy gate](#policy-gate)) |
| `make test` | Run unit and integration tests |
| `make docker-build` | Build both Docker images locally |
| `make db-push` | Push Drizzle schema to the database |
| `make db-studio` | Open Drizzle Studio (visual DB browser) |
| `make handbook` | Compile the technical handbook to `docs/handbook.pdf` (not committed — see [Technical Handbook](#technical-handbook)) |
| `make diagrams` | Render the C4 views from `docs/architecture/workspace.dsl` — PNGs and one combined PDF (`make diagrams-png` / `make diagrams-pdf` for one of them) |
| `make diagrams-install` | Fetch the two checksum-pinned jars the renderer needs into `.diagrams/` (gitignored) |
| `make clean` | Remove build artifacts |

---

### Step-by-step Setup

#### 1. Clone and install dependencies

With **make**, **mise** and **Docker** present (see
[Prerequisites](#prerequisites)), this is the entire setup:

```bash
git clone <repo-url>
cd infrashelf
make install
```

That installs the pinned Node and pnpm from `mise.toml` and then every workspace
dependency. It prints the versions it settled on, so the first line of a bug
report can say which toolchain produced it.

#### 2. Start the local infrastructure

```bash
make dev
```

This starts four containers defined in `infra/docker-compose.dev.yml`:

| Service | URL | Purpose |
|---------|-----|---------|
| PostgreSQL | `localhost:5432` | Application database |
| Mailpit | http://localhost:8025 | Catch-all SMTP inbox — view all outgoing emails |
| WireMock | http://localhost:8080 | Stubs for GitLab API and Exchange Rate API |
| Structurizr Lite | http://localhost:8088 | Live C4 architecture diagram viewer |

Wait for the containers to be healthy before continuing (the `--wait` flag handles this automatically).

#### 3. Configure environment variables

Copy the example files:

```bash
cp apps/backend/.env.example  apps/backend/.env
cp apps/frontend/.env.example apps/frontend/.env
```

**`apps/backend/.env` — changes required for local dev:**

```dotenv
# The example points at the Docker service name; change to localhost for running outside Docker
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/infrashelf

# Any random string — used to sign JWTs
JWT_SECRET=my-local-dev-secret

# Credentials for the root account created on first startup
ADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD=changeme

# Keep the rest at their defaults; SMTP/SSO can stay blank to be disabled
FRONTEND_URL=http://localhost:3000
EXCHANGE_RATE_API_URL=http://localhost:8080/exchange-rates  # WireMock stub
```

**`apps/frontend/.env` — changes required for local dev:**

```dotenv
# Browser-side asset URLs, e.g. product images (must be reachable from your machine)
NEXT_PUBLIC_API_URL=http://localhost:3001

# Server-side (SSR) API calls — same target when running outside Docker
API_URL=http://localhost:3001

NEXTAUTH_URL=http://localhost:3000

# Any random string — used to sign NextAuth sessions
NEXTAUTH_SECRET=my-local-nextauth-secret
```

> **Note:** `SMTP_*` variables can be left blank. Leaving SMTP blank disables email notifications. Mailpit is available as a dev SMTP server if you want to test emails — set `SMTP_HOST=localhost` and `SMTP_PORT=1025`.

#### 4. Initialise the database

The first time (and any time you add a new migration):

```bash
make db-push
```

This pushes the Drizzle schema directly to the local database. Alternatively, `make db-studio` opens a visual browser at http://localhost:4983.

> **Note:** In production/staging, migrations run automatically when the backend starts (via `GET /api/health`). For local dev, `db-push` is the quickest way to sync the schema.

#### 5. Start the dev servers

```bash
make run          # backend (:3001) + frontend (:3000) in parallel
```

Or start them individually in separate terminals:

```bash
make run-backend  # terminal 1
make run-frontend # terminal 2
```

| App | URL | Notes |
|-----|-----|-------|
| Frontend | http://localhost:3000 | Next.js with hot reload |
| Backend | http://localhost:3001 | Next.js API with hot reload |
| API docs | http://localhost:3001/api/docs | OpenAPI (Swagger UI) — requires a signed-in session; log in via the frontend first |

#### 6. Log in

Open http://localhost:3000 and sign in with the `ADMIN_EMAIL` / `ADMIN_PASSWORD` from your `apps/backend/.env`. The root user is created automatically the first time the backend starts (triggered by the first request to `/api/health`).

---

### Development Workflow

#### Database changes

1. Edit `apps/backend/src/lib/db/schema.ts`
2. Run `make db-push` to apply changes to your local database
3. When ready for a production migration, generate a SQL migration file:
   ```bash
   pnpm --filter backend db:generate
   ```
   Commit the generated file under `apps/backend/drizzle/`, **including the
   `drizzle/meta/` snapshot it writes alongside it**.

`schema.ts` and the migrations have to stay in step, and two footguns make that
easy to get wrong (issue #141):

- `db:generate` never reads the `.sql` files. It diffs `schema.ts` against the
  lexicographically last `drizzle/meta/*.json` and emits whatever turns one into
  the other. A missing snapshot means it regenerates migrations that have already
  run — and re-dropping an already-dropped column raises `42703`, which
  `runBootstrap` does not treat as idempotent, so the server stops booting.
- `db:push` drops whatever `schema.ts` does not declare. An index or CHECK that
  lives only in a migration is silently removed the next time somebody runs
  `make db-push` against a migration-built database.

So: if you hand-write a migration rather than generating one, declare the same
objects in `schema.ts` and then refresh the snapshot:

```bash
pnpm --filter backend db:snapshot
```

`apps/backend/src/lib/db/journal.test.ts` fails if the snapshot and `schema.ts`
disagree, so CI catches a forgotten refresh.

#### Running tests

```bash
make test                         # all unit + integration tests
pnpm --filter backend test:watch  # backend tests in watch mode
pnpm --filter frontend test       # frontend tests only
pnpm test:coverage                # both apps, with coverage
pnpm test:mutation                # Stryker — hours, see the guide below
```

Integration tests require the postgres container to be running (`make dev`).
A single file is `cd apps/backend && TEST_DB_SUFFIX=thing pnpm exec vitest run <path>`;
the suffix names the databases that run creates, and each test file gets its own.

How the suite is put together, what the gates enforce and the traps worth knowing
are in **[docs/guides/testing.md](docs/guides/testing.md)**; the mutation half has
its own guide, [docs/guides/mutation-testing.md](docs/guides/mutation-testing.md).

#### Simulating a CI/CD pipeline webhook

WireMock stubs the CI provider APIs. To simulate a pipeline event reaching the backend, POST directly to the webhook endpoint:

```bash
# GitLab — pipeline succeeded
curl -X POST http://localhost:3001/api/webhooks/gitlab/pipeline \
  -H "Content-Type: application/json" \
  -H "X-Gitlab-Token: dev-webhook-token" \
  -d '{"object_kind":"pipeline","object_attributes":{"id":"42","status":"success"}}'

# GitHub — workflow completed
curl -X POST http://localhost:3001/api/webhooks/github/workflow \
  -H "Content-Type: application/json" \
  -H "X-Hub-Signature-256: sha256=<hmac>" \
  -d '{"action":"completed","workflow_run":{"id":42,"conclusion":"success"}}'
```

Replace `"success"` with `"failed"` or `"canceled"` to test failure paths.

#### Viewing sent emails

All emails sent by the backend during local dev are captured by Mailpit. Open http://localhost:8025 to browse the inbox — no real emails are sent.

#### Viewing the architecture diagram

Open http://localhost:8088 while `make dev` is running. Structurizr Lite reads `docs/architecture/workspace.dsl` and renders the C4 diagrams live.

---

### Stopping everything

```bash
# Stop the dev servers: Ctrl+C in the terminal running make run

# Stop the infrastructure containers:
make dev-down
```

## Deployment

### Docker Host

Two different single-host setups exist under `infra/`, and they are not interchangeable:

**A. Build from source** (`infra/docker-compose.yml`) — builds the frontend/backend images locally instead of pulling them:

```bash
cd infra
docker compose up -d
```

Configuration comes from `infra/docker-host/.env` (`env_file:` on every service, not `apps/*/env`) — copy `infra/docker-host/.env.example` and fill it in before starting. Nginx (`infra/nginx/default.conf`) terminates plain HTTP only; there is no TLS setup in this path.

**B. Pull published images, with auto-update** (`infra/docker-host/`) — the path the release images (below) are meant for: pulls from Docker Hub, adds a `watchtower` container that polls for and applies new image tags, and expects TLS certificates:

```bash
cd infra/docker-host
cp .env.example .env            # fill in DOCKERHUB_USERNAME, SERVER_NAME, secrets
mkdir -p certs                  # place fullchain.pem + privkey.pem here
sudo ./setup.sh --install        # Debian only; also installs Docker itself
```

There is deliberately no `nginx.conf` to copy: `nginx.conf.template` is mounted straight into the container and rendered with `SERVER_NAME` at start-up. A copied config drifts from the repository and nothing notices — on 2026-08-27 one had fallen behind the `/api/proxy/` block, which since #146 is the only route by which the browser reaches the backend, and every dashboard action on that host answered 404 while CI stayed green.

`setup.sh` also supports `--upgrade` (pull the newer images), `--logs [service]` and `--status` — see the script for what each does. Path A passes the backend container everything in `docker-host/.env` via `env_file:`, so adding `TRUST_PROXY` or `DECOMMISSION_SWEEP_SECRET` there is enough. Path B's `docker-compose.yml` instead lists each backend variable individually under `environment:`, and does **not** list `TRUST_PROXY` or `DECOMMISSION_SWEEP_SECRET` — setting them in that directory's `.env` has no effect until the compose file's backend `environment:` block also names them.

### Kubernetes

See `infra/helm/` for the Helm chart. The images are published to Docker Hub:

- `maximilianmaag/infrashelf-backend`
- `maximilianmaag/infrashelf-frontend`

### Scheduled decommissioning

Users can set a future time at which an infrastructure element is torn down
automatically, so temporary environments (test, demo, PoC) stop accruing cost when
they are forgotten. Setting the time works out of the box; **acting on it needs a
scheduler**, because the backend has no worker process and is horizontally scaled
— an in-process timer would run once per replica.

Point any scheduler at `POST /api/internal/decommission-sweep`, authenticated with
`DECOMMISSION_SWEEP_SECRET` in an `X-Sweep-Secret` header. While that variable is
unset the endpoint returns 503, so it can never be called anonymously.

The sweep is idempotent — its `active → decommissioning` claim is atomic, so
overlapping or replayed runs cannot tear anything down twice — and the schedule
interval is the granularity of the feature: an element is torn down at the first
sweep at or after its time, not to the second.

| Deployment | How |
|------------|-----|
| Kubernetes | Set `decommissionSweep.enabled=true` and `decommissionSweep.secret` (Helm renders a `CronJob`; `decommissionSweep.schedule` defaults to every 15 minutes) |
| Docker host / bare metal | A cron entry — see the `DECOMMISSION_SWEEP_SECRET` block in `.env.example` for a ready-made line |

Response codes: `200` all due elements torn down, `207` some could not be started
(the body's `failed[]` says which — a product whose destroy triggers are broken),
`401` bad secret, `503` feature not configured.

## CI/CD

| Trigger | Pipeline |
|---------|----------|
| Pull request | Type-check + lint + build + E2E + a11y gate + policy gate, and (only if the PR touches `docs/handbook.tex`) a handbook compile check (`.github/workflows/ci.yml`) |
| Pull request into `main` | Additionally a full Stryker run per app against the 90% release threshold (`.github/workflows/mutation-release-gate.yml`) — unless the promotion touches only `docs/`, `infra/` or Markdown, in which case the matrix is skipped and `Mutation gate` passes with the reason. Hours rather than minutes, which is affordable only because it asks this of the last hop to production and of nothing else — see [the mutation testing guide](docs/guides/mutation-testing.md) for why it reports rather than blocks until a dated switch |
| Nightly on `dev` | A full mutation run as a trend line, blocking nothing (`.github/workflows/mutation.yml`) |
| Push to `dev`/`staging`/`main` | Build & push Docker images (`.github/workflows/cd-release.yml`) |
| Push to `main` | Additionally compiles the handbook fresh from `docs/handbook.tex` and publishes a GitHub Release with the resulting PDF attached |

Required GitHub secrets: `DOCKERHUB_USERNAME`, `DOCKERHUB_TOKEN`.

## CI transport security

Every outbound call to a CI source carries a credential: the trigger token on a
pipeline trigger, `PRIVATE-TOKEN` on every project, branch, tree and file read.
An `http://` CI source therefore puts all of it on the wire in clear.

The portal refuses that. A GitLab URL must be `https://`, unless the host is
loopback — `127.0.0.0/8`, `localhost`, `*.localhost`, `[::1]` — which is how the
e2e suite points `DEMO_CI_URL` at a WireMock on `:8080` that never leaves the
machine.

```
Refusing to send CI credentials over plaintext http to gitlab.internal.example.com.
Use https, or set ALLOW_INSECURE_CI_TRANSPORT=1 if this host is genuinely
reachable only over http and the network between is trusted.
```

`ALLOW_INSECURE_CI_TRANSPORT=1` is the opt-out, and it is deployment-wide rather
than per source: it is a statement about the network the portal sits on, which
is not a property of one row in `ci_sources`.

**Upgrading with an http CI source.** The change refuses at the point of the
call, so an existing source keeps looking fine in the admin UI and fails when
somebody places an order. To make that visible, the bootstrap names every
affected source on stderr at boot:

```
[bootstrap] 1 CI source(s) cannot be used: On-Prem GitLab (http://gitlab.internal.example.com).
Every call to them carries a credential, so plaintext http off loopback is refused (#329).
Move them to https, or set ALLOW_INSECURE_CI_TRANSPORT=1 to accept the risk.
```

GitHub and Bitbucket are unaffected: those clients always talk to
`api.github.com` and `api.bitbucket.org` over https and ignore the configured
URL entirely.

## Policy Gate

`make policy` evaluates the Rego policies in `policy/` against the source tree
and fails on a `deny`. It is the same command the "Policy (OPA)" job in
`.github/workflows/ci.yml` runs, so a green run locally is the answer CI will
give.

It exists because ESLint enforces rules about *a file*, and every recurring
defect in this repository has been a rule that spans files — a route whose auth
helper is missing, a table added to `schema.ts` and to a migration but not to
both places in `src/test/setup.ts`, an i18n key present in 2 of 25 languages, a
`select()` that reached one column too far, a language code added to the picker
but not to the AI prompt that translates for it, a variable the code reads that
no `.env.example` tells an operator to set. Those are sentences you can write
down, which makes them policy rather than lint.

```bash
make policy-install-opa   # once: fetches the pinned opa into .opa/ (gitignored, checksum-verified)
make policy               # opa test on the policies, then opa eval on the tree
make policy-facts         # the JSON the policies see, if a rule is not firing as expected
```

Each violation prints the rule, the file and *why the rule exists*, because a
policy failure that does not explain itself gets suppressed rather than fixed:

```
DENY  route_requires_auth  apps/backend/src/app/api/reports/route.ts
      exports GET but never calls requireAuth or requireRole, and "reports" is not on
      the public allowlist
      why: Whether a route authenticates is not visible in the file a reviewer is reading
           — it is the absence of a call. ...
```

`deny` fails the build; `warn` reports and does not. A rule that cannot pass on
`dev` yet ships as `warn` naming the issue that will promote it — a gate that
starts red teaches people to ignore it. Adding a rule is one block in
`policy/*.rego` and one test in the matching `*_test.rego`; the facts it reasons
about come from `scripts/policy-facts.ts`.

This bundle is **not** the runtime policy engine of issue #110. It never runs in
production: its input is the source tree and its only output is a CI verdict.

## Technical Handbook

`docs/handbook.tex` compiles to a PDF, but the PDF itself is **not committed** — a
generated artefact next to its source drifts the moment someone edits the source
and forgets to recompile, and nothing enforced regenerating it. Instead:

- `make handbook` compiles it locally to `docs/handbook.pdf` (gitignored). It depends on `make diagrams-png`, because four of its figures are rendered from the C4 model rather than drawn in the document — see [Architecture Diagrams](#architecture-diagrams).
- Any pull request that touches `docs/handbook.tex` gets a CI job (`.github/workflows/ci.yml`) that compiles it and uploads the result as a build artifact ("handbook-pdf") — so a LaTeX error is caught in review, not discovered when someone tries to build a release.
- Every push to `main` compiles it fresh and attaches it to that push's GitHub Release (`.github/workflows/cd-release.yml`) — the canonical place to download the current handbook.

Both CI jobs use the same pinned LaTeX action (`xu-cheng/latex-action`, pinned by commit SHA like every other third-party action in this repo), so the PR check and the release build agree with each other. `make handbook` is *not* that toolchain — it shells out to your local `pdflatex` — so a green local build is evidence the source compiles, not proof CI will produce the same PDF.

## Architecture Diagrams

`docs/architecture/workspace.dsl` is the C4 model and it is the **only** place
the architecture is drawn. The handbook used to redraw its first three levels by
hand in TikZ, so the same diagrams existed twice — once as the model and once as
a picture of it — and only one of them ever got updated.

```bash
make diagrams            # PNGs and the combined PDF
make diagrams-png        # --jpeg: one PNG per view
make diagrams-pdf        # --pdf:  one vector PDF, C4 levels then deployment
make diagrams-clean      # drop the output, keep the pinned jars
```

Output lands in `docs/architecture/diagrams/` and is **gitignored**, for the same
reason `handbook.pdf` is: a checked-in rendering drifts from the model the moment
nobody regenerates it. `make handbook` renders them first, and both the PR check
and the release build call the same target.

**`--jpeg` writes PNG.** These are line drawings — flat fills, thin rules and
small type — and JPEG's block artefacts land exactly on the glyph edges that have
to stay legible.

Two jars do the work, both pinned by SHA-256 in `scripts/diagramTools.ts` the way
`scripts/opa.ts` pins opa: **structurizr-cli** exports each view to C4-PlantUML,
and **PlantUML** lays it out with Graphviz. They need a JRE and `dot` on PATH;
`make diagrams-install` fetches them and verifies the bytes before writing.

Two things worth knowing before editing the DSL:

- **Structurizr's `autoLayout` does nothing here.** Layout happens in Graphviz at
  render time, so the direction and separation hints in the DSL are not what
  positions anything — `scripts/diagrams.ts` sets spacing as PlantUML directives
  instead.
- **PlantUML's default 4096px ceiling silently clips.** The backend component view
  is 4899px wide; the first render of it lost Microsoft Entra ID, Bitbucket and
  the Mail Server off the right edge with no warning. The renderer raises the
  limit; do not lower it.

## Documentation

| Document | Path |
|----------|------|
| Architecture (C4) | `docs/architecture/workspace.dsl` — the only place the architecture is drawn; `make diagrams` renders it |
| Requirements | `docs/requirements/requirements.md` |
| Root Manual | `docs/guides/root.md` |
| Admin Manual | `docs/guides/admin.md` |
| GitLab & OpenTofu Integration | `docs/guides/gitlab-opentofu-workflow.md` |
| Technical Handbook (source) | `docs/handbook.tex` — see [Technical Handbook](#technical-handbook) for how to get the PDF |
