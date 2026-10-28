import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, it, expect, vi, beforeAll } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { axe } from 'vitest-axe'
import type { AxeResults } from 'axe-core'
import Link from 'next/link'
import type { Parameter, SessionInfo } from '@infrashelf/types'
import { Alert } from './ui/Alert'
import { Button, ButtonLink } from './ui/Button'
import { Card } from './ui/Card'
import { Input } from './ui/Input'
import { Modal } from './ui/Modal'
import { ProductImage } from './ui/ProductImage'
import { Select } from './ui/Select'
import { SkeletonCard, SkeletonListItem, SkeletonRow, LoadingRegion } from './ui/Skeleton'
import { StatusBadge } from './ui/StatusBadge'
import { Table } from './ui/Table'
// Not primitives, but the same argument applies: a chart is drawn markup, and the
// page-level gate only catches it in whatever state that page happens to render.
import { CostTrend } from '@/app/(dashboard)/costs/CostTrend'
import { CostDistribution } from '@/app/(dashboard)/costs/CostDistribution'
import { CostComparison } from '@/app/(dashboard)/costs/CostComparison'
import { ToastProvider, useToast } from './ui/Toast'
import { TrialBadge } from './ui/TrialBadge'
import { Breadcrumbs } from './layout/Breadcrumbs'
import { PageHeader } from './layout/PageHeader'
import { ParameterFields } from './forms/ParameterFields'
import { FavoriteButton } from '@/app/(dashboard)/catalog/FavoriteButton'
import { DelegationPanel } from '@/app/(dashboard)/approvals/DelegationPanel'
import { ActiveSessions } from './forms/ActiveSessions'
import userEvent from '@testing-library/user-event'
import { ProductGallery } from './ui/ProductGallery'
import { ProductSpecs } from './ui/ProductSpecs'
import { SizeSwatches } from './forms/SizeSwatches'

/**
 * Component-level accessibility checks (issue #102).
 *
 * The e2e gate scans pages, which means a component is only checked if some page
 * in that list happens to render it in the state that would fail. That is how the
 * dialogs went unchecked until they were added by hand, and it is why a
 * regression in a primitive can reach main: nothing here ran axe at all.
 *
 * These are cheap — no browser, no server — and they check the state, not the
 * page: a select with an error, a modal that is open, a button that is only text.
 *
 * What jsdom cannot do is `color-contrast`, which needs real layout; axe reports
 * it as "incomplete" rather than a violation, and the e2e gate is where contrast
 * is actually enforced. Everything structural — labelling, roles, name
 * computation, aria references — is exactly what this catches.
 */

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }))
vi.mock('@/lib/api', () => ({ post: vi.fn(), del: vi.fn() }))

// jsdom does not implement the native <dialog> methods.
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
    this.open = true
  })
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
    this.open = false
  })
})

/**
 * Axe over a rendered component.
 *
 * Landmark and region rules are switched off: they are properties of a page, and
 * a component rendered on its own is "not in a landmark" by construction. Leaving
 * them on would report the same non-finding for every component here and train
 * the reader to ignore the output.
 */
const RULES = {
  region: { enabled: false },
  'landmark-one-main': { enabled: false },
  'page-has-heading-one': { enabled: false },
  // Needs real layout and a canvas, neither of which jsdom has — it would
  // report "incomplete" and log a getContext warning per run. Contrast is
  // enforced in the e2e gate, against a real browser and the real palette.
  'color-contrast': { enabled: false },
}

/** Axe over an already-rendered container, for components that need a click first. */
const axeOn = async (container: Element): Promise<AxeResults> =>
  (await axe(container, { rules: RULES })) as AxeResults

const check = async (ui: React.ReactElement): Promise<AxeResults> => axeOn(render(ui).container)

describe('the check itself', () => {
  it('reports a violation when there is one', async () => {
    // Without this the suite is a rubber stamp: `toHaveNoViolations` passes on a
    // matcher that was never registered, which is exactly what happened while
    // this was being written (vitest-axe's extend-expect entry point is empty).
    const results = await check(<input type="text" />)
    expect(results.violations.length).toBeGreaterThan(0)
    expect(results.violations.map((v) => v.id)).toContain('label')
  })
})

describe('Alert', () => {
  it('is accessible in every tone', async () => {
    for (const tone of ['error', 'success', 'warning', 'info'] as const) {
      expect(await check(<Alert tone={tone}>Something happened</Alert>)).toHaveNoViolations()
    }
  })
})

describe('Button', () => {
  it('is accessible in every variant', async () => {
    for (const variant of ['primary', 'secondary', 'danger', 'ghost'] as const) {
      expect(await check(<Button variant={variant}>Save</Button>)).toHaveNoViolations()
    }
  })

  it('has an accessible name when it is icon-only', async () => {
    // An icon-only control with no name is the classic failure, and #99 was a
    // near miss of the same kind.
    expect(
      await check(
        <Button aria-label="Remove from favorites">
          <svg aria-hidden="true" viewBox="0 0 24 24" />
        </Button>,
      ),
    ).toHaveNoViolations()
  })

  it('is accessible while disabled and busy', async () => {
    expect(await check(<Button disabled>Saving…</Button>)).toHaveNoViolations()
  })
})

/**
 * `ButtonLink`, and the shape it exists to replace (issue #102 review).
 *
 * `<Link><Button/></Link>` renders `<a><button>`. That is invalid HTML — an `<a>`
 * may not contain interactive content — and it splits one control in two: the
 * button takes the pointer while the link keeps the keyboard, so clicking and
 * pressing Enter do different things.
 *
 * What it is NOT is an axe finding, which is the reason it kept coming back.
 * `nested-interactive` only matches roles whose children are presentational, and
 * `link` is not one of those (measured against axe-core 4.13.0 — the test below
 * pins it), so neither this suite nor the e2e gate ever objected. It was fixed by
 * hand on the infrastructure detail page, came back at six more call sites, and
 * nothing failed. Hence the source scan at the bottom: it is the only check here
 * that would have caught them.
 */
describe('ButtonLink', () => {
  it('renders an <a> with the button paint, in every variant', async () => {
    for (const variant of ['primary', 'secondary', 'danger', 'ghost'] as const) {
      const { container, unmount } = render(
        <ButtonLink href="/admin/products/1" variant={variant}>Edit</ButtonLink>,
      )
      expect(await axeOn(container), variant).toHaveNoViolations()
      expect(screen.getByRole('link', { name: 'Edit' }).tagName).toBe('A')
      // The whole point: one control, nothing interactive inside it.
      expect(container.querySelector('a button')).toBeNull()
      unmount()
    }
  })

  it('is not something axe can catch, which is why the guard below exists', async () => {
    // The measurement, not an assumption. If a future axe release starts
    // reporting the wrap, this fails and the source scan can be reconsidered —
    // and until then nobody should write "the axe gate rejects this" again.
    const results = await check(
      <Link href="/admin/products/1">
        <Button size="sm" variant="secondary">Edit</Button>
      </Link>,
    )
    expect(results.violations.map((v) => v.id)).not.toContain('nested-interactive')
  })

  it('is the only way the app styles a link as a button', () => {
    expect(linkWrappedButtons()).toEqual([])
  })
})

const SRC_DIR = join(process.cwd(), 'src')

/**
 * Every source file containing `<Link …>…<Button`, comments not counted.
 *
 * Crude on purpose: it is a text scan, so it cannot see through an alias or a
 * component that wraps `Link` itself. It catches the shape people actually
 * write, which is the one that recurred six times.
 */
function linkWrappedButtons(): string[] {
  const found: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.tsx') && !entry.name.endsWith('.test.tsx')) {
        // Table's doc comment names both components in one sentence, and the
        // negative control above is a deliberate one — hence the two exclusions.
        const source = readFileSync(full, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/^\s*\/\/.*$/gm, '')
        if (/<Link\b[^>]*>(?:(?!<\/Link>)[\s\S])*?<Button\b/.test(source)) {
          found.push(relative(SRC_DIR, full))
        }
      }
    }
  }
  walk(SRC_DIR)
  return found
}

describe('Input', () => {
  it('is accessible with a label alone', async () => {
    expect(await check(<Input label="Hostname" />)).toHaveNoViolations()
  })

  it('is accessible with a hint and with an error', async () => {
    expect(await check(<Input label="Hostname" hint="Sent as TF_VAR_hostname" />)).toHaveNoViolations()
    expect(await check(<Input label="Hostname" error="Required" required />)).toHaveNoViolations()
  })
})

describe('Select', () => {
  const options = [
    { value: 'aws', label: 'AWS Frankfurt' },
    { value: 'vsphere', label: 'On-Premise Vienna' },
  ]

  it('is accessible with options alone', async () => {
    expect(await check(<Select label="Environment" options={options} />)).toHaveNoViolations()
  })

  it('is accessible with a placeholder', async () => {
    // The placeholder is a disabled option, which is the shape that has caught
    // people out before — worth asserting it is not also an a11y problem.
    expect(
      await check(<Select label="Environment" options={options} placeholder="Choose one" />),
    ).toHaveNoViolations()
  })

  it('is accessible with an error and with a hint', async () => {
    expect(await check(<Select label="Environment" options={options} error="Pick one" />)).toHaveNoViolations()
    expect(await check(<Select label="Environment" options={options} hint="Where it runs" />)).toHaveNoViolations()
  })
})

describe('Modal', () => {
  it('is accessible when open with a title', async () => {
    expect(
      await check(
        <Modal open onClose={() => {}} title="Confirm delete">
          <p>This cannot be undone.</p>
        </Modal>,
      ),
    ).toHaveNoViolations()
  })

  it('is accessible when named by aria-label instead of a visible title', async () => {
    expect(
      await check(
        <Modal open onClose={() => {}} ariaLabel="Edit product">
          <Input label="Name" />
        </Modal>,
      ),
    ).toHaveNoViolations()
  })
})

describe('Card', () => {
  it('is accessible with a title and an action', async () => {
    expect(
      await check(
        <Card title="Cost centres" action={<Button>Add</Button>}>
          <p>Body</p>
        </Card>,
      ),
    ).toHaveNoViolations()
  })
})

describe('StatusBadge', () => {
  it('is accessible for every status it renders', async () => {
    for (const status of ['pending', 'provisioning', 'completed', 'failed', 'active', 'decommissioned'] as const) {
      expect(await check(<StatusBadge status={status} />)).toHaveNoViolations()
    }
  })
})

describe('Table', () => {
  type Row = { id: number; name: string }
  const columns = [
    { header: 'Name', accessor: 'name' as const },
    { header: 'Actions', render: (row: Row) => <Button aria-label={`Edit ${row.name}`}>Edit</Button> },
  ]

  it('is accessible with rows', async () => {
    expect(
      await check(<Table columns={columns} data={[{ id: 1, name: 'web-01' }]} emptyMessage="Nothing yet" />),
    ).toHaveNoViolations()
  })

  it('is accessible when empty', async () => {
    expect(
      await check(<Table columns={columns} data={[]} emptyMessage="Nothing yet" />),
    ).toHaveNoViolations()
  })
})

/**
 * The cost charts (issue #106).
 *
 * An SVG is the easiest thing in this app to render inaccessibly: a picture with no
 * name, encoding everything by colour, with the numbers nowhere but the shapes. The
 * checks below are the three that would catch that — the chart has a name, the data
 * is present as text, and axe finds nothing structural — and they run against the
 * empty, single-period and folded-tail states, because those take different paths.
 *
 * Contrast is not checked here (jsdom has no layout, and the fills come from CSS
 * variables the dashboard layout sets). The ramp's 3:1 floor is asserted directly in
 * lib/contrast.test.ts, and the painted result in the e2e axe gate.
 */
const money = (eur: number) => `${eur.toFixed(2)} EUR`
const period = (p: string, totalBase: number, partial = false) => ({
  period: p,
  totalBase,
  orderCount: 1,
  estimatedOrders: 0,
  partial,
})
const bucket = (id: number, label: string, totalBase: number) => ({
  id,
  label,
  totalBase,
  orderCount: 1,
})

describe('CostTrend', () => {
  const series = [period('2026-06', 120), period('2026-07', 0), period('2026-08', 90, true)]

  it('is accessible with a series', async () => {
    expect(
      await check(
        <CostTrend series={series} money={money} lang="en" estimatedOrders={0} unconverted={[]} />,
      ),
    ).toHaveNoViolations()
  })

  it('is accessible with the caveats attached and an empty series', async () => {
    expect(
      await check(
        <CostTrend
          series={[]}
          money={money}
          lang="en"
          estimatedOrders={3}
          unconverted={[{ currency: 'JPY', amount: 100 }]}
        />,
      ),
    ).toHaveNoViolations()
  })

  it('gives the picture an accessible name', async () => {
    // Without one the chart is an unlabelled graphic — the svg-img-alt failure.
    render(<CostTrend series={series} money={money} lang="en" estimatedOrders={0} unconverted={[]} />)
    expect(screen.getByRole('img', { name: /spend over time/i })).toBeTruthy()
  })
})

describe('CostDistribution', () => {
  const buckets = [bucket(1, 'Webshop', 60), bucket(2, 'Intranet', 40)]

  it('is accessible with a share bar and legend', async () => {
    expect(
      await check(
        <CostDistribution
          chartId="a11y-share"
          dimension="Per project"
          buckets={buckets}
          money={money}
          lang="en"
          estimatedOrders={0}
          unconverted={[]}
        />,
      ),
    ).toHaveNoViolations()
  })

  it('is accessible when the tail is folded into Other', async () => {
    const many = Array.from({ length: 12 }, (_, i) => bucket(i + 1, `Project ${i + 1}`, 12 - i))
    expect(
      await check(
        <CostDistribution
          chartId="a11y-share-many"
          dimension="Per project"
          buckets={many}
          money={money}
          lang="en"
          estimatedOrders={1}
          unconverted={[]}
        />,
      ),
    ).toHaveNoViolations()
  })

  it('is accessible with nothing to show', async () => {
    expect(
      await check(
        <CostDistribution
          chartId="a11y-share-empty"
          dimension="Per project"
          buckets={[]}
          money={money}
          lang="en"
          estimatedOrders={0}
          unconverted={[]}
        />,
      ),
    ).toHaveNoViolations()
  })
})

describe('CostComparison', () => {
  const comparison = {
    previous: period('2026-07', 40),
    current: period('2026-08', 50, true),
    changeBase: 10,
    changePct: 25,
  }

  it('is accessible with a comparison', async () => {
    expect(
      await check(
        <CostComparison
          comparison={comparison}
          money={money}
          lang="en"
          estimatedOrders={0}
          unconverted={[]}
        />,
      ),
    ).toHaveNoViolations()
  })

  it('is accessible when the window is too short to compare', async () => {
    expect(
      await check(
        <CostComparison
          comparison={null}
          money={money}
          lang="en"
          estimatedOrders={0}
          unconverted={[]}
        />,
      ),
    ).toHaveNoViolations()
  })
})

/**
 * Approval delegation (issue #35).
 *
 * Not a `ui/` primitive, but it is a form the e2e gate only ever sees in its
 * empty state — the "you are approving on behalf of X" banner and the granted
 * list only appear when there are delegations, and no seeded dev database has
 * any. Both states are checked here instead.
 */
describe('DelegationPanel', () => {
  const candidates = [{ id: 2, name: 'Bob Admin', email: 'bob@test.dev' }]
  const delegation = {
    id: 5,
    fromUserId: 1,
    fromUserName: 'Alice Admin',
    fromUserEmail: 'alice@test.dev',
    toUserId: 2,
    toUserName: 'Bob Admin',
    toUserEmail: 'bob@test.dev',
    startsOn: '2026-09-01',
    endsOn: '2026-09-14',
    createdAt: '2026-08-20T10:00:00.000Z',
    revokedAt: null,
    active: true,
  }

  it('is accessible as the empty create form', async () => {
    expect(
      await check(
        <DelegationPanel
          delegations={{ mine: [], grantedToMe: [], candidates }}
         
        />,
      ),
    ).toHaveNoViolations()
  })

  it('is accessible while announcing a held authority and listing a granted one', async () => {
    expect(
      await check(
        <DelegationPanel
          delegations={{ mine: [delegation], grantedToMe: [delegation], candidates }}
         
        />,
      ),
    ).toHaveNoViolations()
  })

  it('is accessible when there is nobody to nominate', async () => {
    expect(
      await check(
        <DelegationPanel delegations={{ mine: [], grantedToMe: [], candidates: [] }} />,
      ),
    ).toHaveNoViolations()
  })
})

describe('ActiveSessions', () => {
  const session = (over: Partial<SessionInfo>): SessionInfo => ({
    id: 1,
    userId: 1,
    ip: '203.0.113.7',
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/140.0',
    createdAt: '2026-08-20T09:00:00.000Z',
    lastSeenAt: '2026-08-21T11:30:00.000Z',
    expiresAt: '2026-08-21T17:00:00.000Z',
    current: false,
    ...over,
  })

  it('is accessible with the current session and another device', async () => {
    // Five "Sign out" buttons with the same visible label is the failure this
    // guards: each one carries an aria-label naming its row (#37).
    expect(
      await check(
        <ActiveSessions
         
          initialSessions={[
            session({ id: 1, current: true }),
            session({ id: 2, userAgent: 'Mozilla/5.0 (iPhone) Safari/605', ip: '198.51.100.4' }),
          ]}
        />,
      ),
    ).toHaveNoViolations()
  })

  it('is accessible with nothing to show', async () => {
    expect(await check(<ActiveSessions initialSessions={[]} />)).toHaveNoViolations()
  })

  it('is accessible when a session recorded neither ip nor user agent', async () => {
    // Both columns are nullable — no trusted proxy, or a client that sends no
    // User-Agent — so the em-dash placeholder has to be checked too.
    expect(
      await check(
        <ActiveSessions
         
          initialSessions={[session({ id: 3, ip: null, userAgent: null, current: true })]}
        />,
      ),
    ).toHaveNoViolations()
  })
})

/**
 * Everything below was added with the AAA pass (issue #102).
 *
 * The first round covered the eight primitives the admin forms are built from.
 * These are the rest of what a page renders: the live regions, the badges, the
 * loading placeholders, the breadcrumb trail, and the two components that draw
 * form controls without going through `Input`/`Select`. Each one is a place a
 * regression would reach main, because none of them is exercised in the state
 * that would fail by any page in the e2e list.
 */

function ToastTrigger({ type }: { type: 'success' | 'error' | 'info' }) {
  const { toast } = useToast()
  return <button onClick={() => toast('Product saved', type)}>fire</button>
}

describe('Toast', () => {
  it('is accessible in every type, once actually raised', async () => {
    // Rendered only after a click, which is the whole reason this was unchecked:
    // no page in the e2e list has a toast on screen when it is scanned. The bubble
    // carries its own role="alert"/"status" and an icon-only dismiss button.
    for (const type of ['success', 'error', 'info'] as const) {
      const { container, unmount } = render(
        <ToastProvider>
          <ToastTrigger type={type} />
        </ToastProvider>,
      )
      act(() => { screen.getByText('fire').click() })
      expect(await axeOn(container), type).toHaveNoViolations()
      unmount()
    }
  })
})

describe('Breadcrumbs', () => {
  it('is accessible as a two-level and a three-level trail', async () => {
    expect(
      await check(
        <Breadcrumbs
          label="Breadcrumb"
          items={[{ label: 'Orders', href: '/orders' }, { label: 'Order #12' }]}
        />,
      ),
    ).toHaveNoViolations()

    expect(
      await check(
        <Breadcrumbs
          label="Breadcrumb"
          items={[
            { label: 'Admin', href: '/admin' },
            { label: 'Products', href: '/admin/products' },
            { label: 'Managed Postgres' },
          ]}
        />,
      ),
    ).toHaveNoViolations()
  })

  it('is accessible with an unlinked crumb in the middle', async () => {
    // The catalogue's category filter is client state, so that crumb has no href.
    // A crumb that is not a link must not end up looking like the current page.
    const { container } = render(
      <Breadcrumbs
        label="Breadcrumb"
        items={[{ label: 'Catalog', href: '/catalog' }, { label: 'Databases' }, { label: 'Postgres' }]}
      />,
    )
    expect(await axeOn(container)).toHaveNoViolations()
    expect(container.querySelectorAll('[aria-current="page"]')).toHaveLength(1)
  })
})

describe('PageHeader', () => {
  it('is accessible with a subtitle and actions', async () => {
    expect(
      await check(
        <PageHeader title="Infrastructure" subtitle="Everything provisioned for you" actions={<Button>New</Button>} />,
      ),
    ).toHaveNoViolations()
  })
})

describe('TrialBadge', () => {
  it('is accessible with and without a duration', async () => {
    // The clock glyph is aria-hidden, so the badge must still carry its own text —
    // an icon-only badge would be silent.
    expect(await check(<TrialBadge />)).toHaveNoViolations()
    expect(await check(<TrialBadge minutes={60} />)).toHaveNoViolations()
  })
})

describe('Skeleton', () => {
  it('is accessible in all three shapes', async () => {
    // Pure decoration, and that is the point worth locking in: a placeholder must
    // not announce itself as content or as an unlabelled control. They are
    // `aria-hidden` for that reason — a page renders four to eight of them.
    expect(await check(<SkeletonCard />)).toHaveNoViolations()
    expect(await check(<SkeletonListItem />)).toHaveNoViolations()
    expect(
      await check(<table><tbody><SkeletonRow cols={3} /></tbody></table>),
    ).toHaveNoViolations()
  })

  // The one thing that does speak while a page loads (#155). Before it, a
  // client-rendered page was silent: the pulse animation says "loading"
  // exclusively to people who can see it.
  it('announces the wait without failing anything', async () => {
    expect(
      await check(
        <LoadingRegion label="Loading">
          {Array.from({ length: 8 }).map((_, i) => <SkeletonCard key={i} />)}
        </LoadingRegion>,
      ),
    ).toHaveNoViolations()
  })
})

describe('ProductImage', () => {
  it('is accessible with a description, and when marked decorative', async () => {
    expect(await check(<ProductImage productId={1} alt="Traffic graph of the managed gateway" />)).toHaveNoViolations()
    // alt="" is legitimate where the name is already in text beside it (a cart
    // row). axe accepts an empty alt and rejects a missing one, which is exactly
    // the distinction this component's API exists to preserve.
    expect(await check(<ProductImage productId={1} alt="" />)).toHaveNoViolations()
  })
})

describe('FavoriteButton', () => {
  it('is accessible in both states', async () => {
    // aria-pressed is the state, because the two look identical to anything that
    // cannot compare a yellow star to a grey one.
    expect(await check(<FavoriteButton favorited={false} onToggle={() => {}} lang="en" />)).toHaveNoViolations()
    expect(await check(<FavoriteButton favorited onToggle={() => {}} lang="en" />)).toHaveNoViolations()
    expect(await check(<FavoriteButton favorited busy onToggle={() => {}} lang="en" />)).toHaveNoViolations()
  })
})

describe('ParameterFields', () => {
  // The one component that renders form controls WITHOUT going through Input or
  // Select — a bare checkbox and a bare <select> — so none of the labelling those
  // primitives are tested for applies to it.
  const param = (over: Partial<Parameter>): Parameter => ({
    id: 1,
    scope: 'product',
    scopeId: 1,
    environmentId: null,
    name: 'hostname',
    label: 'Hostname',
    type: 'string',
    description: '',
    defaultValue: '',
    required: false,
    sensitive: false,
    sizeValues: {},
    ...over,
  })

  it('is accessible for every parameter type it draws', async () => {
    expect(
      await check(
        <ParameterFields
          onChange={() => {}}
          parameters={[
            param({ id: 1, name: 'hostname', label: 'Hostname', type: 'string', required: true }),
            param({ id: 2, name: 'replicas', label: 'Replicas', type: 'number', description: 'How many' }),
            param({ id: 3, name: 'public', label: 'Publicly reachable', type: 'bool', description: 'Opens port 443 to the internet' }),
            param({ id: 4, name: 'size', label: 'Size', type: 'dropdown', defaultValue: 'small, large', description: 'Sets the vCPU and memory allocation' }),
            param({ id: 5, name: 'token', label: 'API token', type: 'string', sensitive: true }),
          ]}
        />,
      ),
    ).toHaveNoViolations()
  })

  // The fixture above used to leave these two empty, so the branch that drops
  // the text never ran and the whole defect sat under a green check (#186).
  it('announces the description for the two types that draw their own markup', async () => {
    render(
      <ParameterFields
        onChange={() => {}}
        parameters={[
          param({ id: 3, name: 'public', label: 'Publicly reachable', type: 'bool', description: 'Opens port 443 to the internet' }),
          param({ id: 4, name: 'size', label: 'Size', type: 'dropdown', defaultValue: 'small, large', description: 'Sets the vCPU and memory allocation' }),
        ]}
      />,
    )
    // Same operator-authored string a text parameter gets through `Input`. It
    // is the difference between "Publicly reachable, checkbox" and knowing the
    // box opens a port.
    expect(screen.getByRole('checkbox', { name: 'Publicly reachable' }))
      .toHaveAccessibleDescription('Opens port 443 to the internet')
    expect(screen.getByRole('combobox', { name: 'Size' }))
      .toHaveAccessibleDescription('Sets the vCPU and memory allocation')
  })

  it('leaves the description wiring off when there is nothing to describe', () => {
    // An `aria-describedby` pointing at an id that was never rendered is a
    // broken reference, which some screen readers read as an empty description
    // and others skip entirely.
    render(<ParameterFields onChange={() => {}} parameters={[param({ id: 3, name: 'public', label: 'Publicly reachable', type: 'bool' })]} />)
    expect(screen.getByRole('checkbox', { name: 'Publicly reachable' })).not.toHaveAttribute('aria-describedby')
  })

  it('falls back to the variable name when no label is configured, rather than going unnamed', async () => {
    const { container } = render(
      <ParameterFields onChange={() => {}} parameters={[param({ label: '  ', name: 'tf_var_region' })]} />,
    )
    expect(await axeOn(container)).toHaveNoViolations()
    expect(screen.getByLabelText('tf_var_region')).toBeInTheDocument()
  })
})

describe('ProductGallery', () => {
  const images = [
    { id: 11, alt: 'The front of the gateway' },
    { id: 12, alt: 'The gateway dashboard' },
  ]

  it('is accessible with a gallery, with one picture, and with none', async () => {
    // The three states that differ structurally: thumbnails and a stepper, a
    // single picture with neither, and the placeholder.
    expect(await check(<ProductGallery productId={1} images={images} lang="en" />)).toHaveNoViolations()
    expect(await check(<ProductGallery productId={1} images={[images[0]]} lang="en" />)).toHaveNoViolations()
    expect(await check(<ProductGallery productId={1} images={[]} lang="en" />)).toHaveNoViolations()
  })

  it('is accessible with the zoom open', async () => {
    const { container } = render(<ProductGallery productId={1} images={images} lang="en" />)
    await userEvent.click(screen.getByRole('button', { name: /enlarge image/i }))

    const results = (await axe(container, {
      rules: {
        region: { enabled: false },
        'landmark-one-main': { enabled: false },
        'page-has-heading-one': { enabled: false },
        'color-contrast': { enabled: false },
      },
    })) as AxeResults
    expect(results).toHaveNoViolations()
  })
})

describe('ProductSpecs', () => {
  const parameter = {
    id: 1,
    scope: 'product' as const,
    scopeId: 1,
    environmentId: null,
    name: 'hostname',
    label: 'Hostname',
    type: 'string' as const,
    description: 'Sent as TF_VAR_hostname',
    defaultValue: 'web-01',
    required: true,
    sensitive: false,
    sizeValues: {},
  }

  it('is accessible as a specification table', async () => {
    expect(await check(<ProductSpecs parameters={[parameter]} lang="en" />)).toHaveNoViolations()
  })

  it('is accessible with a sensitive parameter and an optional one', async () => {
    expect(
      await check(
        <ProductSpecs
          parameters={[
            { ...parameter, sensitive: true, name: 'token', label: 'API token' },
            { ...parameter, required: false, name: 'zone', label: 'Zone', defaultValue: '' },
          ]}
          lang="en"
        />,
      ),
    ).toHaveNoViolations()
  })
})

describe('SizeSwatches', () => {
  const sizes = [
    { id: 1, code: 'S', label: 'Small', price: '10.00', currency: 'EUR', sortOrder: 0, active: true },
    { id: 2, code: 'XL', label: 'Extra large', price: '80.00', currency: 'EUR', sortOrder: 1, active: true },
  ]

  // The visible control is a <label>; the radio it wraps is `sr-only`, which is
  // focusable — `hidden` or `display: none` would not be, and would take the
  // keyboard support away while still looking right.
  it('labels every swatch and names the group', async () => {
    expect(
      await check(<SizeSwatches sizes={sizes} value="" onChange={() => {}} lang="en" />),
    ).toHaveNoViolations()
  })

  it('is clean with one selected too', async () => {
    expect(
      await check(<SizeSwatches sizes={sizes} value="XL" onChange={() => {}} lang="en" />),
    ).toHaveNoViolations()
  })
})
