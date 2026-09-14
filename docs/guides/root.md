# Root Guide

## Overview

The Root account is responsible for:
- Configuring and maintaining the product catalog
- System configuration (CI sources, environments, exchange rates, AI providers, SMTP)
- Managing local user accounts
- Viewing and exporting the audit log

The Root account uses a **local account** (no SSO).

---

## 1. First Login

1. Open your browser and navigate to the webshop URL
2. Click **Local Login**
3. Enter the email address and password from the server configuration (`ADMIN_EMAIL`, `ADMIN_PASSWORD`)
4. After the first login, change the password under **Settings → Profile**

---

## 2. System Configuration

### 2.1 Configuring CI Sources

Under **Administration → CI Sources**:

1. Click **Add CI Source**
2. Fill in the fields:
   - **Name**: Label for the instance (e.g. "Internal GitLab")
   - **URL**: Base URL of the instance (e.g. `https://gitlab.example.com`)
   - **Provider**: **GitLab**, **GitHub**, or **Bitbucket** — determines which API the portal calls to trigger pipelines, browse repositories, and (GitLab only) fetch job traces to parse OpenTofu outputs
   - **Access Token**: A token for that provider with permission to trigger pipelines and read repository contents (GitLab: personal access token with `read_api`; GitHub/Bitbucket: a token with the equivalent repo/workflow scopes)
3. Save

There is no connectivity check on this form — an unreachable URL or bad token only surfaces the first time something actually calls it (browsing repositories when configuring a product, or the first pipeline trigger).

### 2.2 Configuring Deployment Environments

Under **Administration → Deployment Environments**:

1. Click **Add New Environment**
2. Fill in the fields:
   - **Name**: Label (e.g. "AWS Frankfurt", "On-Premises Vienna")
   - **Description**: Optional
   - **CI Source**: Select from the sources configured in 2.1 — any provider
   - **Webhook URL**: URL of the pipeline trigger endpoint for this environment (for a GitLab source: `https://<gitlab>/api/v4/projects/<id>/trigger/pipeline`; see `docs/guides/gitlab-opentofu-workflow.md` for the GitLab setup and the outputs convention it depends on)
   - **Webhook Token**: The **outbound pipeline trigger token** for that provider (for GitLab: `Settings → CI/CD → Pipeline trigger tokens`). Used by the portal to POST the trigger.
3. Save
4. Open the newly-created environment via **Edit** → the **Callback Secret** panel is now populated with a portal-generated random value:
   - Click **Reveal current** → **Copy**
   - In GitLab, go to `<infra-templates project> → Settings → Webhooks → Add new webhook`:
     - URL: `https://<your-portal>/api/webhooks/gitlab/pipeline`
     - Secret token: **paste the callback secret**
     - Trigger: only **Pipeline events**
     - Save
   - Any future pipeline event on that project now reaches the portal (`POST /api/webhooks/gitlab/pipeline`) and updates the associated order/infrastructure status.

   For a GitHub or Bitbucket source, the same callback secret is used, but the portal checks it differently: GitLab compares it directly against the `X-Gitlab-Token` header, while GitHub (`/api/webhooks/github/workflow`) and Bitbucket (`/api/webhooks/bitbucket/pipeline`) instead use it as an HMAC key and verify `X-Hub-Signature-256` / `X-Hub-Signature`. Register the secret as that provider's webhook secret when adding the webhook on the GitHub/Bitbucket side.
5. If you ever need to rotate this secret, use **Regenerate** in the same panel — the new value is displayed once; paste it into the CI provider's webhook configuration to keep the callback flowing.

> **Two separate tokens on the environment:** *Webhook Token* is what the CI provider expects on the outbound pipeline-trigger POST; *Callback Secret* is what the portal expects on the inbound pipeline-event webhook. They are stored in distinct columns and can be rotated independently.

### 2.3 Configuring SMTP

Under **Administration → Email**:

1. Enter SMTP server details: **Host**, **Port** (default `587`), **From Address**, **Username**, **Password**, and **Use TLS** (checkbox)
2. Click **Save Configuration**

There is no "send test email" button — the only way to confirm SMTP works is to trigger a real notification (e.g. place an order) and check whether it arrives.

> **Persistence:** SMTP settings saved here are stored in the `app_config` database table and override the environment variable defaults at runtime. The configuration persists across container restarts. If the password field is left blank during an update, the existing stored password is preserved.

### 2.4 Exchange Rates

Under **Administration → Exchange Rates**:

A read-only table of the currently stored rates (currency, rate to EUR, last updated). Click **Refresh Rates** to re-fetch current rates from the exchange-rate API configured via the `EXCHANGE_RATE_API_URL` environment variable.

The base currency is **fixed to EUR** — every stored rate is "to EUR", and there is no admin control to change it. There is also no way to enter an API key/URL in the UI or to override an individual rate by hand; both of those are configured, if at all, only through `EXCHANGE_RATE_API_URL`.

### 2.5 Configuring AI Translation (optional)

Under **Administration → AI Configuration**:

1. Select a **provider**: Anthropic Claude, OpenAI, Azure OpenAI, Ollama (Local), or LocalAI
2. **API Endpoint** *(optional)* — leave blank to use the default endpoint for the selected provider
3. **API Key** *(required by the hosted providers; not needed for a local Ollama/LocalAI endpoint)* — leave blank on an update to keep the existing key
4. **Model** — required; the field is pre-filled with an example for the selected provider (e.g. `claude-opus-4-5`, `gpt-4o`, `llama3`)
5. Click **Save Configuration**

There is no connection test — an invalid endpoint, key or model only surfaces the next time a translation is actually requested from product editing.

> **Persistence:** AI translation settings saved here are stored in the `app_config` database table and override the environment variable defaults at runtime. The configuration persists across container restarts. If the API key field is left blank during an update, the existing stored key is preserved.

---

## 3. Product Categories

Under **Administration → Categories**:

- Create, edit, and delete categories
- Each category can have a **category parameter set** (applies to all products in that category)
- Display order in the catalog is configurable

> **Important when deleting a category:** The webshop automatically fires the CI destroy trigger(s) for every active infrastructure element belonging to any product in the category before the category record is removed. All products and their dependent data within the category are removed via cascading deletes afterward.

---

## 4. Managing the Product Catalog

### 4.1 Creating a New Product

Under **Administration → Products → New**:

**Step 1 – Basic Information**
- Select a **category**
- Enter **name** and **description** in the base language
- Upload an **image** (PNG, JPEG or WebP, max 10 MB) — optional, and addable later
  on the product's edit page under **Product Images**

  The type is determined from the file's own bytes, not from what the browser
  declares, and SVG is refused: it can carry script and this file is served back to
  every visitor of the product page.

  A picture uploaded here becomes the **first** of the product's gallery. Add the
  rest on the edit page: up to eight per product, each with its own description,
  and the order you put them in is the order the product page shows them — the
  first one is what the catalogue tile, the cart row and the favourites card use.
- Optionally name an **owner** (the team that runs the product) and a
  **documentation link** (`http://` or `https://`). Both appear under
  *Good to know* on the product page, and each is simply left out when empty.

**Step 2 – Translations**
- If an AI provider is configured: click **Generate AI Translation**
- AI translates name and description into all enabled languages
- Every translation also has a **long description** — the product story, shown only
  on the product page while the short description stays on the catalogue tile.
  Blank lines start a new paragraph; markup is not rendered. The AI translator
  writes name and description only, so a long description is written by hand and is
  never overwritten by it
- Individual translations can be edited manually
- Review all translations before saving

**Step 3 – Parameters**

Parameters are configured on the product edit page under the **Parameters** card. There are two ways to populate them:

*Option A: Sync from template (recommended; in practice GitLab only)*
1. First add a **Pipeline Stack** for this product (see section 4.6)
2. Click **Sync from template** — the platform fetches the *first step's* template `variables.tf` from your CI source and creates parameters automatically

   The gate here is the **shape of the environment's webhook URL**, not the CI
   source's provider field: `sync-parameters/route.ts:51` pulls the project id
   out of it with `/\/projects\/(\d+)\//`, then calls `getFileContent` with
   whatever provider the source carries. Only GitLab webhook URLs carry that
   `/projects/<id>/` path, so the feature is GitLab-only in effect — but a
   GitHub or Bitbucket source whose webhook URL happened to match would be let
   through and then fail further in.
3. Each parameter is created with:
   - **Variable Name**: exact Terraform variable name (e.g. `hostname`) — sent to the CI pipeline as `TF_VAR_hostname`
   - **Display Label**: auto-generated human-readable name (e.g. `Hostname`) — shown to users in the order form. Edit this to be more descriptive if needed.
4. Sensitive variables, internal CI variables and names the server owns are automatically excluded — see *Reserved parameter names* below

This only works today when the pipeline stack's environment uses a **GitLab** CI source: the endpoint recovers the GitLab numeric project id from the environment's Webhook URL (`/projects/<id>/trigger/pipeline`) to know where to fetch `variables.tf` from. On a GitHub or Bitbucket environment it fails with "Could not extract project ID…" — use Option B there.

*Option B: Manual entry*
- Click **Add Parameter**
- Set **Variable Name** (must match the Terraform variable name), **Display Label** (user-facing), type (string, number, bool, dropdown, size), description, default value, and the required/sensitive flags
- Click **Edit** on any existing parameter to modify it

*Type `size` — the variable a T-shirt size decides*

A size used to be nothing but a code, a label and a price. It reached the pipeline
as `SIZE=M`, which the CI base promotes to `TF_VAR_size` — and no template in
`infra-templates` declares `variable "size"`, so OpenTofu dropped it. Choosing XL
changed the price and nothing about the machine.

Give the variable type **size** instead, and say what each size code means for it:

```
S=t3.micro
M=t3.large
XL=m6i.2xlarge
```

The customer never sees a field for it — the size picker is its control — and the
values it sets are shown, read-only, beside that picker. A submitted value is
ignored, so nobody can buy an S and provision an XL.

Which variable this is depends on the template:

| Template | Variable(s) |
|---|---|
| `aws/virtual-machine` | `instance_type`, and `root_volume_size_gb` if disk should scale too |
| `linode/virtual-machine` | `instance_type` |
| `vsphere/virtual-machine` | `num_cpus`, `memory_mb`, `disk_size_gb` — all three |

vSphere is why the map lives on the **variable** and not on the size: one size has
to drive three variables, so each is its own `size` parameter with its own map.

*Different values in different environments*

A parameter can be scoped to one environment, and an environment-specific row wins
over one that applies to all of them (product beats category beats global, and
within a scope, specific beats general). So `instance_type` can be `m6i.2xlarge` at
size XL on AWS and `g6-dedicated-16` at size XL on Linode: two parameter rows, one
per environment, each with its own map.

A size that the map has no value for is **refused at order time**, naming both the
size and the parameter, rather than provisioning an empty `instance_type` and
letting Terraform choose.

*Reserved parameter names*

A parameter's name becomes a CI trigger variable verbatim, so the names the portal
itself sets are refused (case-insensitively) on both create and edit:
`REF`, `BRANCH`, `WORKFLOW`, `TF_ACTION`, `TF_STATE_NAME`, `TF_STATE_NAMESPACE`,
`TEMPLATE`, `PIPELINE_STACK`, `ORDER_ID`, `ELEMENT_SEQUENCE`, `INFRA_ID`, `TRIAL`
and `TRIAL_DURATION_MINUTES`. A parameter named `REF` would have let anyone who can
order the product choose which git ref the provisioning pipeline runs, and one named
`TF_ACTION` would have turned a provisioning order into a destroy (issue #183).
Values submitted under these names are stripped on their way to the pipeline, so a
definition created before the check existed is inert rather than dangerous.

**Step 4 – Deployment Environments**
- Select environments in which the product should be available
- Per environment: webhook URL (if different from environment configuration) and environment-specific parameters
- **Order Callbacks:** For each selected environment, you can configure optional HTTP callbacks via the **Order Callbacks** card on the product edit page. These notify external systems (e.g. ticketing, monitoring) after an order is processed — they do not trigger provisioning (that is handled by Pipeline Stacks).

**Step 5 – Pricing**
- Enter a price in the base currency per environment (e.g. AWS: 70 EUR, on-premises: 20 EUR)
- Prices are informational; no payment processing

*Sizes — a price per size per environment*

An offering's own price applies only while it has **no** sizes. Once it has one,
the customer must pick a size and pays that size's price, not the offering's.

Sizes are edited on the product edit page in the **Sizes** card, as a matrix:
one row per size code, one column per environment the product is offered in.

|      | AWS Frankfurt | On-Premise Vienna |
|------|---------------|-------------------|
| `S`  | 10.00 EUR     | 10.00 CHF         |
| `XL` | 40.00 EUR     | 100.00 CHF        |

- Reading a **row** answers "what does XL cost, and where" — the comparison the
  per-environment price exists for
- Saving a row prices that size in every environment at once, in one transaction:
  a rejected price leaves none of the others written
- Currency is per **cell**, not per row. The same size legitimately bills in EUR in
  one environment and CHF in another; the catalogue compares them through the
  configured exchange rates
- An **empty cell** means the size is not offered in that environment. That is a
  real state, not an error
- Emptying a priced cell **retires** the size there — it stops being orderable but
  the row and its price survive, because orders that already name the code have to
  keep rendering. The cell shows what it was last priced at underneath. Typing a
  price back in restores it
- **Delete** removes the code from every environment at once. Existing orders keep
  the code and the price they were charged, but a basket line naming it reports the
  size as unavailable — prefer retiring for a size that has ever been ordered
- The code reaches the pipeline as `SIZE`; see *Type `size`* above for how it is
  turned into template variables

**Step 6 – Cost Center Configuration**
Per environment, set:
- **Cost Center Mode**: **From Project** (the order's project supplies the cost center) / **User Selection** (the orderer picks one from the list) / **Overhead** (every order is billed to one fixed account)
- **Forced CC**: checked → the orderer cannot pick a different cost center (for "User Selection", the picker is still shown but the choice is otherwise just a suggestion when unchecked); for "Overhead", checked makes the **Overhead Cost Center** field mandatory — orders are rejected until one is set
- For "Overhead" mode: select the **Overhead Cost Center** from the list of active cost centers

**Step 7 – Trial (optional)**

Check **Offer as trial** to let orderers provision this offering as a self-expiring trial instead of (or alongside) a normal order:
- **Trial duration (minutes)**: how long after provisioning the infrastructure is automatically decommissioned
- The order form shows a **Try it out** checkbox to the orderer only for environments where this is enabled
- Tearing a trial down on time still needs the [scheduled-decommission sweep](../../README.md#scheduled-decommissioning) configured — the duration is stored as a `scheduledDecommissionAt`, the same field a manual schedule uses, and nothing acts on it without the sweep running
- A trial's pipeline is asked to grant elevated rights inside the provisioned infrastructure — offer this only for templates that actually implement that

### 4.2 Editing a Product

Open the desired product under **Administration → Products**. All fields from creation can be edited. Translations can be regenerated via AI or edited manually at any time.

**Product Image** — the image itself and its description (alt text) are edited separately:
- **Image description**: required before an image can be uploaded, capped at 300 characters, and enforced on both sides — the browser refuses to upload without it, and the server refuses the request too. It is what a screen reader announces instead of the picture, and what displays if the image fails to load. Click **Save description** to update it without touching the file.
- **Image file**: PNG, JPEG or WebP, up to 10 MB. The type is determined from the file's own bytes, not from what the browser declares, and SVG is refused (it can carry script and this file is served back to every visitor of the product page).
- **Remove image** deletes the stored image and its description.

**Version History** — every edit to a product or one of its environment offerings is recorded automatically (no separate save/publish step) as a version, with an auto-generated summary of what changed and an optional free-text changelog. The product edit page shows the full history and lets you pick any two versions to see a field-level diff (added/removed/changed parameters, changed offering fields). An order's own detail page shows the product exactly as it was at order time (a frozen snapshot), not the current live version.

### 4.3 Deleting a Product

1. Open the product under **Administration → Products**
2. Click **Delete**
3. Confirm in the dialog

> **Important:** Before the product record is removed, the webshop automatically fires the CI destroy trigger(s) for every active infrastructure element that was provisioned from this product. Infrastructure already in status *Decommissioning* or *Decommissioned* is skipped. Dependent database rows (translations, parameters, environment assignments) are removed automatically via cascading deletes.

### 4.4 Global Parameter Sets

Under **Administration → Global Parameters**:

Parameters that apply to *all* products and *all* environments (e.g. project tag, cost center label). These are automatically added to the order form.

**Which definition wins when several apply.** A parameter name can be defined at
more than one level, and the order form resolves it to exactly one effective
definition, in this order:

1. **Scope** — product beats category beats global.
2. **Environment** — at the same scope, a definition for one environment beats
   one that applies to all environments.
3. **Project narrowing** — at the same scope and environment, a definition
   narrowed to specific projects beats an unnarrowed one, for those projects.
4. **Most recent** — if two definitions are alike on all three, the one created
   last wins.

Rule 4 exists because nothing prevents two parameters with the same name at the
same scope and environment: there is no uniqueness constraint, and **Add
Parameter** does not refuse a duplicate. Before it, which of them applied — and
therefore which default value, type, required flag and *sensitivity* an order
was validated against — was whatever the database happened to return first, and
could differ between two page loads. If you find two definitions of the same
name at the same level, delete one; rule 4 makes the behaviour predictable, not
correct.

### 4.5 Available Templates

What to enter as **Template** when configuring a product or a pipeline-stack step.
The full parameter tables are in `docs/guides/gitlab-opentofu-workflow.md`
(“Template Catalogue”) and in the `infra-templates` README; **Sync from template**
reads the same `variables.tf`, so you rarely need to type parameters by hand.

| Provider | Template | Provisions |
|---|---|---|
| Linode | `linode/virtual-machine` | Instance with its own firewall |
| Linode | `linode/firewall` | Standalone firewall |
| Linode | `linode/dns-record` | DNS record |
| Linode | `linode/block-storage` | Volume, optionally attached to an instance |
| Linode | `linode/kubernetes-cluster` | LKE cluster |
| Linode | `linode/load-balancer` | NodeBalancer in front of given backends |
| Linode | `linode/object-storage` | S3-compatible bucket |
| AWS | `aws/network` | VPC with one public subnet per availability zone |
| AWS | `aws/virtual-machine` | EC2 instance with its own security group |
| AWS | `aws/object-storage` | S3 bucket |
| AWS | `aws/database-postgres` | RDS Postgres |
| vSphere | `vsphere/virtual-machine` | VM cloned from a template, Linux or Windows |

Two things to know before offering these:

- **AWS products need a network first.** `aws/virtual-machine` and
  `aws/database-postgres` take a `vpc_id` and subnet ids that come from an
  `aws/network` order. Either order the network once and configure its ids as fixed
  parameters, or — better — build a **pipeline stack** with the network as the first
  step and reference its state from the later ones (section 4.6).
- **Credentials are per provider and live in GitLab**, not in the portal: Linode and
  vSphere as `TF_VAR_*` variables, AWS as its own `AWS_ACCESS_KEY_ID` /
  `AWS_SECRET_ACCESS_KEY`. A product whose provider has no credentials configured
  fails in the apply job, not at order time.

For a Windows VM in vSphere, set the product parameter `guest_os_family` to
`windows`. Leaving it at `linux` clones the template but leaves the guest
unconfigured — no hostname, no address, no domain membership.

---

### 4.6 Pipeline Stacks

Under **Administration → Products → [product] → Pipeline Stacks**:

Pipeline Stacks let you define an ordered sequence of CI/CD template steps per product+environment directly in the portal — no changes to `.gitlab-ci.yml` required. When an order is approved (or placed directly by an Admin), the portal sends the full step list as `PIPELINE_STACK` JSON to the CI orchestrator pipeline alongside the normal order parameters.

**Creating a pipeline stack:**

1. Open the product under **Administration → Products** and click **Edit**
2. Scroll to the **Pipeline Stacks** card and click **+ Add Stack**
3. Fill in the required fields:
   - **Name**: Label for this stack (e.g. "VM + DNS")
   - **Environment**: Which deployment environment this stack applies to. The stack inherits the environment's **Webhook URL** and **Webhook Token** for outbound pipeline triggers — manage them once under **Admin → Environments**, not per stack.
   - **State Key Parameter**: Name of the order parameter whose value forms the readable half of the OpenTofu state key (default: `hostname`). The portal appends the order id to it, so two orders that submit the same value no longer share a state file.

     What is stored on the infrastructure element is the **namespace** — the order id half — not the whole key. The readable half is re-derived from this field every time a pipeline runs for that element, including its destroy. So this field cannot be changed while elements provisioned through the stack are still standing: the portal refuses the edit with a 409 naming how many, because a changed value would make their teardown address a state that was never created, report success, and leave the real infrastructure running while the portal shows it as decommissioned (#200). Decommission them first, or add a second stack for new orders.
4. Click **+ Add Step** one or more times to build the step sequence:
   - **Template**: Path to the step template in the infra-templates repo (e.g. `linode/virtual-machine`)
   - **State Suffix**: Appended to the state key to form the unique state name for this step (e.g. `-vm`)
   - **Exec Order** *(default `0`)*: Non-negative integer. Steps with the same value run in parallel (single GitLab stage); groups with a higher value wait for all lower groups to finish. On destroy the group order is reversed automatically.
   - **Upstream State Refs** *(optional, one or more)*: Each entry maps a CI variable name (UPPER_SNAKE_CASE, e.g. `VM_STATE_NAME`) to the `stateSuffix` of an earlier step. At runtime the orchestrator sets that variable to the state name of the referenced step, and the base pipeline promotes it to `TF_VAR_<lowercase>` — so a Terraform template can read cross-step outputs via `terraform_remote_state`.
   - **Fixed Params** *(optional)*: Additional CI variables specific to this step, one `KEY=value` per line
5. *(Optional)* Click **Preview YAML** to inspect the generated GitLab pipeline before saving.
6. Click **Add** — the stack appears in the list

**How it works at runtime:**

When an order is triggered, the portal calls the configured webhook URL with:
- `TEMPLATE=orchestrator`
- `TF_STATE_NAME=<stateKeyParam value>-<order id>`
- `PIPELINE_STACK=<JSON array of steps>`
- All standard order parameters (`ORDER_ID`, `NAME`, etc.)

The orchestrator pipeline reads `PIPELINE_STACK` and dynamically triggers the individual template pipelines in the defined order.

**Managing existing stacks:**

- Each stack is listed with its name, environment, and step count
- Click **Edit** on a stack to update its name, state key parameter, or steps. The environment cannot be changed after creation, and the state key parameter cannot be changed while the stack has deployed elements (see above). Trigger URL and token are managed on the environment itself — rotate them in one place and every stack picks up the new value automatically.
- Click **Delete** on a stack entry to remove it — active infrastructure is not affected, but future orders for that product+environment will no longer trigger that stack

> **Order Callbacks vs. Pipeline Stacks:** Order Callbacks (section 4.1 "Step 4") notify external HTTP endpoints after order processing and are optional. Pipeline Stacks call a single orchestrator CI pipeline and let the portal define the execution DAG as data — suitable when all steps share one orchestrator entry point.

---

## 5. Managing Cost Centers

Under **Administration → Cost Centers**:

- Create cost centers (name, cost center code, description)
- Edit and deactivate cost centers (deactivated cost centers are no longer selectable for new orders)
- This list is shown to orderers when the cost center mode is "Select"

### 5.1 Budgets

Each cost centre can carry a budget. **Budget** on a row opens it; a cost centre
without one behaves exactly as it did before budgets existed, so this is opt-in
and nothing changes until you set one.

A budget is four things:

| Field | Meaning |
| --- | --- |
| **Amount** and **Currency** | The limit. Committed spend in other currencies is converted through the stored exchange rates; amounts with no rate are reported separately rather than folded in at a guessed rate. |
| **Period** | **Total** — one pot that never resets. **Monthly** — resets each calendar month. |
| **When the budget is spent** | **Block** — the order is refused. **Warn** — the order goes through, and the orderer, the approver and the audit log are all told. |

The row shows committed-over-limit (`2500.00 / 10000.00 EUR`) once a budget is
set, and says **Over budget** when it is gone. The modal shows the committed
figure *before* you set a budget too, which is what tells you whether the limit
you are about to type has already been spent.

**What "committed" counts.** Orders that are **pending, provisioning or
completed** — what has been *asked for*, not only what has been built. This is
deliberately wider than the Costs page, which counts provisioning and completed
only: an approval queue full of pending orders would each see budget left,
because none of them exists yet, and then collectively blow it the moment they
are approved.

**What "monthly" counts, and what it does not.** Orders **placed** in the
calendar month. A price in this catalogue records an amount and a currency and
*no billing period*, so there is no honest way to derive a run rate from it — a
machine ordered in January and still running in June consumes budget in January
only, and a long-lived estate therefore looks cheaper than it is. The modal says
so when you choose Monthly. Giving prices a billing period is its own piece of
work (see the note in issue #325).

**Who may set one.** Root only — separately from the rest of this screen, which
is `admin`. Renaming a cost centre and deciding what the platform refuses to
provision are different powers.

**Overriding a block.** Root, and only root, can place a single order against a
spent `block` budget. It is recorded as `order.budget_overridden` in the audit
log, names the cost centre, and the orderer is still told the order went through
over budget. A hard block with no way past it becomes an outage during the one
incident where somebody genuinely needs to provision.

**Where the check bites.** At order creation, which both checkout and approval go
through — so an order approved next week cannot spend a budget that is already
gone. A `warn` budget shows on the approvals queue row as well, because the gate
runs when the approval is *granted*: without it the approver would learn about a
block only by clicking Approve and being refused.

**What the figures cannot tell you.** Two caveats are shown in the modal rather
than left for you to discover:

- *Orders with no recoverable price.* An order placed before price snapshots
  existed, whose offering has since been withdrawn, has no price anywhere. Its
  spend is missing from Committed, and there is no number to add — the price is
  unknown, not zero. The count is shown so you know the figure beside it is
  incomplete. These are not refused: the offering cannot be re-priced, so
  blocking on them would make the cost centre permanently unorderable.
- *Amounts in a currency with no exchange rate.* Reported separately rather than
  folded in at a rate that does not exist. An **incoming** order in such a
  currency is a different matter: a `block` budget refuses it, because with no
  rate there is no way to show it fits. Adding the rate under
  **Administration → Exchange Rates** is the remedy, and the message says so.

**Under concurrent load the block is best-effort.** The check and the order are
two steps, so two orders placed against the same cost centre within the same
instant can both pass a check that only one of them should have. The overspend
is bounded by one order's value. Making it strict means serialising every order
against a cost centre, which costs throughput on checkout — see issue #403 for
the trade-off.

Removing a budget clears all four fields together and the cost centre stops
refusing anything. Nothing already ordered changes.

---

## 5a. Deployment Windows

Under **Administration → Deployment Windows**:

Provisioning normally happens the moment an order is approved. Where you would
rather it happened while somebody is watching, define **deployment windows** —
the hours during which provisioning may run.

- A **time zone** (an IANA name such as `Europe/Berlin`), and any number of
  windows, each a **start time** and a **duration in minutes**.
- The same pattern applies every working day. There is no per-weekday editing:
  the question being answered is "when is somebody watching", which is a
  property of the working day rather than of Tuesday.
- Windows may not overlap and may not cross midnight. They are saved as a set,
  so a rearrangement is one save rather than a sequence of half-valid states.
- **Saturdays, Sundays and public holidays are excluded automatically.**

This changes nothing on its own. Each environment carries its own switch, under
**Administration → Environments → Edit → "Waits for a deployment window"**, and
it is **off by default** — Production honours the windows; a sandbox that stops
deploying after 18:00 is an obstacle rather than a safeguard.

**What happens to an order.** The approval never fails for being out of hours:
the decision is recorded and the work is kept. Only the provisioning waits, and
the order shows as **Scheduled** with the time its window opens.

**Releasing them needs a scheduler.** The portal has no background worker, so
something outside it must call
`POST /api/internal/deployment-window-sweep` with the shared secret
`DEPLOYMENT_WINDOW_SWEEP_SECRET` in the `X-Sweep-Secret` header. On Kubernetes
set `deploymentWindowSweep.enabled`; on a Docker host add a cron entry. Call it
every minute or two — that interval is the delay between a window opening and
the orders in it deploying.

> Without the sweep configured, an order that reaches **Scheduled** waits
> indefinitely. If you turn the environment switch on, turn the sweep on too.

**Holidays.** Under the same screen. Give a **feed URL** — an ICS calendar or a
JSON list of holidays, both are read — and press **Preview** to see the dates
before saving. The resolved dates are cached in the database, so deciding
whether an order may deploy never waits on the feed.

- The screen shows how old the last successful read is, and complains past 30
  days. A failed refresh changes nothing: the last good set stays.
- **Add a date by hand** for a company shutdown week no public calendar knows
  about.
- **Work through** un-ticks a public holiday this company does not take. Use
  that rather than removing the row — a deleted feed date comes back on the next
  refresh, because the feed is the source for those.

> **If a feed is configured and has never been read successfully, deployment
> windows are switched off entirely** and orders deploy immediately. With no
> holiday data the portal cannot tell a holiday from a working day, and quietly
> deploying on Christmas morning is the thing this feature exists to prevent —
> so it stops claiming to do the job instead. The screen says so in red. Fix the
> feed, or clear the URL.

Refreshing needs the same scheduler as the sweep: `POST
/api/internal/holiday-refresh` with `DEPLOYMENT_WINDOW_SWEEP_SECRET` in
`X-Sweep-Secret`. On Kubernetes the chart ships a daily CronJob with the sweep;
on a Docker host add a daily cron entry. You can also refresh from the screen.

**Deploying early.** **Root only** — not admins, and not the person who placed
the order. On a scheduled order the Root account sees a **Deploy now** button,
which provisions it immediately. It is written to the
audit log as `order.window_overridden`, naming you and the window that was
skipped.

---

## 6. User Management

Under **Administration → Users**:

- Create local user accounts (name, email, password, role)
- Edit or deactivate existing accounts
- Roles: **Admin**, **Project Manager**, **Root**

---

## 7. Audit Log

Under **Administration → Audit Log**:

- Table of all logged actions with timestamp, user, action, and details
- Paginated — 50 entries per page
- Filterable by: user, action type, date range (from/to)
- Export as **CSV** or **PDF** — format selectable before export

Logged action types (this list has grown since the feature was first documented — check `logAudit(` call sites — they live under `apps/backend/src/lib/services/`, `apps/backend/src/lib/webhook/` and `apps/backend/src/app/api/audit/export/`):

| Action | Trigger |
|--------|---------|
| `order.created` | A new order is placed |
| `order.provisioning` | An Admin/Root places an order directly (no approval step) |
| `order.approved` | An Admin approves a pending order |
| `order.rejected` | An Admin rejects a pending order |
| `order.completed` | A CI/CD pipeline completes successfully |
| `order.failed` | A CI/CD pipeline fails |
| `order.comment_added` / `order.comment_internal_added` | A comment is added to an order (the internal variant logs when it is marked internal) |
| `order.comment_edited` / `order.comment_deleted` | A comment's author edits or deletes it |
| `cart.checked_out` | A cart checkout completes (whether or not every item succeeded) |
| `infra.decommissioning` | A decommission (immediate or scheduled) starts tearing an element down |
| `infra.decommissioned` | An infrastructure element finishes decommissioning |
| `infra.decommission_failed` | A decommission pipeline fails; element reverts to active |
| `infra.decommission_partial` | A multi-trigger decommission only started tearing down some of its triggers |
| `infra.decommission_scheduled` / `infra.decommission_schedule_cleared` | A future decommission time is set or cleared on an element |
| `infra.retried` / `infra.retry_failed` | A failed deployment's triggers are retried, and whether that retry itself succeeded to start |
| `product.version_recorded` | A product or one of its offerings is edited, recording a new version |
| `product.updated` / `product.translation_updated` / `product.image_alt_updated` | A product, one of its translations, or an image's alt text is edited |
| `product.webhook_updated` / `product.webhook_deleted` | An order callback on a product is saved or removed |
| `category.created` / `category.updated` | A catalogue category is added or edited |
| `cost_center.created` / `cost_center.updated` | A cost centre is added or edited |
| `cost_center.budget_set` / `cost_center.budget_cleared` | A cost centre's budget is set, changed or removed (5.1) |
| `order.budget_warning` | An order went through with its cost centre's budget already spent, under a `warn` budget |
| `order.budget_overridden` | Root placed an order against a spent `block` budget |
| `project.created` / `project.updated` | A project is added or edited |
| `user.created` / `user.updated` | An account is created, or its role/details change |
| `environment.updated` | A deployment environment is edited |
| `environment.callback_secret_revealed` / `environment.callback_secret_rotated` | An environment's callback secret is shown or replaced — both, because seeing it is as sensitive as changing it |
| `ci_source.updated` | A CI source is edited |
| `pipeline_stack.deleted` | A pipeline stack is removed from an offering |
| `config.smtp_updated` / `config.ai_updated` | SMTP or AI provider settings are saved |
| `branding.updated` / `branding.logo_updated` | Branding colours/text are saved, or the logo is replaced |
| `integration.probed` | An external integration's reachability is tested |
| `category.deleted` / `cost_center.deleted` / `ci_source.deleted` / `environment.deleted` / `user.deleted` | A catalogue category, cost centre, CI source, environment or account is deleted — the entries an audit reader looks for first |
| `product.offering_withdrawn` | A product's offering in one environment is withdrawn, so it can no longer be ordered there |
| `exchange_rate.refreshed` | Currency rates are refreshed from the configured API |

---

## 8. Infrastructure Overview

Under **Infrastructure**:

- Complete overview of all deployed infrastructure elements, grouped by project and environment
- As Root all projects are visible (including those of other users)
- Decommissioning (immediate or scheduled), reordering and retrying a failed deployment all work the same way as for an Admin — see `docs/guides/admin.md` section 5 for the full detail-page walkthrough (Outputs/Parameters/Pipelines cards, action buttons)

---

## 9. Shop Design

Under **Administration → Shop Design** (or directly at `/admin/branding`):

### 9.1 Colors

- **Primary color**: Used for the header, footer, and navigation bar. Default: `#131921` (dark navy).
- **Secondary color**: Used for buttons and call-to-action elements. Default: `#febd69` (amber). The text and border painted on it are derived, not fixed — `layout.tsx` sets `--bs-ink` from `readableInk(secondaryColor)` and `--bs-edge` from `readableAccent(secondaryColor, undefined, AA_NON_TEXT)` — so a light secondary stays AA-clean rather than needing to be replaced.
- The live preview on the right updates in real time as you change the color values.

### 9.2 Logo

- Upload a logo image — any image type the browser will pick (`accept="image/*"`); there is no format allowlist, size limit, or dimension check on either side, unlike the product image upload
- The header renders it at a fixed small size (32px tall, capped at 120px wide, scaled to fit) regardless of the uploaded image's actual dimensions, so an oversized file just costs load time, not layout
- The logo replaces the shop name text in the header
- Leave empty to display the shop name as plain text

### 9.3 Shop Name and Subtitle

- **Shop name**: Displayed in the header and browser title. Defaults to "InfraShelf" — there is no `APP_NAME` environment variable; the name lives only in this database-backed setting.
- **Subtitle / Tagline**: Short description shown in the footer. Defaults to empty — likewise, there is no `APP_SUBTITLE` environment variable.

### 9.4 Imprint (Legal Notice)

- Enter the full imprint text in the **Imprint** field (plain text, line breaks are preserved)
- Once saved, an **Imprint** link appears in the footer
- The imprint is publicly accessible at `/impressum` (no login required)
- Leave empty to hide the imprint link entirely

---

## 10. Settings / Profile

Under **Settings → Profile** (`/settings/profile`):

### 10.1 Password Change

1. Enter your **current password**
2. Enter a **new password** (minimum 8 characters)
3. Confirm the new password — both fields must match
4. Click **Save**

If the current password is incorrect or the confirmation does not match, the change is rejected and an error message is shown.

### 10.2 Two-Factor Authentication

Administrator accounts hold enough privilege to change what the portal does, so
they are protected with a second factor: a six-digit code from an
authenticator app (Google Authenticator, Authy, Bitwarden, 1Password — anything
that supports standard TOTP).

It is **required**, not optional, and it applies to both administrative roles —
**Root and Admin**. A local administrator with no authenticator can sign in, and
then do nothing else: every part of the portal except the enrolment card answers
"two-factor authentication is required", and the app sends them straight to
Settings until they have one. Signing them in is deliberate — enrolling needs a
working session, and refusing the sign-in would be a lockout with no way out.

Two kinds of account are outside this:

* **Accounts with no local password.** Enrolment is re-authenticated with the
  current password, so an account that has none has nothing to enrol against.
  The server refuses enrolment for it and — importantly — does not require one
  either: requiring a factor it could never enrol would be a lockout rather than
  a policy. Only a single-sign-on account was ever created this way, and that
  flow was removed (#139), so no new one can appear; rows left behind in an
  existing database still take this branch.
* **Project Managers.** The end-user role holds no administrative authority, and
  the server refuses every two-factor endpoint for it.

**Security keys and passkeys**

Alongside the authenticator app you can register a **security key** — a YubiKey or
similar — or a **passkey** (Touch ID, Windows Hello, a phone). Either satisfies
the requirement on its own, and it is worth preferring: the key signs in only on
this site's real address, so a lookalike page cannot use it. A six-digit code can
be typed into anything that asks for one.

1. Go to **Settings → Profile** and find the **Security keys** card
2. Give the key a name you will recognise later — you will have more than one,
   and "YubiKey on my keyring" is the difference between revoking the lost one and
   the other one
3. Click **Register a security key** and follow the browser's prompt

**Register more than one.** A single key is a single point of failure, and the
recovery codes are the only other way in. Registering your first factor of either
kind — key or authenticator app — issues those codes; registering a second key
deliberately does not, so the set you already wrote down stays valid.

A key can be removed from the same card, unlike a confirmed authenticator app.
The one thing you cannot remove is the last factor on the account: the server
refuses, because an administrator with none can sign in and then do nothing.
Register the replacement first.

**Setting it up**

1. Go to **Settings → Profile** and find the **Two-factor authentication** card
2. Enter your **current password** and click **Set up two-factor authentication**
3. Scan the QR code with your authenticator app. If the camera is not an option,
   type the **setup key** in by hand instead — it is the same secret
4. Enter the six-digit code the app now shows and click **Activate**
5. **Write down the ten recovery codes.** This is the only time they are ever
   shown: they are stored hashed, so nobody — not the server, not support — can
   print them again

From the next sign-in on, the password takes you to a second screen asking for a
code. No session exists until that code is accepted.

**Recovery codes**

Each of the ten codes works exactly once, and either the authenticator or a
recovery code will get you in. Use one when your phone is lost, replaced or wiped.
The card under **Settings → Profile** shows how many are left; when the count gets
low, replace the authenticator (below) to be issued a fresh set of ten.

**Replacing the authenticator**

New phone, or a lost one:

1. Sign in — with the old authenticator if you still have it, or with a recovery
   code if you do not
2. Go to **Settings → Profile → Two-factor authentication** and click
   **Replace authenticator**
3. Enter your password **and** a current code or an unused recovery code
4. Scan the new QR code and confirm as above

The old authenticator and the old recovery codes stop working the moment the new
one is confirmed, and a fresh set of ten codes is issued. Until you confirm, the
old one keeps working — starting a replacement and walking away cannot lock you
out.

**It cannot be switched off**

There is no "disable" button and no API endpoint that removes a confirmed second
factor. This is deliberate: an attacker who reached a signed-in session or your
password should not be able to strip the protection off the account. The only way
out is to replace it, or the emergency reset below.

**Emergency reset (operator, database access required)**

If both the authenticator and all ten recovery codes are gone, the account cannot
sign in and no amount of clicking will fix it. Someone with access to the
PostgreSQL database has to clear the second factor. This is an operator
procedure, not a Root one, and every use of it should be recorded in your own
change log — it removes the protection the rest of this section exists to
provide.

Docker Compose:

```sh
docker exec -i isf-postgres psql -U postgres -d infrashelf <<'SQL'
BEGIN;
DELETE FROM user_recovery_codes
  WHERE user_id = (SELECT id FROM users WHERE email = 'root@example.com');
DELETE FROM user_totp
  WHERE user_id = (SELECT id FROM users WHERE email = 'root@example.com');
COMMIT;
SQL
```

Kubernetes:

```sh
kubectl exec -n infrashelf deploy/isf-postgres --   psql -U postgres -d infrashelf -c   "DELETE FROM user_recovery_codes WHERE user_id = (SELECT id FROM users WHERE email = 'root@example.com');    DELETE FROM user_totp WHERE user_id = (SELECT id FROM users WHERE email = 'root@example.com');"
```

Replace `root@example.com` with the account's own address. Deleting the
`user_totp` row is what turns the second factor off; deleting the recovery codes
alongside it makes sure no leftover code from the previous enrollment stays
usable. The account then signs in with its password alone, and should enroll again
immediately.

The same procedure applies to an account that was administrative when it enrolled
and has since been demoted to Project Manager. Its second factor keeps being
required at sign-in — dropping it silently would remove a protection the owner set
up and still relies on — but it can no longer be replaced through the interface,
because replacing it is an administrator operation. Either promote the account
back, or clear the row as above.

Note the other direction too: clearing the row for an account that is still Root
or Admin does not switch the second factor off. It puts the account back into
"must enrol", so the next sign-in works and nothing else does until a new
authenticator is confirmed. That is intentional — the requirement is a property of
the role, not of the row.

The same procedure is the way out if `TOTP_ENCRYPTION_KEY` is lost or rotated: the
stored secrets become unreadable, every two-factor sign-in fails closed, and the
enrollment has to be redone.
