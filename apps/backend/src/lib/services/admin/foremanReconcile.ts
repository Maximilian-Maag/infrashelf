import { db } from '@/lib/db/client'
import {
  infrastructureElements,
  pipelineStacks,
  deploymentEnvironments,
  orders,
} from '@/lib/db/schema'
import { and, eq } from 'drizzle-orm'
import { ok, err, type Result } from '@/lib/services/result'
import { resolveIntegration } from '@/lib/services/admin/integrations'
import { listForemanHosts, type ForemanHost } from '@/lib/integrations/foreman'

/**
 * What Foreman has, against what the portal ordered (#111, the Foreman item).
 *
 * Foreman knows which hosts exist; `infrastructure_elements` knows which hosts
 * were ordered. Neither answers "is what we think we provisioned actually there,
 * and is it the only thing there", and the comparison needs nothing from
 * Terraform — which is why it is worth having before, and independently of, the
 * drift sweep (#108).
 *
 * READ-ONLY and recorded nowhere. Nothing here creates, decommissions or
 * annotates an element, and no audit entry is written, because nothing changed:
 * this answers a question. Registering hosts on provisioning and removing them
 * on teardown is the other half of the Foreman item, and it waits on a decision
 * this must not pre-empt — whether Foreman provisions through its own compute
 * resources or only records what Terraform built.
 */

/** An element the portal believes in, and the host name it should be findable by. */
export interface OrderedHost {
  elementId: number
  orderId: number
  productId: number
  /** The value the order was placed with — what Foreman would have named it. */
  hostName: string
}

export interface ForemanReconciliation {
  integration: { id: number; name: string; baseUrl: string }
  environmentId: number
  checkedAt: Date
  /** Ordered and present. The uninteresting case, counted because its size is the point. */
  matched: { elementId: number; hostName: string; foremanHostId: number; status: string | null }[]
  /**
   * Ordered, and Foreman has never heard of it — the issue's "ghosts".
   *
   * Not proof that the machine is gone: a host removed from Foreman by hand
   * looks identical from here. It is the list worth looking at, not a verdict.
   */
  ghosts: OrderedHost[]
  /**
   * Present in Foreman, matching nothing the portal ordered — the issue's
   * "orphans". Reported as "unmanaged, known" rather than as a fault: an estate
   * predating the portal is full of them, and that list is itself useful (#109).
   */
  orphans: ForemanHost[]
  /**
   * Active elements carrying no host name at all, so no comparison is possible.
   *
   * Kept out of `ghosts` on purpose. "Foreman does not have this host" and "the
   * portal never recorded which host this is" are different problems with
   * different fixes, and collapsing them would put every element of a product
   * whose stack names no host parameter onto a list of things to go and look for.
   */
  unidentified: { elementId: number; orderId: number; productId: number }[]
}

/**
 * The parameter whose value names the host, per product.
 *
 * A pipeline stack may name one — `stateKeyParam`, default `hostname` — and it
 * is already what the Terraform state key is derived from, which makes it the
 * one value the portal and the machine are known to agree on. Read per
 * (product, environment), because two products in one environment may name it
 * differently and a single global guess would mismatch one of them silently.
 */
const hostParamByProduct = async (environmentId: number): Promise<Map<number, string>> => {
  const stacks = await db
    .select({ productId: pipelineStacks.productId, param: pipelineStacks.stateKeyParam })
    .from(pipelineStacks)
    .where(eq(pipelineStacks.environmentId, environmentId))

  const byProduct = new Map<number, string>()
  for (const stack of stacks) {
    // First stack wins, and a product with several is the reason this is not an
    // error: they share a state key parameter in every configuration seen so
    // far, and refusing to reconcile because a product has two stacks would
    // trade a whole report for a case that may not exist.
    if (!byProduct.has(stack.productId)) byProduct.set(stack.productId, stack.param)
  }
  return byProduct
}

/**
 * Foreman names a host by its FQDN; an order usually carries the short name.
 *
 * Compared case-insensitively and on the first label, because `web-01` and
 * `web-01.dc.example.com` are the same machine and reporting them as one ghost
 * plus one orphan is the single most likely way this report becomes noise
 * nobody reads.
 */
export const hostKey = (name: string): string => name.trim().toLowerCase().split('.')[0]

export const reconcileForemanHosts = async (
  environmentId: number,
): Promise<Result<ForemanReconciliation>> => {
  const envRows = await db
    .select({ id: deploymentEnvironments.id })
    .from(deploymentEnvironments)
    .where(eq(deploymentEnvironments.id, environmentId))
    .limit(1)
  if (!envRows.length) return err(404, 'Environment not found')

  const integration = await resolveIntegration('foreman', environmentId)
  if (!integration) {
    // 409 rather than 404: the environment exists and the request is
    // well-formed, and what is missing is configuration an admin can add. The
    // message says which of the three reasons `resolveIntegration` folds
    // together an operator should check first.
    return err(
      409,
      'No Foreman integration is available for this environment. Configure one, enable it, or check that its credential can still be decrypted.',
    )
  }

  const elements = await db
    .select({
      elementId: infrastructureElements.id,
      orderId: infrastructureElements.orderId,
      productId: infrastructureElements.productId,
      parameters: infrastructureElements.parameters,
    })
    .from(infrastructureElements)
    .innerJoin(orders, eq(infrastructureElements.orderId, orders.id))
    .where(
      and(
        eq(infrastructureElements.environmentId, environmentId),
        // Active only. An element mid-teardown SHOULD be missing from Foreman
        // shortly, and one already decommissioned is supposed to be gone — both
        // would report as ghosts for ever.
        eq(infrastructureElements.status, 'active'),
      ),
    )

  const hostParam = await hostParamByProduct(environmentId)

  const ordered: OrderedHost[] = []
  const unidentified: ForemanReconciliation['unidentified'] = []
  for (const element of elements) {
    const param = hostParam.get(element.productId) ?? 'hostname'
    const value = (element.parameters ?? {})[param]
    if (typeof value !== 'string' || value.trim() === '') {
      unidentified.push({
        elementId: element.elementId,
        orderId: element.orderId,
        productId: element.productId,
      })
      continue
    }
    ordered.push({
      elementId: element.elementId,
      orderId: element.orderId,
      productId: element.productId,
      hostName: value.trim(),
    })
  }

  const listed = await listForemanHosts(integration)
  if (!listed.ok) {
    // 502: the portal is fine and Foreman is not, and the distinction matters to
    // whoever is paged. The reason is passed through verbatim — it is the same
    // sentence `last_error` would hold.
    return err(502, `Foreman "${integration.name}" could not be read: ${listed.error}`)
  }

  const byKey = new Map<string, ForemanHost>()
  for (const host of listed.hosts) {
    // First wins: two Foreman hosts sharing a short name in one environment is a
    // real possibility across domains, and picking one arbitrarily is better
    // than letting the later overwrite the match of the earlier.
    const key = hostKey(host.name)
    if (!byKey.has(key)) byKey.set(key, host)
  }

  const matched: ForemanReconciliation['matched'] = []
  const ghosts: OrderedHost[] = []
  const claimed = new Set<number>()
  for (const element of ordered) {
    const host = byKey.get(hostKey(element.hostName))
    if (!host) {
      ghosts.push(element)
      continue
    }
    claimed.add(host.id)
    matched.push({
      elementId: element.elementId,
      hostName: element.hostName,
      foremanHostId: host.id,
      status: host.status,
    })
  }

  return ok({
    integration: { id: integration.id, name: integration.name, baseUrl: integration.baseUrl },
    environmentId,
    checkedAt: new Date(),
    matched,
    ghosts,
    orphans: listed.hosts.filter((host) => !claimed.has(host.id)),
    unidentified,
  })
}
