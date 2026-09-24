# The InfraShelf dashboards, as code (#548)

Two Grafana dashboards that the portal links into, and the Prometheus they read,
both provisioned from this repository. `#546` gives an element and a project a
deep link; this directory is what stops that link answering 404.

    infra/grafana/dashboards/infrashelf-element.json   uid: infrashelf-element
    infra/grafana/dashboards/infrashelf-project.json   uid: infrashelf-project
    infra/grafana/provisioning/dashboards/…            mounts the two JSON files
    infra/grafana/provisioning/datasources/…           the Prometheus they query

## The metric source

The backend serves its own metrics in the Prometheus exposition format:

    GET /api/internal/metrics
    Authorization: Bearer $METRICS_SECRET

Unconfigured means **503**: a deployment that never set `METRICS_SECRET` serves
no metrics rather than free ones, because the response describes how many
elements the installation runs, which projects have drifted and which
integrations are failing — operational information about customers. The endpoint
is under `/api/internal` because a scraper has no session, and it is therefore
deliberately absent from the client contract at `/api/docs` (the exclusion is
named in `apps/backend/src/lib/openapi/contract.test.ts`).

What it exposes is the portal's own view — element status, drift, policy
verdicts, order queue depth, integration health — read out of Postgres per
scrape. It does **not** expose machine metrics (CPU, memory, disk): those belong
to whatever exporters the deployment runs, and a Prometheus holding both can put
them on the same panel. Request rate, error rate and latency are also not here:
those need instrumentation in the request path, and in-process counters are per
replica, so a two-pod deployment would double every rate. That decision is the
deployment's, and #548 leaves it as the follow-on rather than guessing at it.

## Wiring it up

Scrape config, where `infrashelf.example.com` is the backend's ingress or
service address:

```yaml
scrape_configs:
  - job_name: infrashelf
    metrics_path: /api/internal/metrics
    scheme: https
    authorization:
      credentials_file: /etc/prometheus/infrashelf-metrics-secret
    static_configs:
      - targets: ['infrashelf.example.com']
```

`credentials_file` rather than an inline `credentials:`, because a scrape config
is usually in version control and the token is not something to commit. The same
value goes to the backend as `METRICS_SECRET` (Helm: `metrics.secret`) and to
Grafana as `$METRICS_SECRET` for the datasource above.

Then mount both provisioning directories into Grafana:

```yaml
volumes:
  - ./infra/grafana/provisioning:/etc/grafana/provisioning:ro
  - ./infra/grafana/dashboards:/var/lib/grafana/dashboards:ro
environment:
  PROMETHEUS_URL: http://prometheus:9090
  METRICS_SECRET: <the same value the backend was given>
```

The dashboards are then in the **InfraShelf** folder, and `allowUiUpdates: false`
means an edit made in the Grafana UI is replaced on the next provision — the file
here is the source of truth, for the same reason policies belong in a repository
(#110) and infrastructure does (#108).

## The contract with the portal

`apps/backend/src/lib/integrations/grafana.ts` builds the links, and what it
sends is what these dashboards must understand:

| what the portal sends | where it lands |
|---|---|
| `/d/infrashelf-element/element` | uid and slug of the element dashboard |
| `var-element_id`, `var-project_id`, `var-environment_id`, `var-order_id` | template variables, chained off the element |
| `var-project_id` | the project dashboard's only variable |
| `from=now-6h&to=now` | the dashboards' `time` block |

A variable renamed here still loads and simply filters nothing, which is why
`apps/backend/src/lib/metrics/dashboards.test.ts` reads these JSON files and fails
on a mismatch — in both directions: a panel naming a metric the backend does not
emit, and a metric the backend emits that no panel reads. Both are silent in
Grafana (one renders "No data" for ever, the other is a series nobody looks at)
and neither is caught by anything that runs in a browser.

## Changing one

Add a metric to `apps/backend/src/lib/metrics/catalog.ts` first: the names and
their HELP text live in one place, the renderer refuses a sample that has no
declaration, and the parity test will tell you which dashboard has to read it.
Physical units belong on the panel (`unit` in the panel's `fieldConfig`), not in
the metric name, and every timestamp metric is emitted in seconds because that is
what Prometheus stores.
