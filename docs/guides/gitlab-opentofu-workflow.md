# GitLab & OpenTofu Integration Guide

This guide explains how to set up the GitLab CI/CD side of the infrastructure workflow. The portal triggers GitLab pipelines via the GitLab Pipeline Trigger API; pipelines run OpenTofu to provision or decommission infrastructure; GitLab pushes pipeline status events back to the portal via a webhook so orders update in real time.

---

## Architecture Overview

```
Portal                          GitLab CI                         Cloud Provider
──────                          ─────────                         ──────────────
Order approved          ──►     POST /infra-templates/trigger/pipeline
                                  TEMPLATE=linode/virtual-machine
                                  TF_STATE_NAME=web-01  TF_ACTION=apply
                        ◄──     {"id": 5678, "status": "pending"}
                                  │  entry pipeline dispatches to template
                                  ├─ validate
                                  ├─ plan  (tofu plan -out=tfplan)
                                  └─ apply (tofu apply tfplan)   ──►  VM created
                                  │
                        ◄──     POST /api/webhooks/gitlab/pipeline
                                  {"status": "success", "pipeline_id": 5678}
Order → completed
OpenTofu outputs stored
E-mail sent to user

Decommission request    ──►     POST /infra-templates/trigger/pipeline
                                  TEMPLATE=linode/virtual-machine
                                  TF_STATE_NAME=web-01  TF_ACTION=destroy
                        ◄──     {"id": 5699}
                                  └─ apply (tofu plan -destroy → tofu apply) ──►  VM deleted
                        ◄──     POST /api/webhooks/gitlab/pipeline
                                  {"status": "success", "pipeline_id": 5699}
Order → decommissioned
E-mail sent to user
```

---

## Repository Structure

All IaC code lives in a single repository, `infra-templates`. It contains reusable OpenTofu modules and deployable product templates. The portal triggers the entry pipeline with a `TEMPLATE` variable; the entry pipeline dispatches to the child pipeline for the named template inside the same repo.

```
infra-templates/
├── .gitlab-ci.yml                        # entry pipeline (dispatch on TEMPLATE)
├── .ci/
│   ├── base.gitlab-ci.yml               # shared validate → plan → apply
│   └── generate_stack.py                # pipeline stack orchestrator
├── modules/                             # reusable OpenTofu building blocks
│   ├── linode-instance/
│   ├── linode-firewall/
│   ├── linode-dns-record/
│   ├── linode-volume/
│   ├── linode-lke/
│   ├── linode-nodebalancer/
│   ├── linode-object-storage/
│   ├── aws-vpc/
│   ├── aws-security-group/
│   ├── aws-ec2-instance/
│   ├── aws-s3-bucket/
│   ├── aws-rds-postgres/
│   └── vsphere-vm/
└── templates/                           # deployable products
    ├── linode/
    │   ├── virtual-machine/             # instance + per-VM firewall
    │   ├── firewall/
    │   ├── dns-record/
    │   ├── block-storage/
    │   ├── kubernetes-cluster/
    │   ├── load-balancer/
    │   └── object-storage/
    ├── aws/
    │   ├── network/                     # order first — its outputs feed the rest
    │   ├── virtual-machine/
    │   ├── object-storage/
    │   └── database-postgres/
    ├── vsphere/
    │   └── virtual-machine/
    └── orchestrator/                    # pipeline stack entry point
```

**Principle:** one trigger → `TEMPLATE` variable → one child pipeline → one OpenTofu state per resource instance. Cross-resource ordering (VM then DNS) is handled by pipeline stacks (Pattern 3) via the orchestrator template.

---

## Template Catalogue

What `TEMPLATE` can be set to, and what each one needs. Full parameter tables with
defaults live in the `infra-templates` README; this is the portal-side view.

### Linode

| `TEMPLATE` | Provisions | Key parameters | Outputs |
|---|---|---|---|
| `linode/virtual-machine` | Instance + its own firewall | `hostname`, `region`, `instance_type`, `image`, `inbound_ports_csv` | `hostname`, `ip_address`, `firewall_id` |
| `linode/firewall` | Standalone firewall | `label`, `linode_id`, `inbound_ports_csv` | `firewall_id` |
| `linode/dns-record` | DNS record | `domain`, `record_name`, `target` | `record_id`, `fqdn` |
| `linode/block-storage` | Block storage volume, optionally attached | `volume_label`, `size_gb`, `linode_id` | `volume_id`, `device_path`, `size_gb` |
| `linode/kubernetes-cluster` | LKE cluster with one node pool | `cluster_label`, `k8s_version`, `node_type`, `node_count`, `autoscale` | `cluster_id`, `api_endpoint`, `node_count` |
| `linode/load-balancer` | NodeBalancer in front of given backends | `balancer_label`, `port`, `protocol`, `backends_csv` | `ip_address`, `hostname`, `backend_count` |
| `linode/object-storage` | S3-compatible bucket | `bucket_label`, `region`, `acl`, `versioning` | `bucket_label`, `endpoint`, `region` |

### AWS

**Order `aws/network` first.** Its outputs are the inputs of the other AWS
products, and RDS needs subnets in two availability zones even for a single-AZ
instance — which is why the network template creates one subnet per AZ.

| `TEMPLATE` | Provisions | Key parameters | Outputs |
|---|---|---|---|
| `aws/network` | VPC, internet gateway, one public subnet per AZ | `network_name`, `region`, `cidr_block`, `subnet_count` | `vpc_id`, `subnet_ids`, `first_subnet_id`, `cidr_block` |
| `aws/virtual-machine` | EC2 instance + its own security group | `hostname`, `instance_type`, `vpc_id`, `subnet_id`, `inbound_ports_csv` | `instance_id`, `private_ip`, `public_ip`, `security_group_id` |
| `aws/object-storage` | S3 bucket, private, encrypted, versioned | `bucket_name`, `region`, `versioning` | `bucket`, `arn`, `endpoint` |
| `aws/database-postgres` | RDS Postgres + subnet group + security group | `database_identifier`, `vpc_id`, `subnet_ids_csv`, `instance_class`, `storage_gb` | `host`, `port`, `database_name` |

Chaining them as a **pipeline stack** (Pattern 3) is the tidier route: the network
step's state can be referenced by later steps through `Upstream State Refs`, so the
orderer does not have to copy a VPC id from one order into the next.

### vSphere

| `TEMPLATE` | Provisions | Key parameters | Outputs |
|---|---|---|---|
| `vsphere/virtual-machine` | VM cloned from a template, Linux or Windows | `hostname`, `datacenter`, `cluster`, `datastore`, `template_name`, `guest_os_family` | `hostname`, `ip_address` |

`guest_os_family` decides which guest customization runs. It matters: a Windows
template cloned with the Linux customization comes up **unconfigured** — no
hostname, no address, no domain membership — because the provider silently ignores
`linux_options` on a Windows guest. Set it to `windows` and provide
`windows_domain` (plus a domain-join account) or leave it empty for a workgroup.

### Provider credentials

Set as GitLab CI/CD variables on the `infra-templates` project, not as product
parameters. Linode and vSphere pass through `TF_VAR_*`; **AWS deliberately does
not** — the AWS provider reads its own standard environment variables, which also
keeps the keys out of the Terraform state. The Linode provider cannot do this: it
only accepts a `token` argument, so that token is in the state.

| Provider | Variables |
|---|---|
| Linode | `TF_VAR_linode_token`, `TF_VAR_root_pass`, `TF_VAR_authorized_key` |
| AWS | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN` (temporary creds), `TF_VAR_db_password` |
| vSphere | `TF_VAR_vsphere_server`, `TF_VAR_vsphere_user`, `TF_VAR_vsphere_password`, `TF_VAR_windows_admin_password`, `TF_VAR_windows_domain_admin_password` |

---

## Step 1: Create a Pipeline Trigger Token

In the `infra-templates` GitLab project:

```
Settings → CI/CD → Pipeline triggers → "Add trigger"
Description: "Infra Webshop"
```

Copy the generated token. You will need it when creating a Deployment Environment in the webshop. One trigger token is sufficient — the `TEMPLATE` variable selects which product template runs.

---

## Triggering Patterns

A single webshop order can require multiple infrastructure resources (e.g. VM + DNS + firewall). There are three patterns:

### Pattern 1 — Single Template Trigger (simplest)

The webshop sends one trigger to `infra-templates` with `TEMPLATE=<name>`. The entry pipeline dispatches to the named template, which provisions a single resource.

```
Webshop
  └── POST /infra-templates/trigger/pipeline
        TEMPLATE=linode/virtual-machine
        TF_STATE_NAME=web-01
        TF_ACTION=apply
              │
              └── trigger: templates/linode/virtual-machine/.gitlab-ci.yml
                    strategy: depend
                    ──► validate → plan → apply
```

**When to use:** one product = one resource type.

---

### Pattern 2 — Multiple Webhooks per Product (advanced)

If teams require the webshop to trigger each resource independently (e.g. different trigger tokens per team), the webshop supports a `product_webhooks` table. See [Multiple Webhooks Extension](#multiple-webhooks-extension-pattern-2) below.

---

## Step 2: Configure the Webshop Environment

In the webshop under **Admin → Environments**, create one environment per target:

| Field | Value |
|---|---|
| **Webhook URL** | `https://gitlab.example.com/api/v4/projects/{PROJECT_ID}/trigger/pipeline` |
| **Webhook Token** | The trigger token from Step 1 |

The `{PROJECT_ID}` is the numeric GitLab project ID, visible under **Settings → General** in GitLab.

> **Multiple environments:** Use separate trigger tokens (or separate branches) for `production` and `staging`. Point both webhook URLs to the same project; control the target branch via the `ref` field — the webshop always sends `ref: main`. Use GitLab CI rules or a separate branch per environment to separate concerns.

---

## Step 3: Adding a New Template

All CI pipeline logic is provided by `infra-templates`. To add a new product template:

1. Create `templates/<provider>/<name>/` with `main.tf`, `variables.tf`, `outputs.tf`, `backend.tf`.

2. `backend.tf` must declare an empty HTTP backend — configuration is injected at runtime:
   ```hcl
   terraform {
     backend "http" {}
   }
   ```

3. Create `templates/<provider>/<name>/.gitlab-ci.yml`:
   ```yaml
   include:
     - local: .ci/base.gitlab-ci.yml
   variables:
     TEMPLATE_DIR: templates/<provider>/<name>
   ```

4. Register the template in the root `.gitlab-ci.yml`:
   ```yaml
   trigger-<provider>-<name>:
     stage: dispatch
     trigger:
       include:
         - local: templates/<provider>/<name>/.gitlab-ci.yml
       strategy: depend
       forward:
         pipeline_variables: true      # ← without this the template gets no parameters
     rules:
       - if: $TEMPLATE == "<provider>/<name>"
   ```

   `forward: pipeline_variables: true` is not optional. GitLab does **not** pass
   API-trigger variables to a downstream pipeline by default, so without it the
   order parameters never reach the template and the job fails with
   `No value for required variable "hostname"`.

5. Validate before pushing — nothing in CI does it for you, because the entry
   pipeline only runs on `CI_PIPELINE_SOURCE == "trigger"`:
   ```bash
   make validate TEMPLATE=<provider>/<name>
   tofu fmt -recursive modules/ templates/
   ```

Key pipeline behaviours provided by `base.gitlab-ci.yml`:

- Product parameters (uppercase CI variables) are automatically promoted to `TF_VAR_<lowercase>` so OpenTofu picks them up without extra `tfvars` files.
- `TF_ACTION=destroy` switches both stages to their destroy form: `tofu plan -destroy` and `tofu apply -destroy -auto-approve`.
- The apply stage runs a **fresh plan and apply**, it does not consume the plan artefact from the plan stage. Applying the saved plan failed with `[401] Invalid Token` even where a live API call with the same token in the same job succeeded — the likely cause being how a `sensitive` provider-token variable is carried in a plan file. The plan artefact is still published for inspection.
- The apply job's stdout is read by the portal to parse `Outputs:` and store them on the infrastructure element — no extra `tofu output` call needed.
- State is stored in the `infra-templates` project itself via `CI_PROJECT_ID`; no external state backend is required.

---

## Step 3b: Set Up the GitLab Webhook (callback to portal)

After the pipeline finishes, GitLab must notify the portal so the order or infrastructure element status updates. This is done via a GitLab **Pipeline webhook**.

**In each GitLab infrastructure project:**

```
Settings → Webhooks → Add new webhook
```

| Field | Value |
|---|---|
| **URL** | `https://your-portal.example.com/api/webhooks/gitlab/pipeline` |
| **Secret token** | The **Callback Secret** shown in the portal environment (`Admin → Environments → Edit → Callback Secret → Reveal → Copy`). Since migration 0004 this is a separate, portal-generated value — no longer the same field as the outbound trigger token. |
| **Trigger** | Enable **Pipeline events** only |
| **SSL verification** | Enable (requires a valid TLS certificate on the portal) |

The portal's webhook receiver (`POST /api/webhooks/gitlab/pipeline`) verifies the `X-Gitlab-Token` header against every environment's `callback_secret`. If no environment has a matching secret the request is rejected with `401`. Rotate the callback secret in the portal via the **Regenerate** button; the outbound trigger token can be rotated separately at any time.

The matching environment is also what the event is *scoped* to — its orders and infrastructure elements are the only ones the callback can transition. The secret therefore has to identify exactly one environment, and migration **0006** enforces that with a `UNIQUE` constraint on `callback_secret`. Two notes for existing installations:

- The 0004 backfill copied `webhook_token` into `callback_secret`, and trigger tokens are *not* unique. If you reused one trigger token across several environments, 0006 keeps the lowest-id environment on its original value and **rotates the others** to freshly generated secrets. Those environments need their new secret copied into GitLab (`Reveal → Copy`) before their callbacks are accepted again — until then they return `401`. This is the intended outcome: before 0006 their callbacks were being attributed to the wrong environment.
- On a database that has not yet run 0006, a callback whose secret matches more than one environment is rejected with `409 Ambiguous callback secret` rather than attributed to an arbitrary one of them.

**How the callback is processed:**

1. GitLab sends a `pipeline` event payload for every status transition (`pending`, `running`, `success`, `failed`, `canceled`).
2. The portal maps the GitLab status to its internal `PipelineEvent` type.
3. On `success`: the portal looks up orders in `provisioning` state or infra elements in `decommissioning` state with a matching pipeline ID, transitions their status, fetches the job trace, parses OpenTofu outputs, and sends email notifications.
4. On `failed` / `canceled`: the portal transitions orders to `failed` and logs an audit entry.
5. Intermediate statuses (`pending`, `running`) are received but produce no state changes — they keep the portal informed without side effects.

> **No polling.** The portal does not poll GitLab. All status updates are push-based via this webhook. Ensure the portal is publicly reachable from your GitLab instance (or that the GitLab instance can reach the portal's internal address).

---

## Step 4: `variables.tf`

Define one variable per parameter that the webshop can pass. This file is also used by the webshop's **Browse Repository** feature (Admin → Products → Import variables.tf) to automatically create the matching product parameters.

```hcl
# templates/linode/virtual-machine/variables.tf

variable "hostname" {
  type        = string
  description = "Instance label and state key — must be unique per resource"
}

variable "region" {
  type        = string
  description = "Linode region (e.g. eu-central, us-east)"
  default     = "eu-central"
}

variable "instance_type" {
  type        = string
  description = "Linode instance plan"
  default     = "g6-nanode-1"
}

variable "image" {
  type        = string
  description = "OS image slug"
  default     = "linode/ubuntu22.04"
}

variable "inbound_ports_csv" {
  type        = string
  description = "Comma-separated TCP ports to allow inbound"
  default     = "22"
}
```

**Naming convention:** variable names in `variables.tf` map directly to CI variable names after uppercasing. `hostname` → `HOSTNAME`, `region` → `REGION`, etc. The base CI promotes them to `TF_VAR_*` automatically.

---

## Step 4b: `outputs.tf`

Define outputs so the portal can surface them on the infrastructure detail page. After `tofu apply` the pipeline prints an `Outputs:` section to stdout; the portal parses it from the job trace and stores the key/value pairs.

```hcl
# templates/linode/virtual-machine/outputs.tf

output "ip_address" {
  description = "Public IPv4 address"
  value       = module.vm.ip_address
}

output "hostname" {
  description = "Instance label"
  value       = module.vm.label
}
```

**What the parser reads back.** Outputs are recovered from the job trace, not from
a machine-readable file, because the trace is all the webhook has. Since #97 the
parser keeps every value type OpenTofu prints:

| OpenTofu prints | Stored as |
|---|---|
| `name = "value"` | `value` — quotes stripped |
| `port = 5432`, `ready = true` | `5432`, `true` — unquoted scalars are kept |
| `secret = <sensitive>` | `<sensitive>` — the key is kept, so the UI can say a value exists |
| a multi-line list or map | the printed text, whitespace collapsed onto one line |
| a `<<EOT` / `<<-EOT` heredoc | the body, keeping its own line breaks |

So `tostring()` is no longer needed to make a number survive, and a list no longer
has to be flattened just to be *recorded*. Values are stored as **strings** either
way — nothing downstream parses them back into structure.

Flattening is still the convention where a value is meant to be *consumed*: every
product parameter arrives as a string, so `aws/network` emits its subnet ids as a
comma-separated `subnet_ids`, which is the shape `aws/database-postgres` takes back
in as `subnet_ids_csv` (likewise `inbound_ports_csv`, `backends_csv`,
`dns_servers_csv`). A raw map is fine to display and awkward to feed into the next
template.

**Where the portal looks for it.** The trigger API returns the id of the *entry*
pipeline, and that pipeline holds no `apply` job — only the `trigger-*` bridge of the
dispatch stage. `GET /projects/:id/pipelines/:pipeline_id/jobs` does not list a child
pipeline's jobs, so the portal follows the bridges (`.../bridges` →
`downstream_pipeline`) down to the pipeline that actually applied, three levels at
most — enough for `entry → template` and for `orchestrator → step → template`
(Pattern 3). It reads every successful job whose name starts with `apply`, so a
pipeline stack contributes one `Outputs:` block per step, and the merged map is
stored on every element of the order. Two steps that declare the same output name
are a collision: the pipeline the portal triggered first wins, and the backend logs
a warning naming the key (#121).

Two things in the setup have to be right for any of this to happen, and the backend
log says which one is missing:

| Requirement | Why |
|---|---|
| The environment's **Webhook URL** contains the project: `/api/v4/projects/<id>/trigger/pipeline` | Every GitLab pipeline and job endpoint is project-scoped, and this URL is the only place the portal learns which project to read. A URL of another shape means no outputs, and a `Cannot tell which GitLab project…` warning. |
| The CI source's **access token** has `read_api` (or `api`) on that project | The trigger token can start a pipeline but not read a job log. Without the scope the read fails with 401/404 and the log says so. |

**Never output a credential.** Whatever a template prints is stored on the
infrastructure element, shown in the UI and included in the CSV export. That is why
`linode/kubernetes-cluster` does not output the kubeconfig and
`linode/object-storage` does not output an access key, even though both are
available inside the module.

**Reading the log from Loki instead.** Everything above reads the log back through
the CI provider's own job API, and only GitLab's serves a job's stdout: GitHub
hands a run's log back as a redirect to a ZIP, Bitbucket needs every step
enumerated first — so on those two providers an element never receives its outputs
at all (#97). A deployment whose pipelines ship their stdout to **Loki** gives the
portal somewhere to read it whatever the provider is.

Configure the Loki integration for the environment under Admin → Integrations, and
have each run label the lines it pushes with the element it applied for. The portal
sends exactly one query, and `element_id` is the whole contract:

```
{element_id="42"}     # 42 = INFRA_ID, the element the run was triggered for
```

`INFRA_ID` is passed to every provisioning, retry and destroy trigger for that
reason. How the lines reach Loki is Loki's own push API — the portal only reads,
and never writes a log line itself.

Nothing has to be changed in the same release as the integration: a read that finds
no lines for the element in Loki falls back to the provider's job API, so a
deployment part-way through the move keeps reporting its outputs, and Loki takes
over as soon as the pipeline pushes its first run.

---

## Step 5: `backend.tf`

```hcl
# templates/<provider>/<name>/backend.tf

terraform {
  backend "http" {
    # All backend config is injected at runtime by base.gitlab-ci.yml —
    # the address from CI_PROJECT_ID and TF_STATE_NAME, the credentials
    # from GITLAB_STATE_USERNAME and GITLAB_STATE_TOKEN.
  }
}
```

GitLab provides a built-in HTTP backend for Terraform/OpenTofu state at:
```
/api/v4/projects/:id/terraform/state/:state_name
```
State is stored in the `infra-templates` project itself — no separate state-hosting project or external storage (S3, GCS) is required.

---

## Step 6: Remote State per Resource Instance

Each resource instance has its own state file. State names are provided by the portal as `TF_STATE_NAME`. For single-template orders this is typically the resource label (e.g. `web-01`). For pipeline stacks, the orchestrator appends per-step suffixes (`web-01-vm`, `web-01-dns`).

To reference outputs from an upstream pipeline stack step:

```hcl
# templates/linode/dns-record/main.tf

data "terraform_remote_state" "vm" {
  backend = "http"
  config = {
    address  = "${var.ci_api_url}/projects/${var.ci_project_id}/terraform/state/${var.vm_state_name}"
    username = var.gitlab_state_username
    password = var.gitlab_state_token
  }
}

resource "linode_domain_record" "a" {
  domain_id   = var.domain_id
  name        = var.hostname
  record_type = "A"
  target      = data.terraform_remote_state.vm.outputs.ip_address
}
```

`ci_api_url`, `ci_project_id`, `gitlab_state_username`, `gitlab_state_token` and `vm_state_name` are all exported automatically by the base CI — no manual variable wiring required.

> **Not `CI_JOB_TOKEN`.** A job token does not authenticate against the state
> API on portal-triggered deploys — whether one is accepted at all depends on the
> project's job-token access settings and on who owns the trigger, so it is not a
> credential a template can rely on being granted. Both the backend and this data
> source come back unauthenticated, and OpenTofu reports it as
> `Error refreshing state: HTTP remote state endpoint requires auth` — which
> reads as an expired credential rather than as the wrong kind of one. Set
> `GITLAB_STATE_TOKEN` (an access token with `api` scope) and, unless it is a
> personal token belonging to `gitlab-ci-token`, `GITLAB_STATE_USERNAME`
> alongside it: GitLab authenticates the token AS an account, so a valid token
> sent under the wrong username fails identically.

---

## Step 7: Drift Management

Drift occurs when infrastructure is changed manually (e.g. directly in the Linode web console) instead of through the pipeline.

**Detecting drift:**

Add a scheduled pipeline to run `tofu plan` without applying:

```yaml
# In .gitlab-ci.yml — add to the plan job:
drift_check:
  extends: .tofu_base
  stage: plan
  script:
    - tofu plan -detailed-exitcode   # exits 2 if drift detected
  allow_failure: true
  rules:
    - if: $CI_PIPELINE_SOURCE == "schedule"
```

Configure the schedule under **CI/CD → Schedules** (e.g. daily at 06:00).

**Resolving drift:**

- **Preferred:** Update the OpenTofu code to match the intended state, then let the pipeline re-apply.
- **Emergency:** Run `tofu apply` from the pipeline to revert manual changes.
- **Never** make persistent changes directly in the cloud console — they will be overwritten on the next pipeline run.

---

## Variable Reference

The webshop sends the following CI variables with every pipeline trigger:

### Provisioning trigger (order approved)

| CI Variable | Source | Example |
|---|---|---|
| `TEMPLATE` | Template path (for product webhooks) | `linode/virtual-machine` |
| `TF_STATE_NAME` | Unique state key for this resource | `web-01` |
| `TF_ACTION` | Always `apply` on provisioning | `apply` |
| `ORDER_ID` | Order ID from webshop | `99` |
| `INFRA_ID` | Infrastructure element ID — the row this run is for | `42` |
| `HOSTNAME` | Order parameter `hostname` | `web-01` |
| *(any additional parameter)* | Order parameters (uppercased) | |

For an order with a quantity above 1 every element is triggered separately, so
`INFRA_ID` and `ELEMENT_SEQUENCE` (which suffixes the state key) name the element
that run belongs to. `ORDER_ID` is the same value for all of them.

For pipeline stacks, additionally:

| CI Variable | Source | Example |
|---|---|---|
| `TEMPLATE` | Always `orchestrator` | `orchestrator` |
| `PIPELINE_STACK` | JSON step array from portal | `[{"template":"linode/virtual-machine",...}]` |

### Decommissioning trigger (decommission requested)

| CI Variable | Source | Example |
|---|---|---|
| `TEMPLATE` | Same as at provision time | `linode/virtual-machine` |
| `TF_STATE_NAME` | Same state key as at provision time | `web-01` |
| `TF_ACTION` | Always `destroy` on decommission | `destroy` |
| `INFRA_ID` | Infrastructure element ID | `42` |
| `HOSTNAME` | Stored parameter `hostname` | `web-01` |
| *(all stored parameters)* | Parameters uppercased | |

The CI variable names are derived from the parameter names defined in `variables.tf` — uppercased. Keep parameter names lowercase with underscores (`snake_case`) so they map cleanly to CI variables.

---

## Complete Setup Checklist

```
infra-templates GitLab project setup
  [ ] Create pipeline trigger token (Settings → CI/CD → Pipeline triggers)
  [ ] Set cloud provider credentials as project/group CI/CD variables
        with TF_VAR_ prefix (e.g. TF_VAR_linode_token)
  [ ] For each product: create templates/<provider>/<name>/ with
        main.tf, variables.tf, outputs.tf, backend.tf (empty http block)
  [ ] For each product: create templates/<provider>/<name>/.gitlab-ci.yml
        (include: .ci/base.gitlab-ci.yml, set TEMPLATE_DIR)
  [ ] Register each template in the root .gitlab-ci.yml dispatch block
  [ ] (Optional) Add scheduled pipeline for drift detection

Portal setup
  [ ] Create CI Source (Admin → CI Sources): GitLab URL + access token for repo
        browsing and for reading apply logs (scope: read_api on the project)
  [ ] Create Deployment Environment:
        Webhook URL:   https://gitlab.example.com/api/v4/projects/{infra-templates-ID}/trigger/pipeline
        Webhook Token: the trigger token from the step above
  [ ] Create product, link to environment, set price
  [ ] Import parameters from variables.tf via Browse Repository
        (Admin → Products → Edit → Browse Repository → select variables.tf → Import)
  [ ] On the product edit page, configure either:
        • A Product Webhook with TEMPLATE=<provider>/<name> as a fixed variable, OR
        • A Pipeline Stack for multi-step provisioning

GitLab webhook setup (callback to portal)
  [ ] In the infra-templates GitLab project: Settings → Webhooks → Add new webhook
        URL:          https://your-portal.example.com/api/webhooks/gitlab/pipeline
        Secret token: the Webhook Token set in the portal environment above
        Trigger:      Pipeline events (enable only this one)
        SSL:          enable

Verification
  [ ] Place a test order → pipeline triggered → pipeline_id stored on order
  [ ] Entry pipeline dispatches to the correct template → validate/plan/apply runs
  [ ] GitLab sends webhook on completion → order status → "completed"
  [ ] OpenTofu outputs appear on the infrastructure detail page
  [ ] Check cloud console: resource exists
  [ ] Test decommission → pipeline with TF_ACTION=destroy → status "decommissioned"
```

---

## Multiple Webhooks Extension (Pattern 2)

> Use this only when the orchestrator pattern is not feasible — e.g. when each infrastructure team manages its own trigger token and the webshop must call each repo directly.

### Data Model

**This shipped.** The section below is written in the future tense because it was
a proposal when it was drafted; `product_webhooks` has existed since the very
first migration, `0000_steep_blizzard.sql` — not the `006` the snippet names, and
`0006_unique_callback_secret.sql` is about something else entirely. The DDL is
kept because it still describes the shape accurately.

The `product_webhooks` table stores an ordered list of webhook endpoints per
product+environment combination. The webshop fires them all on order approval or
decommission.

```sql
-- Shipped in 0000_steep_blizzard.sql; this is the shape, not a pending change.
CREATE TABLE product_webhooks (
    id             BIGSERIAL PRIMARY KEY,
    product_id     BIGINT NOT NULL REFERENCES products(id)  ON DELETE CASCADE,
    environment_id BIGINT NOT NULL REFERENCES deployment_environments(id),
    name           TEXT NOT NULL,           -- e.g. "vm-platform", "dns"
    webhook_url    TEXT NOT NULL,
    webhook_token  TEXT NOT NULL,
    exec_order     INT  NOT NULL DEFAULT 0  -- lower = earlier; equal = parallel
);

CREATE INDEX idx_product_webhooks ON product_webhooks(product_id, environment_id, exec_order);
```

### Execution Model

| `exec_order` | Behaviour |
|---|---|
| Same value for multiple rows | Triggered in parallel, all pipeline IDs stored |
| Different values | Triggered in sequence (wait for all at order N before starting N+1) |

Example for the "VM" product in Production:

| name | exec_order | webhook_url |
|---|---|---|
| `vm` | `10` | `.../repo-a/trigger/pipeline` |
| `dns` | `20` | `.../repo-b/trigger/pipeline` |
| `firewall` | `20` | `.../repo-c/trigger/pipeline` |

VM provisions first (order 10), then DNS and firewall in parallel (both order 20).

### Pipeline ID Tracking

Because multiple pipelines run per order, the single `pipeline_id` column is extended to a JSON array:

```sql
-- shipped in 0000_steep_blizzard.sql alongside the table above, not in a separate migration
ALTER TABLE orders ALTER COLUMN pipeline_id TYPE JSONB USING
    CASE WHEN pipeline_id = '' THEN '[]'::jsonb
         ELSE jsonb_build_array(pipeline_id)
    END;
ALTER TABLE orders ALTER COLUMN pipeline_id SET DEFAULT '[]';
```

The order is considered **completed** when all stored pipeline IDs reach `success`; **failed** when any reaches `failed` or `canceled`.

### Root UI

The product edit page (`Admin → Products → Edit`) has a **Webhooks** section per environment where an admin can add, reorder and delete webhook entries.

> **Note:** there is no fallback to an environment-level webhook, and the
> precedence rule this note used to claim never shipped. `hasSomethingToTrigger`
> (`apps/backend/src/lib/services/orders.ts`) looks for `product_webhooks` rows
> and for a pipeline stack, and for nothing else — an offering with neither is
> simply not orderable, and the order is refused with an explanation rather than
> accepted and left hanging. The two mechanisms are alternatives, not a chain.

### When to Use Which Pattern

| Scenario | Recommended pattern |
|---|---|
| One team owns all infra repos | **Orchestrator** — GitLab CI handles the DAG |
| Multiple teams, separate trigger tokens | **Multiple Webhooks** — webshop controls the call order |
| Repos have hard dependencies (VM IP → DNS) | **Orchestrator** — `needs:` and artifacts handle data passing |
| Each webhook needs different parameters | **Multiple Webhooks** — webshop can send per-webhook variable sets |
| Simplest possible setup | **Orchestrator** — fewest moving parts |
| Step sequence needs to change per product without touching CI YAML | **Pipeline Stacks** — portal defines the DAG as data |

---

## Pattern 3 — Portal-Configured Pipeline Stacks

Pipeline Stacks are the built-in successor to the manual orchestrator YAML pattern. Instead of hard-coding the step sequence in `.gitlab-ci.yml`, the portal stores an ordered list of template steps per product+environment in the `pipeline_stacks` database table and passes the entire plan to a generic orchestrator pipeline at trigger time.

### How it works

When an order is approved (or placed directly by an Admin), the portal fires `triggerPipelineStacks()` alongside `triggerProductWebhooks()`. For each pipeline stack configured for the product+environment, it sends one HTTP POST to the **deployment environment's** webhook URL (using the environment's webhook token) — stacks share their environment's trigger endpoint so the same token doesn't need to be maintained in multiple places. The following CI variables are sent:

| CI Variable | Value |
|---|---|
| `TEMPLATE` | `orchestrator` |
| `TF_STATE_NAME` | The `stateKeyParam` value, namespaced with the order id (e.g. `hostname = my-vm-01` on order 42 → `my-vm-01-42`) — see [stateKeyParam](#statekeyparam) |
| `PIPELINE_STACK` | JSON array of step objects (see below) |
| `ORDER_ID` | Webshop order ID |
| *(all other order parameters)* | Uppercased, same as product webhooks |

### PIPELINE_STACK format

```json
[
  {
    "template": "linode/virtual-machine",
    "stateSuffix": "-vm",
    "execOrder": 0
  },
  {
    "template": "linode/dns-record",
    "stateSuffix": "-dns",
    "execOrder": 1,
    "upstreamRefs": [
      { "varName": "VM_STATE_NAME", "suffix": "-vm" }
    ]
  },
  {
    "template": "linode/firewall",
    "stateSuffix": "-fw",
    "execOrder": 1,
    "upstreamRefs": [
      { "varName": "VM_STATE_NAME", "suffix": "-vm" }
    ],
    "fixedParams": { "FW_POLICY": "drop" }
  }
]
```

Each step object:

| Field | Required | Description |
|---|---|---|
| `template` | Yes | Path to the template in the infra-templates repository (e.g. `linode/virtual-machine`) |
| `stateSuffix` | Yes | Appended to `TF_STATE_NAME` to form the unique OpenTofu state key for this step (`my-vm-01-vm`) |
| `execOrder` | No (default `0`) | Non-negative integer. Steps with the same value run in parallel; groups with a higher value wait for lower groups to finish. On destroy the order is reversed automatically. |
| `upstreamRefs` | No | Array of `{ varName, suffix }`. For each entry the orchestrator sets a CI variable named `varName` (UPPER_SNAKE_CASE) whose value is the state name of the referenced step — the base pipeline promotes it to `TF_VAR_<lowercase>` so a Terraform template can read cross-step outputs via `terraform_remote_state`. |
| `fixedParams` | No | Additional CI variables sent only to this step, merged with the shared order parameters |

### stateKeyParam

`stateKeyParam` (default: `hostname`) names the order parameter whose value forms the readable half of the Terraform state key. The portal appends the **order id** to it and restricts it to `[A-Za-z0-9._-]`; the element's position within a multi-quantity order is appended after that (`-2`, `-3`, … for elements two onwards).

The namespace is not cosmetic. The parameter value is typed by whoever places the order, so before it existed two users who typed the same hostname got pipelines pointed at the same Terraform state — and one decommissioning their own element destroyed the other's infrastructure (issue #183). The order id is server-generated, so uniqueness no longer depends on what anyone types.

Example: `stateKeyParam = "hostname"`, order 42 sets `hostname = "my-vm-01"` → the state keys across steps are `my-vm-01-42-vm`, `my-vm-01-42-dns`, `my-vm-01-42-fw`.

The value is stored on the infrastructure element, so a destroy or a retry derives the same key its `apply` used. Elements provisioned before the namespace existed keep deriving theirs from the raw value (`my-vm-01-vm`) — their state lives there.

### Orchestrator pipeline

The orchestrator pipeline in GitLab reads `PIPELINE_STACK` and dynamically generates child pipeline triggers. A minimal implementation:

```yaml
# infra/orchestrator/.gitlab-ci.yml

orchestrate:
  image: python:3.12-alpine
  script:
    - python scripts/run_stack.py
  variables:
    PIPELINE_STACK: $PIPELINE_STACK
    TF_STATE_NAME:  $TF_STATE_NAME
    ORDER_ID:       $ORDER_ID
```

`run_stack.py` parses `PIPELINE_STACK`, iterates the steps in order, calls `POST /projects/:id/trigger/pipeline` for each template pipeline, waits for completion (using `depends:`), and propagates `DESTROY` when set.

### Configuring in the portal

See the Root Guide, section 4.6 "Pipeline Stacks" for step-by-step instructions on creating and managing stacks in the portal UI.

### When to use Pipeline Stacks vs. other patterns

| Factor | Orchestrator YAML | Multiple Webhooks | Pipeline Stacks |
|---|---|---|---|
| Step order | Defined in `.gitlab-ci.yml` | Defined in portal | Defined in portal |
| Adding a step | Edit YAML, redeploy | Add row in portal | Add step in portal |
| Cross-step data passing | GitLab artifacts | Not supported | Via `upstreamRefs` (multiple per step) |
| Parallel steps | GitLab `needs:` graph | Independent webhooks (same `execOrder`) | Via `execOrder` grouping |
| Multiple trigger tokens | Not needed (one project) | One per team | One per stack |
| Destroy | `DESTROY` propagated via YAML | Each webhook receives `DESTROY` | `DESTROY` propagated via stack JSON |
| Best for | Stable infra topology, one team | Many independent teams | Frequently changing products, no CI YAML ownership |
