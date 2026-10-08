# InfraShelf Helm chart

Deploys the portal: the backend (API + migrations), the frontend, and the
scheduled sweep CronJobs that release approved orders and decommission
infrastructure.

## One release per environment

The chart is environment-agnostic. Environments differ only in the **overlay
values file** and, crucially, in **which Secret holds the database URL and the
other credentials**. That Secret is never committed here — it is created out of
band (kubectl, External Secrets, Sealed Secrets, SOPS) and the chart is told its
name.

| Environment | Overlay | Backend Secret | Database |
|---|---|---|---|
| dev | `values-dev.yaml` | `infrashelf-dev-backend` | the compose dev Postgres (`infrashelf`) |
| staging | `values-staging.yaml` | `infrashelf-staging-backend` | the staging Postgres |
| prod | `values-prod.yaml` | `infrashelf-prod-backend` | the production Postgres |

Install:

```sh
helm install infrashelf ./infrashelf \
  -f ./infrashelf/values.yaml \
  -f ./infrashelf/values-prod.yaml
```

### Bringing your own Secret (`*.existingSecret`)

Set `backend.existingSecret` / `frontend.existingSecret` to a Secret that already
exists in the namespace and the chart stops creating one of its own — every
reference (the Deployment, the pre-upgrade migrate hook, and the three sweep
CronJobs) points at yours instead. The Secret must carry the same keys the chart
would have written:

- `DATABASE_URL`, `JWT_SECRET`, `ADMIN_PASSWORD` (required)
- `SECRET_ENCRYPTION_KEY`, `TOTP_ENCRYPTION_KEY`, `SMTP_PASS` (when the matching
  feature is on)
- `DECOMMISSION_SWEEP_SECRET`, `DEPLOYMENT_WINDOW_SWEEP_SECRET`,
  `DRIFT_REPORT_SECRET`, `METRICS_SECRET` (when the matching feature is on)

```sh
kubectl -n infrashelf-prod create secret generic infrashelf-prod-backend \
  --from-literal=DATABASE_URL="postgresql://user:pw@prod-postgres:5432/infrashelf" \
  --from-literal=JWT_SECRET="$(openssl rand -base64 48)" \
  --from-literal=ADMIN_PASSWORD="..."
```

Leave `existingSecret` empty and the chart creates and owns the Secret from the
`backend.secrets` / `frontend.secrets` values — convenient for a throwaway
install, but the URL then lives in a values file, which is why the overlays here
all set it.

### Frontend ↔ backend per environment

The frontend reaches the backend over the cluster network and the browser
reaches both through the ingress. Both are set per overlay:

- `frontend.env.apiUrl` — the in-cluster backend service (`http://<release>-backend:3001`)
- `frontend.env.nextauthUrl` / `backend.env.frontendUrl` — the public origin
- `ingress.hosts[0].host` — the hostname the browser uses

`NEXT_PUBLIC_API_URL` is baked into the frontend bundle at **build** time, so it
is a CI build arg, not a runtime value here.

### Passkeys

`backend.webauthn.rpId` (bare domain) and `backend.webauthn.rpOrigin` (full
origin) are **required in production** — the backend refuses a WebAuthn ceremony
without them (#197) — and must match `ingress.hosts[0].host`. Changing `rpId`
later invalidates every registered passkey.

## The scheduled jobs

Three CronJobs call backend endpoints; they need no database of their own,
because each endpoint does the work server-side:

| CronJob | Calls | Values |
|---|---|---|
| decommission-sweep | `POST /api/internal/decommission-sweep` | `decommissionSweep` |
| deployment-window-sweep | `POST /api/internal/deployment-window-sweep` | `deploymentWindowSweep` |
| holiday-refresh | `POST /api/internal/holiday-refresh` | `deploymentWindowSweep` (same secret) |

Enable them in every environment that has real orders: with the sweep off, a
scheduled order waits for ever and a scheduled decommission never runs. Each one
authenticates with its secret from the backend Secret, so it follows
`backend.existingSecret` automatically.

## Validating the chart

```sh
helm lint ./infrashelf
helm template infrashelf ./infrashelf \
  -f ./infrashelf/values.yaml -f ./infrashelf/values-prod.yaml
```
