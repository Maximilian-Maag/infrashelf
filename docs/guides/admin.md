# Admin Guide

## Overview

As an Admin you can:
- Order infrastructure directly (no approval step required), including via a cart that checks several products out together
- Approve or reject orders from project managers
- View all projects, orders, and infrastructure elements
- Decommission infrastructure immediately or on a schedule
- View the audit log

---

## 1. Login

1. Open your browser and navigate to the webshop URL
2. Enter your **email address** and **password**
3. Click **Sign in**

> **Note:** Login attempts are rate-limited per account regardless of setup. A per-**IP** limit on top of that only applies when the deployment has opted into trusting its reverse proxy's forwarded-IP header (`TRUST_PROXY`) — ask whoever manages the deployment whether that is the case.

---

## 2. Product Catalog

### 2.1 Browsing Products

- Products are organized by category
- Prices are shown in the display currency of your browser locale
- Click the star on a product card to **favourite** it (see 2.4) — favourited products get their own row at the top of the catalog page regardless of which page of results you're on
- The detail view shows: the picture gallery, the short and long description,
  available environments with the price of each, a **Good to know** block (who owns
  the product, whether your orders need approval, a link to its documentation), a
  **Specifications** table of the parameters it takes, and the other products in the
  same category
- The gallery is operable from the keyboard: Tab reaches the thumbnails — each named
  by what it shows — the previous/next buttons and **Enlarge image**; the left and
  right arrow keys step through the pictures, and Escape closes the enlarged view

### 2.2 Ordering

There is no separate "configure" step — a product's detail page carries both quick actions and the full order form on one page:

- **Add to cart**: pick an environment and click **Add to cart** — this only asks for the environment; parameters, project, cost centre and (if offered) trial are filled in at checkout (2.3)
- **Order now**: jumps down to the **Place Order** form below, where you pick the deployment environment (e.g. "AWS Frankfurt", "On-Premises Vienna"), a project, fill in the parameters (pre-populated where defaults are defined), and — if the offering enables it — a **Try it out** checkbox with its configured duration. Assign a cost centre if the product configuration asks for one (mode depends on the product: from the project, your own selection, or a fixed overhead account shown read-only). Click **Place Order** to submit.

As an Admin, submitting either way triggers the configured CI provider's provisioning pipeline(s) **immediately** — there is no approval step, unlike for a Project Manager's order.

### 2.3 The Cart

Add one or more products (each with its environment already chosen) to the cart, then go to **Cart**:

- Fill in each item's parameters and, if it needs one, a cost centre
- Pick **one project** for the whole checkout — a cart checks out everything into the same project in one go
- Click **Check out (N)** to place all items as orders at once
- If some items fail validation, the ones that succeeded are gone from the cart and already placed as orders; the failed ones stay in the cart with an error so you can fix and retry them — checkout is not all-or-nothing
- **Empty cart** removes everything without ordering it; the ✕ on an item removes just that one
- An item whose product/environment is no longer offered is flagged and blocks checkout until removed

**Over budget at checkout.** If a cost centre's budget is set to **warn** and it
is already spent, the orders are still placed — but checkout stops on a notice
naming each order and what is committed against what limit, rather than moving
straight to the orders list. The cart is empty at that point; the notice is
information, not a failure to retry. A **block** budget refuses the order
instead, and the message says which cost centre and by how much.

### 2.4 Favourites

Click the star on any catalog card to add or remove a product from your favourites (`GET /api/favorites`; `PUT` and `DELETE` on `/api/favorites/{productId}`). Favourited products appear in a shelf at the top of the catalog page independent of pagination/filtering, so a favourite stays reachable even if it would otherwise be on a later page.

### 2.5 Reordering From a Previous Deployment

From an infrastructure element's detail page (see section 5), click **Reorder**: it opens that product's page with the element's project pre-selected and its deployment automatically picked in the order form's **Load parameters from existing deployment** dropdown, so the parameters are pre-filled. Adjust as needed and place the order — this creates a new order/infrastructure element, it does not touch the original. The same dropdown is also available by hand on any order form when you already have a project selected: pick **— start fresh —** or any of your previous deployments of that product in that project.

---

## 3. Approving Orders

Incoming orders from project managers appear under **Approvals**.

### 3.1 Approving an Order

1. Open an order under **Approvals → Open**
2. Review the order details: product, environment, parameters, project, cost center
3. Click **Approve**
4. The configured CI provider's provisioning pipeline(s) are triggered immediately (GitLab, GitHub or Bitbucket, whichever the deployment environment's CI source uses)
5. The project leader receives a confirmation email

**Over-budget orders.** If the order's cost centre has a budget and that budget
is already spent, the row says so before you decide — the cost centre, what is
committed against what limit, and which of the two behaviours root configured:

- **"approving this will be refused at the gate"** — the budget is set to
  **block**. Approving will fail; the order stays pending. Root can place an order
  against a spent block budget, and approve one too — either way it is recorded
  when they do.
- **"approving this goes through and is recorded"** — the budget is set to
  **warn**. Approving works normally and the audit log gets an
  `order.budget_warning` entry.

Rows whose budget still has room say nothing, and so do orders against a cost
centre with no budget at all. The check runs when the approval is *granted*, so
without this notice a block would only announce itself after you clicked. See
the root guide §5.1 for how budgets are set.

**The gates are asked again when you approve** (#511). Approving is a second
decision, taken later than the request: the budget may have been lowered, or a
policy added that would have refused the order. So the budget and the policy are
both asked once more at the moment of commitment, and if either refuses, the
approval is refused with the reason — the order stays **pending**, and can be
approved again once the budget is raised or the rule changed.

**Root can override either refusal from the row that showed it** (#514): the
refusal appears with a **Place anyway** control, which re-approves the order with
the waiver the refusal names — the budget or the policy, never both at once. An
approver who is not root is shown only the reason. The role is a decision about
what to display; the backend checks it again, and both waivers are recorded
(`order.budget_overridden`, `order.policy_overridden`).

The same applies when a deployment window opens: an order that waited for its
window is re-checked before it deploys, and one that no longer passes goes back
to the approvals queue rather than being built. See the root guide §5b for
policies and the `order.budget_denied` / `order.policy_denied` audit entries.

### 3.2 Rejecting an Order

1. Open an order under **Approvals → Open**
2. Click **Reject**
3. Enter a **rejection reason** — required, delivered to the project leader by email
4. Confirm

---

## 4. Tracking Order Status

Under **Orders**:

- Overview of all orders (own and others')
- Status per order: Pending Approval / Approved / Provisioning / Completed / Failed / Rejected
- The order detail page shows a **Pipeline IDs** card listing the triggered pipeline id(s) once available — plain text, not a clickable link to the CI provider
- Every order has a **comment thread** at the bottom of its detail page: anyone who can see the order can add a comment (up to 4000 characters); an Admin or Root can additionally mark a comment **Internal note** — a Project Manager viewing the same order never sees internal notes, they are filtered out by the server, not just hidden in the UI. Only the author of a comment can edit or delete it.

---

## 5. Infrastructure Overview

Under **Infrastructure**:

- All deployed infrastructure elements across all projects and environments
- Grouped by project and deployment environment
- Per element: product, parameters, status, price, cost center, order date, ordered by; a "deployment failed" note when the underlying order's status is `failed`; a "scheduled for" note once a decommission is scheduled (5.2)

The **status badge is not the stored column.** `infrastructure_elements.status`
holds only `active`, `decommissioning` and `decommissioned`, and the row is
created `active` the moment provisioning *starts* — before the pipeline has been
triggered. So the badge is derived from the element together with its order:

| Badge | When |
|---|---|
| *Provisioning* | the order is awaiting approval or its pipeline is still running |
| *Failed* | the order failed — the element is still stored `active` |
| *Active* | the order completed and the element has not been torn down |
| *Decommissioning* / *Decommissioned* | the element's own column, once the order is done with |

The status filter offers exactly these, so anything the list can show can also be
filtered for. **Decommission and Auto-decommission are offered only for *Active***
— tearing down a half-applied state is not a no-op, and there is nothing yet to
tear down while a machine is still being built.

The element's own detail page adds:
- **Outputs**: the OpenTofu outputs written after a successful apply (e.g. IP addresses, hostnames, resource IDs) — parsed from the pipeline's job trace, and only ever populated for a **GitLab**-backed deployment environment; GitHub- and Bitbucket-backed ones never get outputs here (`supportsJobTrace` in `apps/backend/src/lib/ci/index.ts`)
- **Parameters**: the values the order was placed with, with a note listing which parameter names were redacted as sensitive
- **Pipelines**: the triggered pipeline id(s) and their resolved status, plus a `trigger-failed:<n>` entry for any trigger that never even started
- Action buttons: **Reorder** (always — see 2.5), **Retry** (only on a failed deployment, Admin/Root only — re-fires the triggers; a partial retry leaves the dialog open with which ones still failed), **Automatic decommissioning** (only while `active` and not failed — opens the "Schedule decommissioning" dialog, see 5.2), **Decommission** (only while `active` and not failed)

### 5.1 Decommissioning Infrastructure

1. Open an infrastructure element and click **Decommission**
2. Confirm in the dialog — the warning says this cannot be undone
3. The destroy trigger(s) for the element's CI provider are fired
4. Status is set to **Decommissioning** and updated via the CI provider's webhook callback once the destroy pipeline finishes
5. The original orderer receives a notification upon completion

### 5.2 Scheduling a Future Decommission

Instead of (or before) decommissioning immediately, click **Automatic decommissioning** on the element's detail page:

1. Pick a future date/time and click **Confirm** — the picker will not let you choose a past time, though this is only a UI hint; the server enforces it too
2. The element shows a "scheduled for" note from then on
3. To cancel, open the same dialog and click **Clear schedule**

Setting the time only records it — nothing tears anything down without an external scheduler calling `POST /api/internal/decommission-sweep` (see the README's "Scheduled decommissioning" section). Ask Root/whoever manages the deployment whether that sweep is actually configured; if it is not, a scheduled decommission never happens on its own. A **trial** order (2.2) uses this same mechanism automatically, with the offering's configured trial duration.

---

## 6. Managing Projects

Under **Projects**:

- All projects of all users are visible
- Create new projects (name, description, cost center)
- Edit existing projects
- Change the cost center of a project

### 6.1 Deleting a Project

1. Open the project under **Projects**
2. Click **Delete**
3. Confirm in the dialog

> **Important:** Before the project record is removed, the webshop automatically fires the CI destroy trigger(s) for every active infrastructure element belonging to the project (status transitions to *Decommissioning*). The database records are removed after the triggers have fired. Infrastructure that is already in status *Decommissioning* or *Decommissioned* is skipped.

---

## 7. Audit Log

Under **Audit Log**:

- Compliance record: orders, approvals, rejections, deployments, decommissions, cart checkouts, order comments and product-version records. **Configuration changes are audited too** — saving SMTP or AI settings writes `config.smtp_updated` / `config.ai_updated`, and branding writes `branding.updated` / `branding.logo_updated`. This page used to say the opposite; #137 fixed it and the sentence was not updated.
- Filterable by user, action type, and date range (from/to) — there is no project filter
- Export as **CSV** or **PDF**

---

## 8. Email Notifications

As an Admin you automatically receive emails for:

| Event | Description |
|-------|-------------|
| New order (from a Project Manager) | Approval request naming the orderer, product and order number — asks you to log in to review it; the email itself carries no link |
| Deployment failed | A generic notice naming the order and product ("Please contact your administrator") — no pipeline id or error detail is included in the email; check the order or infrastructure detail page for that |
| New comment on an order you can see | Sent to you and the orderer, with the comment's author and an excerpt (truncated at 500 characters). Not sent for **internal** notes, and never sent to the comment's own author. |

None of the portal's emails contain a clickable link back to the order, pipeline, or infrastructure element — you always have to open the app and find the item yourself.

---

## 9. Settings / Profile

Under **Settings → Profile** (`/settings/profile`):

### 9.1 Password Change

1. Enter your **current password**
2. Enter a **new password** (minimum 8 characters)
3. Confirm the new password — both fields must match
4. Click **Save**

### 9.2 Language

Use the language selector in the navigation bar to change the UI language. The selected language is stored in your session and applied to all UI texts. Product content is loaded in the selected language when a translation is available.
