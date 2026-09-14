import zlib from 'node:zlib'
import { randomBytes } from 'node:crypto'
import { db } from '@/lib/db/client'
import {
  categories,
  ciSources,
  costCenters,
  deploymentEnvironments,
  infrastructureElements,
  orders,
  parameters,
  productEnvironments,
  productImages,
  pipelineStacks,
  productTranslations,
  products,
  projects,
  users,
} from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { isLoopback } from '@/lib/ci/transport'
import { encryptSecret, isSecretEncryptionConfigured, secretEncryptionUnavailableReason } from '@/lib/crypto/secrets'

/**
 * A small, deterministic catalogue for a development database.
 *
 * The reason this exists: an empty database makes the portal impossible to look at
 * and, worse, quietly weakens what the test suites prove. Several e2e specs only
 * ever passed *because* nothing was there — `expect(links.or(empty)).toBeVisible()`
 * is a strict-mode violation as soon as a second product exists — and the axe gate
 * cannot see a contrast failure on a page whose content never renders. Issue #89.
 *
 * Idempotent: everything hangs off the marker category, and the whole thing is
 * skipped when that already exists. Nothing here touches a row it did not create,
 * so it is safe to run against a database that already has real data.
 */
const MARKER_CATEGORY = 'Demo — Compute'

/**
 * A credential nobody can guess, for data nobody should be able to use.
 *
 * These used to be the literals `demo-token` and `demo-callback-1`. That is a
 * live, guessable callback secret the moment this runs anywhere real — and a
 * pipeline callback authenticated by a secret an attacker can type is a pipeline
 * callback an attacker can forge (#147). Generated, so the worst case of the
 * seed running where it should not is dead demo rows rather than a way in.
 */
const demoSecret = (): string => randomBytes(24).toString('base64url')

/**
 * Refuse to seed a production database.
 *
 * The guard used to be the marker category alone, which answers "has this run
 * before" and not "should it run at all". `NODE_ENV` answers the second, and the
 * escape hatch is explicit rather than absent: an operator who genuinely wants
 * demo rows in a production-mode database has to say so in a variable named
 * after what it does.
 */
const refusedByEnvironment = (): boolean => {
  if (process.env.NODE_ENV !== 'production') return false
  if (process.env.ALLOW_DEMO_SEED_IN_PRODUCTION === '1') {
    console.warn('[demo] NODE_ENV=production, seeding anyway because ALLOW_DEMO_SEED_IN_PRODUCTION=1.')
    return false
  }
  console.error(
    '[demo] Refusing to seed demo data with NODE_ENV=production. ' +
      'It writes a catalogue, a CI source and two environments that are not real. ' +
      'Set ALLOW_DEMO_SEED_IN_PRODUCTION=1 if that is genuinely what you want.',
  )
  return true
}

/**
 * The GitLab the demo data points at.
 *
 * `gitlab.example.invalid` by default, and `.invalid` is reserved by RFC 2606
 * precisely so it can never resolve — a developer's demo catalogue must not be
 * able to reach a real CI system by accident.
 *
 * `DEMO_CI_URL` points it somewhere that will answer. The e2e job sets it to
 * the WireMock in `infra/wiremock/mappings`, whose twelve stubs already model
 * the whole GitLab side of a provisioning run: the trigger returns pipeline 42,
 * its bridges lead to child pipeline 43, and 43's apply job has a trace with
 * Terraform outputs in it. Until now nothing in CI ever spoke to them (#157).
 *
 * Checked before anything is seeded against it. The seeded stack holds a
 * trigger token, and provisioning sends that token to this host the moment an
 * order is placed — over plaintext http to anywhere but loopback that is a
 * credential on the wire, so it is refused here rather than at the point the
 * token leaves. A seed that cannot be used safely should not be written.
 *
 * Loopback stays http on purpose: that WireMock speaks http on :8080.
 */
const ciUrl = (): string => {
  const raw = process.env.DEMO_CI_URL?.trim()
  if (!raw) return 'https://gitlab.example.invalid'

  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error(`[demo] DEMO_CI_URL is not a URL: ${raw}`)
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`[demo] DEMO_CI_URL must be http or https, not ${parsed.protocol}`)
  }
  if (parsed.protocol === 'http:' && !isLoopback(parsed.hostname)) {
    throw new Error(
      `[demo] DEMO_CI_URL is plaintext http to ${parsed.hostname}. The seeded stack's ` +
        'trigger token would go out over that connection. Use https, or point it at loopback.',
    )
  }
  return raw
}

/**
 * Whether the demo should seed a pipeline stack.
 *
 * A stack is what makes a product PROVISIONABLE, and provisioning fires a
 * trigger the moment an order is placed. Against `.invalid` that trigger fails
 * and the order is refused — so seeding one unconditionally would break
 * ordering for every developer running `make db-seed-demo`, which is why there
 * has never been one and why seven e2e tests skip for want of it.
 *
 * Tied to `DEMO_CI_URL` rather than to a flag of its own: "somebody has pointed
 * this at a CI system that will answer" is exactly the condition under which a
 * stack is useful, and one switch cannot be set half way.
 */
const seedsPipelineStack = (): boolean => Boolean(process.env.DEMO_CI_URL?.trim())

/** A small PNG, generated rather than committed as a binary blob. */
const gradientPng = (hue: 'blue' | 'green' | 'amber'): Buffer => {
  const size = 160
  const tint = { blue: [40, 90, 200], green: [30, 160, 120], amber: [220, 150, 30] }[hue]
  const chunk = (tag: string, data: Buffer): Buffer => {
    const head = Buffer.alloc(4)
    head.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(tag, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(zlib.crc32 ? zlib.crc32(body) : crc32(body))
    return Buffer.concat([head, body, crc])
  }
  const rows: Buffer[] = []
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(size * 3 + 1)
    for (let x = 0; x < size; x++) {
      row[1 + x * 3] = Math.round((tint[0] * (x + 1)) / size)
      row[2 + x * 3] = Math.round((tint[1] * (y + 1)) / size)
      row[3 + x * 3] = tint[2]
    }
    rows.push(row)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows), { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** CRC-32, for Node versions without zlib.crc32. */
const crc32 = (buf: Buffer): number => {
  let crc = 0xffffffff
  for (const byte of buf) {
    crc ^= byte
    for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
  }
  return (crc ^ 0xffffffff) >>> 0
}

interface DemoProduct {
  name: string
  description: string
  germanName: string
  germanDescription: string
  /** Two, so the dev database actually exercises the gallery and its thumbnails. */
  images: { hue: 'blue' | 'green' | 'amber'; alt: string }[]
  longDescription: string
  owner: string
  docsUrl: string
  price: string
}

const CATALOGUE: DemoProduct[] = [
  {
    name: 'Managed Nginx Gateway',
    description:
      'A reverse proxy with TLS termination, WAF rules and per-project rate limiting. Provisioned into the environment you choose.',
    germanName: 'Managed Nginx Gateway',
    germanDescription:
      'Ein Reverse Proxy mit TLS-Terminierung, WAF-Regeln und projektbezogenem Rate Limiting.',
    images: [
      { hue: 'blue', alt: 'Abstract blue gradient standing in for a gateway product photo' },
      { hue: 'green', alt: 'Abstract green gradient standing in for a screenshot of the gateway dashboard' },
    ],
    longDescription:
      'The gateway terminates TLS at the edge of the environment you pick, applies the OWASP core rule set, ' +
      'and rate-limits per project so one noisy service cannot exhaust another\'s budget. Certificates are ' +
      'issued and renewed for you. Every request is logged to the environment\'s log sink, and the access ' +
      'logs are queryable for 30 days.',
    owner: 'Platform Networking',
    docsUrl: 'https://example.internal/docs/managed-nginx-gateway',
    price: '120.00',
  },
  {
    name: 'Postgres Cluster',
    description: 'A highly available Postgres cluster with automated backups and point-in-time recovery.',
    germanName: 'Postgres-Cluster',
    germanDescription: 'Ein hochverfügbarer Postgres-Cluster mit automatischen Backups.',
    images: [
      { hue: 'green', alt: 'Abstract green gradient standing in for a database product photo' },
      { hue: 'blue', alt: 'Abstract blue gradient standing in for a diagram of the cluster topology' },
    ],
    longDescription:
      'Three nodes with synchronous replication and automatic failover, backed up nightly to object storage ' +
      'with write-ahead log shipping in between, so recovery to any point in the last seven days is a ' +
      'request rather than a project. Connections arrive through a pooler, and the cluster is monitored ' +
      'with alerting on replication lag and disk headroom.',
    owner: 'Data Platform',
    docsUrl: 'https://example.internal/docs/postgres-cluster',
    price: '340.00',
  },
  {
    name: 'Kubernetes Cluster',
    description: 'A managed Kubernetes cluster with an autoscaling node pool and cluster-wide monitoring.',
    germanName: 'Kubernetes-Cluster',
    germanDescription: 'Ein gemanagter Kubernetes-Cluster mit automatisch skalierendem Node-Pool.',
    images: [
      { hue: 'amber', alt: 'Abstract amber gradient standing in for a Kubernetes product photo' },
      { hue: 'blue', alt: 'Abstract blue gradient standing in for the cluster monitoring dashboard' },
    ],
    longDescription:
      'A managed control plane with a node pool that scales on pending pods, ingress and cert-manager ' +
      'pre-installed, and cluster-wide metrics and logs shipped to the environment\'s observability stack. ' +
      'You get a kubeconfig scoped to your project namespace; upgrades are applied in a maintenance window ' +
      'you choose.',
    owner: 'Container Platform',
    docsUrl: 'https://example.internal/docs/kubernetes-cluster',
    price: '890.00',
  },
]

export const seedDemoData = async (): Promise<{ created: boolean }> => {
  // Validated before the transaction opens: a DEMO_CI_URL that cannot be used
  // safely should stop the seed, not leave half a catalogue behind.
  const ciBaseUrl = ciUrl()

  if (refusedByEnvironment()) return { created: false }

  /*
   * Nowhere safe to put the demo CI token, so do not create one (#111).
   *
   * Before the transaction and beside the URL check above, for the same reason:
   * a seed that cannot finish safely should not start. Throwing rather than
   * returning `{ created: false }` — that value means "already present, nothing
   * to do", and a misconfigured deployment silently reporting success is how a
   * demo catalogue goes missing with nothing saying why.
   */
  if (!isSecretEncryptionConfigured()) {
    throw new Error(
      `Cannot seed demo data: ${secretEncryptionUnavailableReason()} ` +
        'The demo CI source carries an access token, and SECRET_ENCRYPTION_KEY ' +
        'is where it gets encrypted: 64 hex characters (openssl rand -hex 32).',
    )
  }

  // One transaction around the marker lookup AND every write. Without it a
  // failure halfway through left the marker category behind, so the next run
  // found it, reported "already present" and skipped a dataset that had never
  // been finished — the failure mode is a half-seeded database that looks done.
  return db.transaction(async (tx) => {
    const existing = await tx
      .select({ id: categories.id })
      .from(categories)
      .where(eq(categories.name, MARKER_CATEGORY))
      .limit(1)

    if (existing.length > 0) {
      console.warn('[demo] Demo data already present — nothing to do.')
      return { created: false }
    }

    const [root] = await tx.select({ id: users.id }).from(users).where(eq(users.role, 'root')).limit(1)
    if (!root) {
      console.error('[demo] No root user yet. Run `make db-seed` first.')
      return { created: false }
    }

    const [category] = await tx.insert(categories).values({ name: MARKER_CATEGORY }).returning()
    const [ci] = await tx
      .insert(ciSources)
      // Encrypted like any other, so the demo catalogue does not reintroduce the
      // plaintext column #111 removed. Guarded by the caller: `seedDemo` refuses
      // to run when there is nowhere safe to put it.
      .values({ name: 'Demo GitLab', url: ciBaseUrl, accessToken: encryptSecret(demoSecret()), provider: 'gitlab' })
      .returning()

    const [frankfurt] = await tx
      .insert(deploymentEnvironments)
      .values({
        name: 'AWS Frankfurt',
        description: 'Public cloud, eu-central-1',
        ciSourceId: ci.id,
        webhookUrl: `${ciBaseUrl}/api/v4/projects/1/trigger/pipeline`,
        webhookToken: 'demo-trigger-1',
        callbackSecret: demoSecret(),
      })
      .returning()

    const [onPrem] = await tx
      .insert(deploymentEnvironments)
      .values({
        name: 'On-Premise Vienna',
        description: 'vSphere cluster in the Vienna datacentre',
        ciSourceId: ci.id,
        webhookUrl: `${ciBaseUrl}/api/v4/projects/2/trigger/pipeline`,
        webhookToken: 'demo-trigger-2',
        callbackSecret: demoSecret(),
      })
      .returning()

    const [platformCc] = await tx
      .insert(costCenters)
      .values({ code: 'CC-100', name: 'Platform Operations' })
      .returning()
    await tx.insert(costCenters).values({ code: 'CC-200', name: 'Data Services' })

    const [webshop] = await tx
      .insert(projects)
      .values({ name: 'Webshop Platform', description: 'Customer-facing shop', ownerId: root.id, costCenterId: platformCc.id })
      .returning()

    const created: { id: number; name: string }[] = []
    for (const item of CATALOGUE) {
      const [product] = await tx
        .insert(products)
        .values({
          categoryId: category.id,
          baseLanguage: 'en',
          owner: item.owner,
          docsUrl: item.docsUrl,
        })
        .returning()

      // The pictures live in their own table since 0021, so the seed writes a
      // gallery rather than one column — which is also what gives the a11y gate on
      // /catalog/{id} a thumbnail strip to scan.
      await tx.insert(productImages).values(
        item.images.map((image, position) => ({
          productId: product.id,
          position,
          data: gradientPng(image.hue),
          mime: 'image/png',
          alt: image.alt,
        })),
      )

      await tx.insert(productTranslations).values([
        {
          productId: product.id,
          languageCode: 'en',
          name: item.name,
          description: item.description,
          longDescription: item.longDescription,
        },
        {
          productId: product.id,
          languageCode: 'de',
          name: item.germanName,
          description: item.germanDescription,
          // Left empty on purpose: an untranslated long text falls back to English
          // in getProduct, and inventing German prose here would hide that.
          longDescription: '',
        },
      ])

      // Two environments at different prices, so the cheapest-offer logic on the
      // product page and the per-environment breakdown in the cost report have
      // something to show.
      await tx.insert(productEnvironments).values([
        { productId: product.id, environmentId: frankfurt.id, price: item.price, currency: 'EUR' },
        {
          productId: product.id,
          environmentId: onPrem.id,
          price: (Number(item.price) * 1.4).toFixed(2),
          currency: 'EUR',
        },
      ])

      created.push({ id: product.id, name: item.name })
    }

    // One sensitive parameter, because redaction in the export and on the detail
    // page is only exercised when one exists.
    await tx.insert(parameters).values([
      {
        scope: 'product',
        scopeId: created[0].id,
        name: 'hostname',
        label: 'Hostname',
        type: 'string',
        description: 'DNS name for the gateway',
        required: true,
      },
      {
        scope: 'product',
        scopeId: created[0].id,
        name: 'admin_password',
        label: 'Admin password',
        type: 'string',
        description: 'Initial administrator password',
        required: true,
        sensitive: true,
      },
    ])

    /*
     * A pipeline stack for the first product, when something can answer it.
     *
     * This is what makes a product provisionable, and its absence is the single
     * cause of seven skipped e2e tests: no stack means no order can be placed,
     * and with no order there is no approval to act on, no cart item to keep,
     * and no element mid-provisioning (#296).
     *
     * One step, and it matches the WireMock stubs exactly — `linode/virtual-
     * machine` is the template the entry pipeline's dispatch bridge is named
     * for. A second step would need a second trigger response and there is one
     * stub for POST.
     *
     * `hostname` as the state key because it is the first product's required
     * parameter, so every order carries one.
     */
    if (seedsPipelineStack()) {
      await tx.insert(pipelineStacks).values({
        productId: created[0].id,
        environmentId: frankfurt.id,
        name: 'Gateway VM',
        stateKeyParam: 'hostname',
        steps: [{ template: 'linode/virtual-machine', stateSuffix: 'vm', execOrder: 0 }],
      })
    }

    // Orders across the states the UI renders differently: a completed one with
    // infrastructure, one still waiting for approval, and a failed deployment —
    // which is an ACTIVE element whose order failed, the case #29's Retry keys off.
    const [completed] = await tx
      .insert(orders)
      .values({
        projectId: webshop.id,
        productId: created[0].id,
        environmentId: frankfurt.id,
        userId: root.id,
        status: 'completed',
        costCenterId: platformCc.id,
        parameters: { hostname: 'gateway-01', admin_password: 'demo-only' },
      })
      .returning()

    await tx.insert(orders).values({
      projectId: webshop.id,
      productId: created[1].id,
      environmentId: onPrem.id,
      userId: root.id,
      status: 'pending',
      costCenterId: platformCc.id,
      parameters: {},
    })

    const [failed] = await tx
      .insert(orders)
      .values({
        projectId: webshop.id,
        productId: created[2].id,
        environmentId: frankfurt.id,
        userId: root.id,
        status: 'failed',
        costCenterId: platformCc.id,
        parameters: {},
      })
      .returning()

    await tx.insert(infrastructureElements).values([
      {
        orderId: completed.id,
        projectId: webshop.id,
        environmentId: frankfurt.id,
        productId: created[0].id,
        status: 'active',
        parameters: { hostname: 'gateway-01', admin_password: 'demo-only' },
        outputs: { ip_address: '203.0.113.10', hostname: 'gateway-01' },
        deployedAt: new Date(),
      },
      {
        orderId: failed.id,
        projectId: webshop.id,
        environmentId: frankfurt.id,
        productId: created[2].id,
        status: 'active',
        // Parameters even though the deployment failed: reprovisioning is exactly
        // when the original values matter, and an element without any cannot show
        // the quick-reorder prefill at all.
        parameters: { hostname: 'k8s-prod-01' },
        outputs: {},
        deployedAt: new Date(),
      },
    ])

    console.warn(
      `[demo] Created ${created.length} products, 2 environments, 1 project, 2 cost centres, 3 orders and 2 infrastructure elements.`,
    )
    return { created: true }
  })
}
