import { test, expect } from './fixtures'
import AxeBuilder from '@axe-core/playwright'
import type { Result } from 'axe-core'

/**
 * Accessibility gate.
 *
 * WCAG 2.1 A + AA across every page a user can reach, plus the AAA criteria this
 * app can actually honour, plus the dialog states — this app puts most of its
 * forms inside <dialog>, and a static scan never opens them, which is how six
 * admin modals went unchecked.
 *
 * Three things this suite deliberately does NOT rely on:
 *
 *  1. Default branding. The header, nav, hero and footer are painted on the
 *     operator's chosen colour. Hardcoded white text passed with the shipped
 *     dark default and collapsed to 1.88:1 on a mid-tone amber, so the contrast
 *     check runs against a deliberately hostile colour as well. See
 *     apps/frontend/src/lib/contrast.ts.
 *  2. axe alone. Focus visibility, target size, accessible-name language and
 *     the contrast of glyph-only text are not things axe can test at the level
 *     this app claims, so they get explicit assertions of their own. The last of
 *     those is not a gap axe could close by configuration — see `glyphContrast`.
 *  3. "AAA" as a slogan. Full AAA is not reachable for an app whose brand colour
 *     is chosen by the operator, so the AAA claim here is partial and the parts
 *     that were refused are written down — with the arithmetic — in
 *     docs/guides/accessibility.md. Read that before adding or removing a tag.
 */

const PUBLIC_PAGES = ['/login', '/impressum']

const AUTHED_PAGES = [
  '/',
  '/catalog',
  '/cart',
  '/orders',
  '/projects',
  '/infrastructure',
  '/costs',
  '/approvals',
  '/audit',
  '/settings',
  '/admin',
  '/admin/categories',
  '/admin/ci-sources',
  '/admin/environments',
  '/admin/products',
  '/admin/products/new',
  '/admin/parameters',
  '/admin/users',
  '/admin/cost-centers',
  '/admin/branding',
  '/admin/config/smtp',
  '/admin/config/ai',
  '/admin/exchange-rates',
]

/**
 * The tags requested from axe.
 *
 * The AAA tags earn exactly three rules — axe has no others — and all three ship
 * `enabled: false`. Naming a tag explicitly runs them anyway: axe's `matchTags`
 * only consults `rule.enabled` when the include list is empty. wcag21aaa and
 * wcag22aaa match nothing today; they are here so a future axe release that adds
 * an AAA rule is picked up rather than silently skipped.
 *
 * `best-practice` is the newest of them, and it is worth 30 rules. Enumerated
 * against the axe-core 4.13.0 this repo pins, 30 of its 105 rules carry
 * `best-practice` and no `wcagNNN` tag at all, so the five WCAG tags above asked
 * for none of them (#185). They are not a softer class of finding — they are the
 * structural checks nothing else here performs: `heading-order`,
 * `page-has-heading-one`, `empty-heading`, `region`, `landmark-one-main`,
 * `landmark-unique`, the three `landmark-no-duplicate-*`, `skip-link`,
 * `tabindex`, `empty-table-header`. Between them, on the first run, they found
 * that `/` and `/catalog` had no `<h1>`, that /login and an unconfigured
 * /impressum had no landmark at all, and that every page built from
 * `PageHeader` + `Card` went h1 → h3 because `Card` hardcoded its title's
 * level.
 *
 * Three rules axe ships are still not requested, and all three deliberately:
 * `duplicate-id` and `duplicate-id-active` are tagged `deprecated` and
 * `wcag2a-obsolete` (4.1.1 was removed from WCAG in 2.2), and `target-size` is
 * the WCAG 2.2 AA criterion 2.5.8 at 24px — a weaker claim than the 44px 2.5.5
 * this suite measures itself further down, so passing it would say nothing.
 *
 * `the gate asks axe for the best-practice rules` below holds this honest: a tag
 * that stops matching is a silently smaller gate, not a red one.
 */
const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag2aaa', 'wcag21aaa', 'wcag22aaa', 'best-practice']

/**
 * The one AAA rule this app cannot satisfy, and why it is switched off rather
 * than tolerated.
 *
 * 1.4.6 wants 7:1. The chrome is painted on the OPERATOR's colour, and the only
 * two candidate inks are near-black and white — for a wide band of mid-tones
 * neither reaches 7:1 (#ca8a04 tops out at 6.05, #16a34a at 5.39). There is no
 * change the app can make: the background is the brand. Since the chrome is on
 * every page, leaving the rule on would mean a gate that is red forever, which is
 * a gate nobody reads. The half that IS reachable — the brand colour used as text
 * on our own surfaces — was raised to 7:1 in readableAccent instead, and
 * apps/frontend/src/lib/contrast.test.ts holds it there.
 *
 * Full reasoning, and the measured table: docs/guides/accessibility.md.
 */
const RULES_OUT_OF_SCOPE = ['color-contrast-enhanced']

/**
 * Rules whose "needs review" result is treated as a failure.
 *
 * `identical-links-same-purpose` (2.4.9) can never report a violation: when it
 * finds two links with the same name pointing at different URLs it sets the
 * result to undefined, which surfaces as `incomplete`. Asserting only on
 * `violations` would mean the rule was requested and then ignored — which is how
 * twenty "Details" links and one "Edit" per admin product row would have stayed.
 */
const REVIEW_IS_FAILURE = ['identical-links-same-purpose']

/** Compact, greppable failure output — the default axe dump is unreadable in CI. */
const format = (violations: Result[]): string =>
  violations
    .map((v) => {
      const nodes = v.nodes
        .slice(0, 5)
        .map((n) => `      ${n.target.join(' ')}\n        ${n.failureSummary?.replace(/\s+/g, ' ').slice(0, 160)}`)
        .join('\n')
      const more = v.nodes.length > 5 ? `\n      … and ${v.nodes.length - 5} more node(s)` : ''
      return `  [${v.impact}] ${v.id} — ${v.help} (${v.nodes.length} node(s))\n${nodes}${more}\n    ${v.helpUrl}`
    })
    .join('\n\n')

/**
 * Is a focus indicator painted on this element, and can it be SEEN?
 *
 * The distinction is the whole point, and this probe used to miss it. It asked
 * only whether a non-transparent shadow layer existed — and #186's first defect
 * was a ring painted in `currentcolor`, which resolved to white, on the white
 * `--tw-ring-offset-color` default, on a white card, with `focus:outline-none`.
 * A ring IS painted there. It is simply invisible, and the old probe passed it
 * (#298).
 *
 * So the measure is contrast, not existence: WCAG 1.4.11 wants 3:1 between a
 * focus indicator and what it is drawn against. The backdrop is resolved by
 * walking up from the element to the first ancestor with a non-transparent
 * background, because that is what the ring is actually painted over.
 *
 * Deliberately not a regex for splitting the shadow: the obvious one (a
 * repeated group containing `[^,]*`) backtracks exponentially on a long
 * all-transparent shadow, which CodeQL flags as a ReDoS.
 */
const focusProbe = () => {
  const el = document.activeElement as HTMLElement | null
  if (!el) return null
  const c = getComputedStyle(el)

  /**
   * Any CSS colour to channels, via the browser rather than a regex.
   *
   * Canvas `fillStyle` normalises whatever the engine understands — `oklch()`,
   * `color()`, `color-mix()`, a named colour — to `#rrggbb` or `rgba(...)`, and
   * silently ignores an assignment it cannot parse, which is the null case.
   *
   * Parsing this by hand is what broke the first attempt at this probe:
   * Tailwind v4 emits `oklch()`, the regex only knew `rgb()`, and every ring on
   * the page was reported as "paints no focus indicator at all".
   */
  const probeCanvas = document.createElement('canvas')
  probeCanvas.width = 1
  probeCanvas.height = 1
  const probeCtx = probeCanvas.getContext('2d', { willReadFrequently: true })
  const rgb = (value: string): [number, number, number, number] | null => {
    if (!probeCtx || !value || value === 'none') return null
    // Painted and read back, rather than read off `fillStyle`. Chromium keeps
    // `oklch(...)` verbatim in `fillStyle`, which is how the first version of
    // this probe reported every Tailwind v4 ring — they are all oklch — as no
    // ring at all. A pixel is always sRGB bytes.
    /*
     * Two sentinels, because one cannot tell "ignored" from "black".
     *
     * `fillStyle` defaults to `#000000`, and Chromium normalises `rgb(0, 0, 0)`
     * to exactly that — so a single-sentinel check reads a perfectly valid
     * black as an assignment the engine refused, and every black indicator and
     * every black backdrop would have been skipped. Assigning against two
     * different starting values leaves no colour that can impersonate both.
     */
    const ignored = (sentinel: string): boolean => {
      probeCtx.fillStyle = sentinel
      probeCtx.fillStyle = value
      return probeCtx.fillStyle === sentinel
    }
    if (ignored('#000000') && ignored('#ffffff')) return null

    probeCtx.clearRect(0, 0, 1, 1)
    probeCtx.fillStyle = value
    probeCtx.fillRect(0, 0, 1, 1)
    const [r, g, b, a] = probeCtx.getImageData(0, 0, 1, 1).data
    return [r, g, b, a / 255]
  }

  /**
   * `fg` painted on `bg`, which is the colour a person actually sees.
   *
   * Alpha was ignored before, and that is not a rounding error: `ratio()` read
   * `rgba(0, 0, 0, 0.05)` as pure black and reported 21:1 against white for a
   * ring whose rendered contrast is about 1.1:1. A focus indicator too faint to
   * see passed the check that exists to find exactly that. Raised by CodeRabbit
   * on #306.
   *
   * The source-over formula, on sRGB bytes. Compositing in gamma space is not
   * strictly correct colour science, and it IS what a browser does — the point
   * here is to reproduce the pixel on screen, not to improve on it.
   */
  const over = (
    fg: [number, number, number, number],
    bg: [number, number, number, number],
  ): [number, number, number, number] => {
    const a = fg[3]
    if (a >= 1) return fg
    return [
      fg[0] * a + bg[0] * (1 - a),
      fg[1] * a + bg[1] * (1 - a),
      fg[2] * a + bg[2] * (1 - a),
      1,
    ]
  }

  const relativeLuminance = ([r, g, b]: [number, number, number, number]): number => {
    const lin = (n: number) => {
      const v = n / 255
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
    }
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
  }

  const ratio = (a: [number, number, number, number], b: [number, number, number, number]): number => {
    const la = relativeLuminance(a)
    const lb = relativeLuminance(b)
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
  }

  /**
   * What the indicator is drawn over — and that depends on which side it is on.
   *
   * A `box-shadow` ring is painted OUTSIDE the border box, so what it sits on is
   * the first opaque ancestor. An `inset` ring is painted inside, so what it
   * sits on is the element's own background.
   *
   * Getting this wrong is not academic: measuring the outside ring of a primary
   * button against the button's own fill compared blue-500 to the branding's
   * amber and reported 2.27:1 — a failure for a ring that in fact sits on the
   * dialog behind it at nearly 4:1. The check has to know where the paint lands.
   *
   * White is the honest fallback when nothing opaque is found: the page body is
   * white here, and assuming the most common backdrop beats skipping the check.
   */
  const backdropFrom = (start: HTMLElement | null): [number, number, number, number] => {
    // Every painted layer down to the first opaque one, nearest first. Taking
    // the first with `alpha > 0.5` — which is what this did — reports a 60%
    // white panel over a dark page as white, and the modal overlay in this app
    // is exactly that shape.
    const layers: [number, number, number, number][] = []
    let node: HTMLElement | null = start
    while (node) {
      const parsed = rgb(getComputedStyle(node).backgroundColor)
      if (parsed && parsed[3] > 0) {
        layers.push(parsed)
        if (parsed[3] >= 1) break
      }
      node = node.parentElement
    }
    // Flattened from the bottom up, on white: the page body is white here, and
    // assuming the most common backdrop beats skipping the check.
    return layers.reduceRight<[number, number, number, number]>(
      (below, layer) => over(layer, below),
      [255, 255, 255, 1],
    )
  }
  const insideBackdrop = () => backdropFrom(el)
  const outsideBackdrop = () => backdropFrom(el.parentElement)

  /**
   * Every shadow layer that actually paints, as colours.
   *
   * All of them, not the first — Tailwind's ring is TWO shadows and the first
   * is the offset, deliberately painted in the page colour so the ring stands
   * clear of the control. Measuring that one against the backdrop returns 1.00
   * by construction, which is how the first version of this check reported
   * every Button in a dialog as having an invisible focus ring. The ring is the
   * layer after it, so the honest question is whether ANY layer is visible.
   */
  const shadowColours = (shadow: string): { colour: [number, number, number, number]; inset: boolean }[] => {
    if (!shadow || shadow === 'none') return []
    return shadow
      .split(/(?=rgba?\(|oklch\(|color\()/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((layer) => {
        // The layer is "<colour> <offsets> [inset]"; hand the colour to the
        // canvas and keep the keyword, which decides which side it is painted on.
        const colour = /(rgba?\([^)]*\)|oklch\([^)]*\)|color\([^)]*\)|#[0-9a-f]{3,8})/i.exec(layer)
        const parsed = colour ? rgb(colour[1]) : null
        return parsed ? { colour: parsed, inset: /\binset\b/.test(layer) } : null
      })
      .filter((c): c is { colour: [number, number, number, number]; inset: boolean } => c !== null && c.colour[3] > 0)
  }

  const ringLayers = shadowColours(c.boxShadow)
  const outlineWidth = parseFloat(c.outlineWidth)
  const outlined = c.outlineStyle !== 'none' && outlineWidth > 0
  const outlineColour = outlined ? rgb(c.outlineColor) : null

  // Composited against the surface it is painted on, then compared to that same
  // surface. An indicator with alpha does not have its own colour on screen —
  // it has the colour of itself over whatever is behind it.
  const against = (
    colour: [number, number, number, number],
    backdrop: [number, number, number, number],
  ) => ratio(over(colour, backdrop), backdrop)

  const contrasts = [
    // Each layer against the surface it is actually painted on.
    ...ringLayers.map((layer) => against(layer.colour, layer.inset ? insideBackdrop() : outsideBackdrop())),
    // An outline is always drawn outside the border box.
    ...(outlineColour ? [against(outlineColour, outsideBackdrop())] : []),
  ]

  return {
    outlined,
    ringed: ringLayers.length > 0,
    /**
     * Best contrast of any indicator against its backdrop, or null when there
     * is an indicator whose colour could not be parsed. Null is not a pass.
     */
    contrast: contrasts.length > 0 ? Math.max(...contrasts) : null,
    unmeasurable: (c.boxShadow !== 'none' && ringLayers.length === 0) || (outlined && outlineColour === null),
    inDialog: !!el.closest('dialog'),
    id:
      el.tagName.toLowerCase() +
      (el.getAttribute('aria-label') ? `[${el.getAttribute('aria-label')}]` : '') +
      (el.getAttribute('type') ? `:${el.getAttribute('type')}` : ''),
  }
}

/** WCAG 1.4.11: a focus indicator needs 3:1 against what it is drawn on. */
const FOCUS_INDICATOR_MIN_CONTRAST = 3

/**
 * WCAG 1.4.3 for text axe refuses to look at.
 *
 * `color-contrast` only matches an element that `hasRealTextChildren` accepts,
 * and that helper calls `removeUnicode(text, { emoji: true, punctuations: true })`
 * before deciding. A required-field marker is one asterisk; strip the
 * punctuation and the string is empty, so the element is dropped from the rule
 * altogether. No viewport, no branding colour and no rule option changes it —
 * the hole is in the matcher, and it swallows every glyph-only indicator:
 * asterisks, bullets, dots, chevrons, dashes (#185). It is how a 3.82:1
 * asterisk — the one mark telling a low-vision user which fields are mandatory
 * — shipped on every form in the app and on five admin dialogs.
 *
 * Colours go through a canvas rather than being parsed out of the computed
 * string: Tailwind 4 authors its palette in oklch and Chromium hands that back
 * as `oklch(...)`, which no rgb() regex reads. Painting one pixel and reading it
 * back returns sRGB whatever the input syntax was.
 *
 * `aria-hidden` glyphs are skipped. They are decoration by the author's own
 * declaration — the breadcrumb separators are the case here — and 1.4.3 is
 * about text that carries information.
 */
const glyphContrast = () => {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 1
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.globalCompositeOperation = 'copy'

  type Rgba = { r: number; g: number; b: number; a: number }

  // Memoised because `backdrop` walks every ancestor of every glyph and a page
  // has a handful of distinct colours in total. getImageData is not free, and
  // an unmemoised walk over a long table costs seconds.
  const seen = new Map<string, Rgba>()

  const toRgba = (css: string): Rgba => {
    const hit = seen.get(css)
    if (hit) return hit
    // Reset first: an unparseable value leaves fillStyle at its previous colour,
    // which would silently report the LAST element's colour for this one.
    ctx.fillStyle = '#000000'
    ctx.fillStyle = css
    ctx.fillRect(0, 0, 1, 1)
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data
    const rgba = { r, g, b, a: a / 255 }
    seen.set(css, rgba)
    return rgba
  }

  const over = (fg: Rgba, bg: Rgba): Rgba => ({
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  })

  const luminance = ({ r, g, b }: Rgba): number => {
    const channel = (v: number) => {
      const c = v / 255
      return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
    }
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
  }

  const WHITE: Rgba = { r: 255, g: 255, b: 255, a: 1 }

  /** The colour actually behind the glyph, compositing every translucent layer. */
  const backdrop = (el: Element): Rgba => {
    let stack: Rgba | null = null
    for (let node: Element | null = el; node; node = node.parentElement) {
      const layer = toRgba(getComputedStyle(node).backgroundColor)
      if (layer.a > 0) stack = stack ? over(stack, layer) : layer
      if (stack && stack.a >= 0.999) return stack
    }
    // Nothing opaque all the way up: the canvas underneath is the browser's own.
    return stack ? over(stack, WHITE) : WHITE
  }

  const ratio = (fg: Rgba, bg: Rgba): number => {
    const [hi, lo] = [luminance(fg), luminance(bg)].sort((a, b) => b - a)
    return (hi + 0.05) / (lo + 0.05)
  }

  /** Only the element's OWN text — a parent's letters are not this node's glyph. */
  const ownText = (el: Element): string =>
    Array.from(el.childNodes)
      .filter((n) => n.nodeType === Node.TEXT_NODE)
      .map((n) => n.textContent ?? '')
      .join('')
      .trim()

  return Array.from(document.querySelectorAll<HTMLElement>('body *'))
    .filter((el) => {
      const text = ownText(el)
      // What axe strips and then calls empty: one or two characters, no letters
      // and no digits. Matching the shape of the hole rather than listing the
      // glyphs, so the next indicator someone invents is covered too.
      // Cheapest filter first: it is the one that rejects the whole page.
      return text.length > 0 && text.length <= 2 && !/[\p{L}\p{N}]/u.test(text)
    })
    .filter((el) => !el.closest('[aria-hidden="true"]'))
    .filter((el) => {
      const style = getComputedStyle(el)
      if (style.visibility === 'hidden' || style.opacity === '0') return false
      const r = el.getBoundingClientRect()
      return r.width > 0 && r.height > 0
    })
    .map((el) => {
      const style = getComputedStyle(el)
      const bg = backdrop(el)
      const size = parseFloat(style.fontSize)
      const weight = parseInt(style.fontWeight, 10) || 400
      // 1.4.3's own large-text exception, in the CSS px the criterion is written
      // in: 18.66px bold or 24px. Applying it here rather than failing a large
      // glyph at 4.5:1 keeps this from being a stricter rule than WCAG's.
      const large = size >= 24 || (size >= 18.66 && weight >= 700)
      return {
        text: ownText(el),
        ratio: Math.round(ratio(over(toRgba(style.color), bg), bg) * 100) / 100,
        needs: large ? 3 : 4.5,
        where:
          el.tagName.toLowerCase() +
          `.${el.className?.toString().trim().split(/\s+/).join('.').slice(0, 60)}` +
          ` in <${el.parentElement?.tagName.toLowerCase() ?? '?'}> "${
            el.parentElement?.textContent?.trim().replace(/\s+/g, ' ').slice(0, 40) ?? ''
          }"`,
      }
    })
}

/**
 * Controls inside `container` whose selected state is painted by their OWN
 * inline `style.backgroundColor` and nothing else — the shape of #186's
 * second defect, which lived in the catalogue sidebar, the mobile category
 * pills and the language menu. The one assertion this file had for that
 * defect (`nav a[aria-current="page"]`, further down) proves the point for the
 * top nav and nothing else, because the nav is marked with a CSS class, not an
 * inline style, so a check for the actual defect could not reuse it (#298).
 *
 * Scoped to one container per call rather than the whole document: a plain
 * action button (`loadMore` on /catalog) is ALSO painted with an inline
 * background and rightly carries no state attribute — it is a single action,
 * not one of a set of alternatives, and flagging it would be a false
 * positive. Restricting the scan to a container known to hold a set of
 * choices keeps the check honest without hand-listing every offending
 * element by name; `item` names the repeated control inside it.
 *
 * The accessible-state attributes are listed INSIDE the function rather than
 * as a module-level constant: `page.evaluate` ships this function to the
 * browser as its own source text, with no closure over anything outside it —
 * a module-level array here would be `undefined` in the page and every check
 * would throw a ReferenceError rather than measure anything.
 */
const colourOnlySelection = ({ container, item }: { container: string; item: string }) => {
  const STATE_ATTRS = ['aria-current', 'aria-pressed', 'aria-selected']
  const root = document.querySelector(container)
  if (!root) return { offenders: [`no "${container}" on this page — the selector may have gone stale`], painted: 0 }
  const painted = Array.from(root.querySelectorAll<HTMLElement>(item)).filter((el) => el.style.backgroundColor)
  const offenders = painted
    .filter((el) => !STATE_ATTRS.some((attr) => el.hasAttribute(attr)))
    .map((el) => {
      const name = el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 40) ?? '(no accessible name)'
      return `${el.tagName.toLowerCase()} "${name}" in ${container}`
    })
  return { offenders, painted: painted.length }
}

type Page = import('@playwright/test').Page

const scan = async (page: Page) =>
  await new AxeBuilder({ page }).withTags(WCAG).disableRules(RULES_OUT_OF_SCOPE).analyze()

/**
 * Wait until the page is actually the page, not its loading placeholders.
 *
 * `goto` resolves on `load`, which is BEFORE hydration has fired the fetch. A
 * client-rendered page — `/catalog`, `/admin/users`, `/admin/products` and most
 * of the rest — is still showing `SkeletonCard`/`SkeletonListItem` at that
 * moment, and a skeleton has no form controls, no headings and no text to fail
 * contrast on. So the gate reported clean and meant nothing (#155).
 *
 * Two halves, and the second is what makes it honest:
 *
 *   * no placeholder is left — `data-loading` is put there by the skeletons for
 *     exactly this purpose;
 *   * the page rendered SOMETHING. Without that a page which failed to load at
 *     all also has no placeholders, and would sail through as "clean" for the
 *     same reason the skeletons did.
 *
 * The second check is on the body's text and not on `main`, which was the first
 * attempt and was wrong: `/login` has no `main` landmark at all, and
 * `/impressum` renders without one when no imprint text is configured — which
 * is every CI database. Requiring one would have failed the gate for a layout
 * choice rather than for an accessibility defect. (A missing `main` is
 * `landmark-one-main`, a best-practice rule outside the WCAG A/AA tags this
 * gate requests, so axe does not ask for one either.)
 *
 * The spec already knew about this race: its detail-page block documents it
 * ("the catalogue fetches its products after hydration"). The 23 static pages
 * never got the wait.
 */
const settled = async (page: Page, where: string) => {
  await expect(page.locator('[data-loading]'), `${where} still showing loading placeholders`)
    .toHaveCount(0, { timeout: 15_000 })

  // Not a specific string — 25 pages have 25 different first paragraphs — but
  // some rendered text. A blank page is a page that did not load, and scanning
  // it proves nothing.
  await expect
    .poll(
      async () => (await page.locator('body').innerText()).trim().length,
      { message: `${where} rendered no text at all`, timeout: 15_000 },
    )
    .toBeGreaterThan(0)
}

/** Scan and judge, including the review-only rules. `where` names the page. */
const expectAccessible = async (page: Page, where: string) => {
  await settled(page, where)
  const { violations, incomplete } = await scan(page)
  expect(violations, `${where}\n${format(violations)}`).toEqual([])

  const review = incomplete.filter((r) => REVIEW_IS_FAILURE.includes(r.id))
  expect(review, `${where} — needs review, which this suite counts as failing\n${format(review)}`).toEqual([])

  // Here and not in its own block, because the class is not confined to a few
  // known pages: every page and every dialog this suite already loads gets the
  // measurement for the price of one evaluate. The block below proves the probe
  // finds anything at all — without that, a universally-passing check is
  // indistinguishable from a check that matched nothing.
  const glyphs = await page.evaluate(glyphContrast)
  const dim = glyphs.filter((g) => g.ratio < g.needs)
  expect(
    dim,
    `${where} — glyph-only text below its 1.4.3 floor, which axe cannot see:\n` +
      dim.map((g) => `  "${g.text}" is ${g.ratio}:1, needs ${g.needs}:1 — ${g.where}`).join('\n'),
  ).toEqual([])
}

/** 44 CSS px: the WCAG 2.5.5 target size. */
const TARGET_MIN = 44

/**
 * Controls on the page smaller than `min` in either dimension.
 *
 * axe has no rule for 2.5.5 — its `target-size` rule is the WCAG 2.2 AA criterion
 * (2.5.8, 24px), which is a different and weaker claim — so this measures it.
 *
 * Scope is CONTROLS, not every clickable thing. Content links are excluded on
 * purpose: they sit inside lines of text a few pixels apart, and the exclusion is
 * argued in docs/guides/accessibility.md rather than hidden here. Checkboxes,
 * radios and file inputs are excluded for the reasons recorded there too — the
 * first two are a real gap, the third is 2.5.5's own user-agent exception.
 *
 * Zero-sized elements are skipped rather than failed: a control inside a closed
 * <details> or a hidden panel measures 0x0, and it is not a target while it
 * cannot be pointed at.
 */
const undersizedControls = (min: number) => {
  const SELECTOR = [
    'button',
    'summary',
    'select',
    'textarea',
    '[role="button"]',
    'input:not([type="checkbox"]):not([type="radio"]):not([type="hidden"]):not([type="file"])',
  ].join(', ')

  return Array.from(document.querySelectorAll<HTMLElement>(SELECTOR))
    .map((el) => {
      const r = el.getBoundingClientRect()
      return { el, w: r.width, h: r.height }
    })
    .filter(({ w, h }) => w > 0 && h > 0)
    // Sub-pixel layout: a 44px box can measure 43.99.
    .filter(({ w, h }) => w < min - 0.5 || h < min - 0.5)
    .map(({ el, w, h }) => {
      const name = el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 40) ?? ''
      return `${el.tagName.toLowerCase()}${el.getAttribute('type') ? `:${el.getAttribute('type')}` : ''} ` +
        `"${name}" is ${w.toFixed(1)}x${h.toFixed(1)} — class="${el.className}"`
    })
}

test.describe('Accessibility — public pages', () => {
  test.use({ storageState: { cookies: [], origins: [] } })

  for (const path of PUBLIC_PAGES) {
    test(`${path} is clean at A, AA and the AAA criteria in scope`, async ({ page }) => {
      await page.goto(path)
      await expectAccessible(page, path)
    })
  }
})

test.describe('Accessibility — authenticated pages', () => {
  for (const path of AUTHED_PAGES) {
    test(`${path} is clean at A, AA and the AAA criteria in scope`, async ({ page }) => {
      await page.goto(path)
      await expectAccessible(page, path)
    })
  }
})

/*
 * WCAG 1.4.10 Reflow (AA).
 *
 * Content must be usable at a 320px CSS width without scrolling in two
 * directions. Nothing in this suite ever narrowed the viewport, so the app
 * shipped with a 669px hard floor on every authenticated page: the header row
 * could not shrink, and the account menu — which is where Sign out lives — sat
 * entirely off-screen with `scrollLeft` pinned at 0, so there was no way to
 * reach it at all (#167, #169).
 *
 * 320px because that is the number the criterion names: 1280px at 400% zoom.
 *
 * The document is what must not scroll sideways. A wide table inside its own
 * `overflow-x-auto` box is fine and deliberate — the criterion allows content
 * that genuinely requires two dimensions to scroll within its own container.
 * So this measures the scrolling ELEMENT, not every descendant.
 */
test.describe('Reflow (1.4.10) — nothing scrolls sideways at 320px', () => {
  test.use({ viewport: { width: 320, height: 800 } })

  const overflowOf = (page: Page) =>
    page.evaluate(() => {
      const doc = document.documentElement
      return {
        overflow: doc.scrollWidth - doc.clientWidth,
        // Named so a failure says WHAT is sticking out rather than only by how
        // much — a bare number sends the next person measuring by hand.
        widest: [...document.querySelectorAll('body *')]
          .map((el) => {
            const r = el.getBoundingClientRect()
            return { right: Math.round(r.right), tag: el.tagName.toLowerCase(), cls: el.className?.toString().slice(0, 80) ?? '' }
          })
          .filter((e) => e.right > doc.clientWidth + 1)
          .sort((a, b) => b.right - a.right)
          .slice(0, 3),
      }
    })

  for (const path of PUBLIC_PAGES) {
    test(`${path} fits a phone, signed out`, async ({ browser }) => {
      const context = await browser.newContext({
        viewport: { width: 320, height: 800 },
        baseURL: test.info().project.use.baseURL,
      })
      const page = await context.newPage()
      try {
        await page.goto(path)
        await settled(page, path)
        const { overflow, widest } = await overflowOf(page)
        expect(overflow, `${path} overflows 320px by ${overflow}px — widest: ${JSON.stringify(widest)}`).toBeLessThanOrEqual(0)
      } finally {
        await context.close()
      }
    })
  }

  for (const path of AUTHED_PAGES) {
    test(`${path} fits a phone`, async ({ page }) => {
      await page.goto(path)
      await settled(page, path)
      const { overflow, widest } = await overflowOf(page)
      expect(overflow, `${path} overflows 320px by ${overflow}px — widest: ${JSON.stringify(widest)}`).toBeLessThanOrEqual(0)
    })
  }

  /*
   * The dialogs are where most of this app's forms live, and none of the four
   * `Modal` sizes clamped below a phone: the default 448px measured
   * `left: 111, right: 559` at 375px, with its field labels sheared off the
   * left edge (#167).
   */
  test('an open dialog fits a phone', async ({ page }) => {
    await page.goto('/admin/users')
    await settled(page, '/admin/users')
    await page.getByRole('button', { name: /add user/i }).first().click()

    const dialog = page.locator('dialog[open]')
    await expect(dialog).toBeVisible()
    const box = await dialog.boundingBox()
    expect(box, 'the dialog has no box').not.toBeNull()
    expect(box!.x, 'the dialog starts off the left edge').toBeGreaterThanOrEqual(0)
    expect(box!.x + box!.width, 'the dialog runs past the right edge').toBeLessThanOrEqual(320)
  })
})

test.describe('Accessibility — dialogs', () => {
  // Most forms in this app live inside a modal, so scanning only the closed page
  // leaves the majority of the form controls unchecked.
  const MODALS: [string, RegExp][] = [
    ['/admin/categories', /add category/i],
    ['/admin/ci-sources', /add ci source/i],
    ['/admin/environments', /add environment/i],
    ['/admin/cost-centers', /add cost center/i],
    ['/admin/parameters', /add parameter/i],
    ['/admin/users', /add user/i],
    // Root's view of another user's sessions (#37). It is a dialog, so a static
    // scan of /admin/users never opens it — the same reason the six above are
    // listed. The name matched is the button's aria-label, which carries the
    // user it belongs to.
    // Matches the `activeSessions` key ('Active sessions'), not a literal — the
    // button's accessible name is translated, so anchoring on English prose that
    // is no longer there is how this silently stops opening the dialog.
    ['/admin/users', /^Active sessions:/],
  ]

  for (const [path, buttonName] of MODALS) {
    test(`${path} dialog (${buttonName.source}) is clean at A, AA and the AAA criteria in scope`, async ({ page }) => {
      await page.goto(path)
      await page.getByRole('button', { name: buttonName }).first().click()
      await expect(page.locator('dialog[open]')).toBeVisible()

      await expectAccessible(page, `${path} dialog`)

      // A modal that traps focus and closes on Escape is the reason the native
      // <dialog> element was chosen; assert it so a hand-rolled overlay can't
      // quietly replace it.
      expect(
        await page.evaluate(() => !!document.activeElement?.closest('dialog')),
        'focus should start inside the dialog',
      ).toBe(true)

      await page.keyboard.press('Escape')
      await expect(page.locator('dialog[open]')).toHaveCount(0)
    })
  }
})

test.describe('Accessibility — branding colours cannot break the chrome', () => {
  // Writes shared server state, so no parallel worker may observe it half-applied.
  test.describe.configure({ mode: 'serial' })

  // The regression this guards: the portal chrome used to hardcode white text on
  // the operator's primary colour. A mid-tone choice dropped the nav to 1.88:1.
  // Foregrounds are now derived from the colour's luminance, so a hostile colour
  // has to stay AA-clean.
  const HOSTILE = '#ca8a04' // amber-600 — the value that produced 246 failures

  /*
   * What the colour was before this file touched it.
   *
   * Captured once and restored in `afterAll` as well as in the test's own
   * `finally`, because the two fail in different ways. A `finally` covers an
   * assertion that throws; it does NOT cover a test that times out, a run
   * stopped by `--max-failures`, or a worker that is torn down — and the amber
   * left behind by any of those persists in the database. That amber primary is
   * known to fail axe on `/`, so with `retries: 1` the retry then scans a
   * poisoned database and fails for the wrong reason, on a page this test never
   * touched (#155).
   *
   * Belt and braces on purpose: neither hook survives a SIGKILL, and a shared
   * mutable colour is what this test is. The pair closes every failure mode
   * short of that.
   */
  let originalColour: string | null = null

  const HEX_FIELD = /primary color — hex value/i

  const writeColour = async (page: Page, value: string) => {
    await page.goto('/admin/branding')
    await page.getByRole('textbox', { name: HEX_FIELD }).fill(value)
    await page.getByRole('button', { name: /save branding/i }).click()
  }

  test.afterAll(async ({ browser }) => {
    if (originalColour === null) return

    /*
     * Its own context: the test's page is gone by now, and a torn-down one is
     * exactly the case this hook exists for.
     *
     * `browser.newContext()` inherits NOTHING from the project — not the
     * baseURL, so `/admin/branding` is not a URL it can navigate to, and not the
     * storageState, so it would arrive signed out and be bounced to /login.
     * A restore hook that cannot restore is worse than none: it reads as though
     * the colour was put back.
     *
     * Taken from `test.info().project.use` rather than repeated as literals,
     * because a second copy of the baseURL is a second thing to keep in step.
     */
    const { baseURL, storageState } = test.info().project.use
    const context = await browser.newContext({ baseURL, storageState })
    const page = await context.newPage()
    try {
      await writeColour(page, originalColour)
      await page.reload()
      await expect(page.getByRole('textbox', { name: HEX_FIELD })).toHaveValue(originalColour)
    } finally {
      await context.close()
    }
  })

  test('a mid-tone primary colour keeps the dashboard AA-clean', async ({ page }) => {
    // This test mutates shared server state, so it reads the current value from
    // the FORM (not an API call that might fail) and restores it both in the
    // finally below and in the afterAll above. Serial mode keeps a parallel
    // worker from seeing the hostile colour mid-flight.
    test.slow()
    await page.goto('/admin/branding')
    const hex = page.getByRole('textbox', { name: HEX_FIELD })
    const original = await hex.inputValue()
    expect(original, 'could not read the current branding colour to restore later').toMatch(/^#[0-9a-fA-F]{3,6}$/)
    // Recorded BEFORE the write, so the hook can undo it even if everything
    // below this line is skipped.
    originalColour = original

    const save = () => page.getByRole('button', { name: /save branding/i }).click()

    try {
      await hex.fill(HOSTILE)
      await save()

      for (const path of ['/', '/catalog', '/admin']) {
        await page.goto(path)
        // The same wait every other scan takes: with the hostile colour applied,
        // a skeleton has nothing coloured to fail on, so scanning one would
        // report clean and prove nothing.
        await settled(page, `${path} with primary ${HOSTILE}`)
        const { violations } = await scan(page)
        const contrast = violations.filter((v) => v.id === 'color-contrast')
        expect(contrast, `${path} with primary ${HOSTILE}:\n${format(contrast)}`).toEqual([])
      }
    } finally {
      await writeColour(page, original)
      // Prove the restore landed rather than assuming it did.
      await page.reload()
      await expect(page.getByRole('textbox', { name: HEX_FIELD })).toHaveValue(original)
      // The afterAll hook has nothing left to undo.
      originalColour = null
    }
  })

  test('the branding form warns before an unreadable colour is saved', async ({ page }) => {
    await page.goto('/admin/branding')
    // A mid grey is the one case where neither ink reaches AA, so the operator
    // has to be told rather than silently shipping an unreadable header.
    await page.getByRole('textbox', { name: /primary color — hex value/i }).fill('#7b7b7b')
    // Matches the `contrastFailsAA` string, not the sentence this warning used to
    // be: translating the admin area replaced the hard-coded "WCAG AA needs N:1"
    // with keys, so the old regex matched nothing and this test failed for a
    // wording change rather than a behaviour one.
    await expect(
      page.getByRole('alert').filter({ hasText: /does not meet WCAG AA/i }),
    ).toBeVisible()
  })
})

test.describe('Accessibility — things axe cannot check', () => {
  /*
   * Four pages, not one. The chrome is shared, but the ring is painted on
   * whatever is behind it — a white ring is invisible on a card and obvious on
   * the branded header — so "the header passes on /admin/categories" says
   * nothing about the header on the catalogue (#298).
   */
  for (const path of ['/admin/categories', '/catalog', '/', '/orders'])
  test(`every interactive control in the chrome shows a visible focus indicator on ${path}`, async ({ page }) => {
    await page.goto(path)

    const controls: [string, string][] = [
      ['header account menu', 'header summary'],
      ['header search input', 'header input[type="text"]'],
      ['header search button', 'header button[type="submit"]'],
      ['nav link', 'nav a'],
      ['skip link', 'a[href="#main"]'],
    ]

    for (const [label, selector] of controls) {
      const el = page.locator(selector).first()
      await el.focus()
      // Some of these carry `transition-all`, so let the ring finish fading in
      // before reading the computed style.
      await page.waitForTimeout(250)
      const probe = await page.evaluate(focusProbe)
      expect(probe, `${label} (${selector}) had no focused element to measure`).not.toBeNull()
      expect(
        probe!.outlined || probe!.ringed,
        `${label} (${selector}) paints no focus indicator at all`,
      ).toBe(true)
      // Painted is not the same as visible. A ring the same colour as what it
      // is drawn on satisfies every check that only asks whether it exists.
      expect(
        probe!.contrast ?? 0,
        `${label} (${selector}) paints a focus indicator at ${probe!.contrast?.toFixed(2) ?? 'an unmeasurable'} contrast against its backdrop — 1.4.11 wants ${FOCUS_INDICATOR_MIN_CONTRAST}:1`,
      ).toBeGreaterThanOrEqual(FOCUS_INDICATOR_MIN_CONTRAST)
    }
  })

  /*
   * The probe measuring itself.
   *
   * Everything else in this file asks whether the APP is accessible; this asks
   * whether the instrument can tell. It is here because the instrument has been
   * confidently wrong four times already — a regex that could not read oklch, a
   * fillStyle that kept it verbatim, the ring's white offset layer read as the
   * ring, an outside ring measured against the element's own fill — and each
   * time the suite went green while the page was not.
   *
   * Alpha was the fifth: `ratio()` took `rgba(0, 0, 0, 0.05)` for pure black and
   * called it 21:1 on white, so a ring nobody can see passed the check that
   * exists to find one. Two synthetic controls rather than a fixture route, one
   * for each half — a translucent indicator, and a translucent backdrop over a
   * dark surface — because both are cases the app can produce and neither is
   * reliably on screen at any given moment.
   */
  test('the focus probe composites alpha before judging contrast', async ({ page }) => {
    await page.goto('/login')

    // `outline:none` on every fixture button, and it is not incidental. A bare
    // <button> gets Chromium's own focus ring — `outline: auto`, rgb(16,16,16)
    // — which is 19:1 on white and wins `Math.max` over whatever the case is
    // actually testing. The first version of this test reported 19.03 for a 5%
    // ring and looked like the compositing had not worked at all. Same class of
    // mistake as the four the probe itself has made: measuring something other
    // than the thing named.
    const probeOn = async (html: string) => {
      await page.evaluate((markup) => {
        document.getElementById('probe-fixture')?.remove()
        const host = document.createElement('div')
        host.id = 'probe-fixture'
        host.innerHTML = markup
        document.body.append(host)
        ;(host.querySelector('button') as HTMLElement).focus()
      }, html)
      return page.evaluate(focusProbe)
    }

    // A 5%-black ring on white. Read as opaque black it is 21:1; painted, it is
    // #f2f2f2 on #ffffff, which is 1.09:1 and invisible.
    const faint = await probeOn(
      `<div style="background:#ffffff">
         <button style="outline:none;background:#ffffff;box-shadow:0 0 0 2px rgba(0,0,0,0.05)">x</button>
       </div>`,
    )
    expect(faint!.ringed).toBe(true)
    expect(faint!.contrast!).toBeLessThan(1.5)

    // The same ring at full strength, to show the check is not simply refusing
    // everything: black on white is the maximum.
    const solid = await probeOn(
      `<div style="background:#ffffff">
         <button style="outline:none;background:#ffffff;box-shadow:0 0 0 2px rgb(0,0,0)">x</button>
       </div>`,
    )
    expect(solid!.contrast!).toBeGreaterThan(20)

    // A translucent panel over a dark page — the shape of this app's modal
    // overlay. Taking the first layer with alpha > 0.5 reported it as white and
    // judged a white ring against itself; composited it is a mid grey, and a
    // white ring on it is clearly visible.
    const overlaid = await probeOn(
      `<div style="background:#000000">
         <div style="background:rgba(255,255,255,0.6)">
           <button style="outline:none;background:transparent;box-shadow:0 0 0 2px #ffffff">x</button>
         </div>
       </div>`,
    )
    expect(overlaid!.contrast!).toBeGreaterThan(1.5)
    expect(overlaid!.contrast!).toBeLessThan(3)

    await page.evaluate(() => document.getElementById('probe-fixture')?.remove())
  })

  test('every focus stop inside a dialog shows a focus indicator', async ({ page }) => {
    await page.goto('/admin/categories')
    await page.getByRole('button', { name: /add category/i }).first().click()
    await expect(page.locator('dialog[open]')).toBeVisible()

    // Tab with the real keyboard rather than calling .focus(): Chromium only
    // matches :focus-visible on a <button> after keyboard interaction, so
    // programmatic focus would report a false failure for any ring bound to it.
    // A fixed number of Tab presses rather than de-duplicating stops: two
    // unlabelled inputs are indistinguishable from the outside, and checking the
    // same control twice costs nothing.
    let stops = 0
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press('Tab')
      // Button carries `transition-all`, so its ring fades in over ~150ms. Reading
      // the computed box-shadow immediately catches the transparent start of that
      // transition and reports a false failure.
      await page.waitForTimeout(250)
      const probe = await page.evaluate(focusProbe)
      // Tabbing can leave the dialog (browser chrome); only judge stops inside it.
      const stop = probe?.inDialog ? probe : null
      if (!stop) continue
      stops++
      expect(
        stop.outlined || stop.ringed,
        `${stop.id} inside the dialog paints no focus indicator at all`,
      ).toBe(true)
      expect(
        stop.contrast ?? 0,
        `${stop.id} inside the dialog paints its focus indicator at ${stop.contrast?.toFixed(2) ?? 'an unmeasurable'} contrast — 1.4.11 wants ${FOCUS_INDICATOR_MIN_CONTRAST}:1`,
      ).toBeGreaterThanOrEqual(FOCUS_INDICATOR_MIN_CONTRAST)
    }

    // Guard against the loop silently finding nothing to check.
    expect(stops, 'expected focusable controls inside the dialog').toBeGreaterThan(2)
  })

  test('accessible names follow the document language', async ({ page }) => {
    await page.goto('/admin/categories')
    // Switch the UI to German, then check that the names assistive tech reads
    // are German too — they used to be hardcoded English inside a lang="de"
    // document, which is what WCAG 3.1.2 is about.
    await page.context().addCookies([
      { name: 'lang', value: 'de', url: page.url() },
    ])
    await page.reload()

    await expect(page.locator('html')).toHaveAttribute('lang', 'de')
    await expect(page.locator('a[href="#main"]')).toHaveText(/Zum Inhalt springen/i)
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(/Kategorien/i)

    await page.getByRole('button', { name: /kategorie hinzufügen|add category/i }).first().click()
    await expect(page.locator('dialog[open]')).toBeVisible()
    await expect(page.locator('dialog[open] button[aria-label]').first()).toHaveAttribute(
      'aria-label',
      'Schließen',
    )
  })

  /*
   * The check above proves the point for three elements on one page —
   * /admin/categories, which #186 picked because it was the worst offender in
   * the app at 22 untranslated strings, and which it only ever scanned in
   * English before that fix. Neither limit was load-bearing: a hard-coded
   * string can go untranslated on any page, and #186 fixed /admin, not just
   * /admin/categories. Widened here to more elements — every nav link, the
   * skip link, the h1 and the language toggle — and to the same four pages
   * the focus-indicator sweep above already visits, which keeps the runtime
   * bounded without scanning all 23 authenticated pages twice (#298).
   */
  test('accessible names follow the document language on more than one page', async ({ page }) => {
    const PAGES = ['/admin/categories', '/catalog', '/', '/orders']

    // Words this app deliberately leaves exactly as English spells them,
    // because German spells them the same way too. admin/page.test.tsx had to
    // allow exactly one of these ("Branding") for the same reason (#186) — a
    // byte-identical string that is NOT on this list is a real untranslated
    // string, not a coincidence of the language.
    const IDENTICAL_IN_GERMAN = new Set(['Audit'])

    // Nav hrefs are language-independent, so they make a stable key to compare
    // the English and German harvests by. The account menu is deliberately
    // left out: its text is the signed-in user's own name, which is data, not
    // a translated string, and comparing it would fail for the wrong reason.
    const harvest = () => {
      const clean = (s: string | null | undefined) => (s ?? '').trim().replace(/\s+/g, ' ')
      const named = (el: Element) => clean(el.getAttribute('aria-label')) || clean(el.textContent)
      const out: Record<string, string> = {}
      document.querySelectorAll('nav a').forEach((a) => {
        out[`nav link → ${a.getAttribute('href')}`] = named(a)
      })
      const skip = document.querySelector('a[href="#main"]')
      if (skip) out['skip link'] = named(skip)
      const h1 = document.querySelector('main h1')
      if (h1) out['h1'] = named(h1)
      const langToggle = document.querySelector('button[aria-expanded]')
      if (langToggle) out['language toggle'] = named(langToggle)
      return out
    }

    for (const path of PAGES) {
      // Set explicitly rather than cleared: `clearCookies()` also throws away
      // the root session this describe block's tests are signed in with, so
      // the "English" load after the first iteration was actually the login
      // page — which has no nav, no h1 and no language toggle, and is why the
      // very first version of this test failed with "nothing harvested" on
      // the FIRST page too (the setup project's cookies are not this test's
      // own). `getLang` treats an explicit 'en' exactly like no cookie at all.
      // The SAME url both times, and not `page.url()` for the second one: a
      // cookie added against `/admin/categories` gets path `/admin/`, which
      // does not replace the `path: '/'` cookie from the first call — the
      // browser then holds TWO `lang` cookies and sends both, and whichever
      // one the server's cookie parser prefers wins regardless of which this
      // test just set. The first version of this test set 'de' that way and
      // could not reproduce a failure locally: `html[lang]` stayed 'en' no
      // matter what value was requested, because it was reading the shadowed
      // cookie, not the new one.
      const baseURL = test.info().project.use.baseURL!
      await page.context().addCookies([{ name: 'lang', value: 'en', url: baseURL }])
      await page.goto(path)
      await settled(page, path)
      const en = await page.evaluate(harvest)
      expect(Object.keys(en).length, `${path} — nothing harvested to compare; the selectors may have gone stale`).toBeGreaterThan(3)

      await page.context().addCookies([{ name: 'lang', value: 'de', url: baseURL }])
      await page.reload()
      await settled(page, `${path} (de)`)
      await expect(page.locator('html')).toHaveAttribute('lang', 'de')
      const de = await page.evaluate(harvest)

      for (const [where, text] of Object.entries(en)) {
        if (!text || IDENTICAL_IN_GERMAN.has(text)) continue
        expect(de[where], `${path} — "${where}" reads "${text}" in German too`).not.toBe(text)
      }
    }
  })

  test('the current page is exposed to assistive tech, not signalled by colour alone', async ({ page }) => {
    await page.goto('/catalog')
    const current = page.locator('nav a[aria-current="page"]')
    await expect(current).toHaveCount(1)
    await expect(current).toHaveAttribute('href', '/catalog')
  })

  /*
   * The same defect as the test above, everywhere the nav-only check cannot
   * see it. #186's second defect was never in the nav — the check above only
   * ever proved the nav was fine. It was here: a category picked in the
   * catalogue sidebar or the mobile pills, and a language picked in the
   * header menu, all painted with `style.backgroundColor` alone and nothing
   * an assistive technology can query (#298).
   */
  test('a selection carried only by colour is exposed to assistive tech beyond the top nav', async ({ page }) => {
    await page.goto('/catalog')
    await settled(page, '/catalog')

    const GROUPS: [string, string, string][] = [
      // The desktop sidebar's <ul> and the `md:hidden` mobile pills both
      // render the same category list from the same state, so both need
      // their own check — a fix applied to only one of them still leaves
      // the other broken for whichever viewport shows it.
      ['catalogue sidebar', 'aside ul', 'button'],
      ['mobile category pills', 'div.md\\:hidden', 'button'],
    ]
    for (const [label, container, item] of GROUPS) {
      const { offenders, painted } = await page.evaluate(colourOnlySelection, { container, item })
      expect(painted, `${label} on /catalog — no colour-painted control found; the selector may have gone stale`).toBeGreaterThan(0)
      expect(offenders, `${label} on /catalog:\n  ${offenders.join('\n  ')}`).toEqual([])
    }

    // The language menu's options only exist in the DOM once it is opened.
    await page.getByRole('button', { name: /language/i }).click()
    const { offenders, painted } = await page.evaluate(colourOnlySelection, { container: '.grid-cols-3', item: 'button' })
    expect(painted, 'language menu on /catalog — no colour-painted option found; the selector may have gone stale').toBeGreaterThan(0)
    expect(offenders, `language menu on /catalog:\n  ${offenders.join('\n  ')}`).toEqual([])
  })

  test('reduced-motion is honoured', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.goto('/orders')

    // Assert the element EXISTS before judging it: the previous version swallowed
    // a missing locator into a default of '0s' and passed while checking nothing.
    const animated = page.locator('main [class*="animate-"]').first()
    await expect(animated, 'expected an animated element to test against').toHaveCount(1)

    const duration = await animated.evaluate((n) => getComputedStyle(n).animationDuration)
    expect(parseFloat(duration), `animation-duration was ${duration}`).toBeLessThan(0.05)

    // And confirm the same element really does animate without the preference,
    // so this cannot pass just because nothing was animated in the first place.
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await page.goto('/orders')
    const normal = await page
      .locator('main [class*="animate-"]')
      .first()
      .evaluate((n) => getComputedStyle(n).animationDuration)
    expect(parseFloat(normal), `expected a real animation without the preference, got ${normal}`).toBeGreaterThan(0.05)
  })

  /*
   * The probe `expectAccessible` runs on every page is only worth anything if it
   * finds the markers. This is the half that cannot pass by finding nothing:
   * /admin/products/new renders two of them — the category Select and the name
   * Input — so if fewer than two come back, the probe has stopped matching and
   * the per-page check above has been green over an empty list. That is the
   * failure mode this whole file exists to avoid.
   *
   * The ratios are asserted here too, with the numbers named, so a failure says
   * which colour regressed rather than only that something did.
   */
  test('the required-field marker is found and measured (1.4.3)', async ({ page }) => {
    await page.goto('/admin/products/new')
    await settled(page, '/admin/products/new')

    const markers = (await page.evaluate(glyphContrast)).filter((g) => g.text === '*')
    expect(
      markers.length,
      'the required-field markers on /admin/products/new were not found — the probe has stopped matching them',
    ).toBeGreaterThanOrEqual(2)

    for (const m of markers) {
      expect(m.ratio, `the required marker is ${m.ratio}:1, needs ${m.needs}:1 — ${m.where}`).toBeGreaterThanOrEqual(
        m.needs,
      )
    }
  })

  /*
   * That the 30 best-practice rules are actually being evaluated, and not merely
   * named in a tag array that axe no longer matches.
   *
   * Worth a test of its own because the failure mode is silence: drop
   * 'best-practice' from WCAG, or let axe retag a rule, and the gate goes on
   * passing while checking thirty fewer things. That is the state this file was
   * in before #185, and nothing in it said so.
   *
   * Every rule axe runs lands in exactly one of the four buckets — a rule that
   * matched no element is `inapplicable`, not absent — so the union of the four
   * is the list of rules that ran.
   */
  test('the gate asks axe for the best-practice rules', async ({ page }) => {
    await page.goto('/admin/categories')
    await settled(page, '/admin/categories')

    const results = await new AxeBuilder({ page }).withTags(WCAG).disableRules(RULES_OUT_OF_SCOPE).analyze()
    const ran = new Set(
      [...results.violations, ...results.passes, ...results.incomplete, ...results.inapplicable].map((r) => r.id),
    )

    // Not all thirty: a list of ids is a list to maintain. These are the ones
    // the audit named, and between them they cover every category the tag adds
    // — headings, landmarks, tables, keyboard order.
    const EXPECTED = [
      'heading-order',
      'page-has-heading-one',
      'empty-heading',
      'empty-table-header',
      'region',
      'landmark-one-main',
      'landmark-unique',
      'landmark-no-duplicate-main',
      'skip-link',
      'tabindex',
    ]
    expect(EXPECTED.filter((id) => !ran.has(id)), 'best-practice rules that axe did not run').toEqual([])

    // And the WCAG side is still there: adding a tag must not have replaced one.
    expect(ran.has('color-contrast'), 'color-contrast should still be running').toBe(true)
    // The one rule this suite switches off really is off, so RULES_OUT_OF_SCOPE
    // is doing something rather than listing a rule that was never requested.
    expect(ran.has('color-contrast-enhanced'), 'color-contrast-enhanced is out of scope').toBe(false)
  })
})

/**
 * Detail pages, which AUTHED_PAGES cannot cover because their URLs contain an id.
 *
 * This gap is why an anchor wrapping a button reached the infrastructure detail
 * page unnoticed: every list page was scanned, and none of the pages you reach
 * FROM them was. Each test walks in from the list and skips when the database has
 * nothing to walk to, so an empty environment reports "skipped" rather than a pass
 * over a page that never rendered.
 */
test.describe('Accessibility — detail pages', () => {
  // t('breadcrumb', 'en'). The saved session carries no lang cookie, so these
  // pages render in English.
  // Located structurally, NOT by the English label. `getLang()` falls back to the
  // Accept-Language header when no cookie is set, so a runner negotiating any
  // other locale would translate the aria-label out from under a hard-coded
  // selector — and the test would fail for a language setting rather than for an
  // accessibility problem. Any labelled nav inside main is the trail; there is
  // only one.

  /*
   * `route` is the Next.js route PATTERN, and it is what makes this block
   * visible to the policy gate (#223).
   *
   * `page_is_in_the_a11y_gate` reads the path arrays out of this file and
   * compares them to the file tree. It could see PUBLIC_PAGES and AUTHED_PAGES;
   * it could not see this list, because the strings in it were the pages these
   * scans START from — `/orders`, already covered as a static route — and never
   * the detail page they end on. So all five detail views were scanned and the
   * gate still reported them as unreachable, and warned about them on every run.
   *
   * Naming the pattern costs one field and turns the warning into a deny: a
   * sixth detail page now fails the gate the way a sixth static one already
   * does. The URL is still resolved at run time from the list, because an id in
   * a fixture goes stale the first time somebody reseeds.
   */
  const DETAIL_PAGES = [
    '/infrastructure/[id]',
    '/orders/[id]',
    '/catalog/[id]',
    '/projects/[id]',
    // The one this list was missing, and the one with the most form controls on
    // it (issue #102).
    '/admin/products/[id]',
  ]

  const DETAIL_FIXTURES: Record<string, { from: string; link: string; name: string }> = {
    '/infrastructure/[id]': { from: '/infrastructure', link: 'a[href^="/infrastructure/"]', name: 'an infrastructure element' },
    '/orders/[id]': { from: '/orders', link: 'a[href^="/orders/"]', name: 'an order' },
    '/catalog/[id]': { from: '/catalog', link: 'a[href^="/catalog/"]', name: 'a product' },
    '/projects/[id]': { from: '/projects', link: 'a[href^="/projects/"]', name: 'a project' },
    // Excluding /new, which is the first such link on the page and is covered as
    // a static route in AUTHED_PAGES.
    '/admin/products/[id]': {
      from: '/admin/products',
      link: 'a[href^="/admin/products/"]:not([href$="/new"])',
      name: 'a product in the admin area',
    },
  }

  for (const route of DETAIL_PAGES) {
    const { from, link, name } = DETAIL_FIXTURES[route]

    test(`${name} is clean, and says where it is`, async ({ page }) => {
      /*
       * Two page loads and an axe run, against `next dev`, which compiles a
       * route the first time it is requested. Every other scan in this file
       * pays that once; these pay it twice, for the list and then the detail
       * page. Inside the full suite the list pages are already warm and 30s is
       * enough — run this block on its own and the first of each pair is not,
       * which reads as a flaky accessibility failure rather than a cold cache.
       */
      test.slow()
      await page.goto(from)
      const first = page.locator(`main ${link}`).first()
      // Wait before concluding there is nothing to open: the catalogue fetches its
      // products after hydration, so counting immediately after goto() skipped a
      // page that was about to render.
      await first.waitFor({ state: 'attached', timeout: 15000 }).catch(() => {})
      /*
       * A failure, not a skip (#223). The e2e database is seeded since #285 —
       * a product, a project, three orders and two infrastructure elements —
       * so every one of these is reachable, and the accessibility skip budget
       * for this spec is zero. A scan that quietly did not happen is the exact
       * shape #223 is about: 25 of 30 pages covered, reported as green.
       */
      expect(
        await first.count(),
        `nothing on ${from} to open, so ${route} went unscanned — seed the demo data (make db-seed-demo)`,
      ).toBeGreaterThan(0)

      /*
       * Navigated by URL, not by clicking.
       *
       * These are Next.js `<Link>`s: the click only navigates once React has
       * hydrated, and Playwright's actionability checks are satisfied by the
       * server-rendered anchor long before that. So the click landed on an inert
       * element, nothing happened, and `toHaveURL` timed out — a hydration race,
       * reported as an accessibility failure.
       *
       * Reading the href and going there keeps what this test is for: it still
       * proves the list links point at a real detail page, and it is the detail
       * page's accessibility that is being scanned. Whether a Link hydrates is a
       * different test's job.
       */
      const href = await first.getAttribute('href')
      expect(href, `${from} has a ${link} with no href`).toBeTruthy()
      await page.goto(href!)
      await expect(page).toHaveURL(new RegExp(`${from}/`), { timeout: 30000 })
      // Wait for the page's own content, not just the URL: scanning a shell that
      // is still streaming in would pass for the wrong reason.
      await expect(page.locator('main h1')).toBeVisible({ timeout: 30000 })

      await expectAccessible(page, `${from} → detail`)

      // 2.4.8 Location. Every one of these pages is reached FROM a list, and only
      // the product page used to say so — with an ad-hoc <nav> named "Catalog",
      // which reads as a second navigation landmark rather than a location. The
      // last crumb is the assertion that matters: a trail whose final item is not
      // marked as the current page states a path, not a position.
      const trail = page.locator('main nav[aria-label] ol')
      await expect(trail, 'expected a breadcrumb trail (WCAG 2.4.8)').toBeVisible()
      await expect(trail.locator('li')).not.toHaveCount(0)
      await expect(trail.locator('[aria-current="page"]')).toHaveCount(1)
    })
  }
})

/**
 * WCAG 2.5.5 Target Size (AAA) — 44x44 CSS px.
 *
 * Its own block because axe cannot do it. axe ships `target-size`, but that rule
 * is WCAG 2.2 AA (2.5.8) at 24px: passing it says nothing about 2.5.5. So this
 * measures the rendered boxes, which also means it catches a control that a
 * caller's `className` shrank after the primitive was fixed.
 *
 * Before this, `size="sm"` buttons were 28px, `md` 36px, text inputs 38px, the
 * modal close 28px and the toast dismiss 16px. The floor now lives in the
 * primitives (`Button`, `Input`, `Select`) so a new call site inherits it.
 *
 * What is NOT measured, and why, is in docs/guides/accessibility.md: content
 * links, native checkboxes and native file inputs.
 */
test.describe('Accessibility — target size (2.5.5)', () => {
  // A spread rather than every route: these six between them render the whole
  // control vocabulary — the chrome, the catalogue's own filter buttons, a table
  // with row actions, a dense admin form, and the colour pickers.
  const PAGES = ['/', '/catalog', '/orders', '/infrastructure', '/admin/products', '/admin/branding']

  for (const path of PAGES) {
    test(`every control on ${path} is at least 44x44`, async ({ page }) => {
      await page.goto(path)
      await expect(page.locator('main h1, main h2').first()).toBeVisible({ timeout: 30000 })

      const undersized = await page.evaluate(undersizedControls, TARGET_MIN)
      expect(undersized, `${path}:\n  ${undersized.join('\n  ')}`).toEqual([])
    })
  }

  test('the controls inside a dialog are targets too', async ({ page }) => {
    // Most of this app's form controls only exist while a modal is open, so a
    // closed-page sweep would miss the majority of them — the same blind spot the
    // dialog scans above exist for.
    await page.goto('/admin/categories')
    await page.getByRole('button', { name: /add category/i }).first().click()
    await expect(page.locator('dialog[open]')).toBeVisible()

    // Wait for the entrance animation to land before measuring. `modal-in` runs
    // scale(0.95) → scale(1) over 200ms (globals.css), and getBoundingClientRect
    // reports the TRANSFORMED box — so a 44px control inside the dialog measures
    // 42.7 while the animation is still in flight, and this test failed on the
    // close button, both inputs, Cancel and Save for a reason that has nothing to
    // do with their size. Awaiting the animations rather than sleeping a guessed
    // number of milliseconds: the wait then cannot be too short on a loaded runner.
    await page
      .locator('dialog[open]')
      .evaluate((d) => Promise.all(d.getAnimations({ subtree: true }).map((a) => a.finished)))

    const undersized = await page.evaluate(undersizedControls, TARGET_MIN)
    expect(undersized, `add-category dialog:\n  ${undersized.join('\n  ')}`).toEqual([])
  })
})

/**
 * The AAA criteria that are asserted rather than excluded, and that no rule covers.
 *
 * Each of these is one clause of a criterion this app does NOT claim in full — see
 * docs/guides/accessibility.md for what the rest of 1.4.8 would need. Asserting
 * the reachable clause is still worth it: it is the part that regresses silently.
 */
test.describe('Accessibility — AAA clauses with no axe rule', () => {
  test('no block of text is justified (1.4.8)', async ({ page }) => {
    // Justified text opens rivers of white space down a paragraph, which is the
    // one part of 1.4.8 that is both free and easy to reintroduce with a stray
    // `text-justify`.
    await page.goto('/catalog')
    const justified = await page.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLElement>('main p, main li, main dd, main td'))
        .filter((el) => getComputedStyle(el).textAlign === 'justify')
        .map((el) => `${el.tagName.toLowerCase()}.${el.className}`),
    )
    expect(justified, `justified text found:\n  ${justified.join('\n  ')}`).toEqual([])
  })

  test('the breadcrumb trail is a list, and only its last item is the current page (2.4.8)', async ({ page }) => {
    // /admin/products/new is the deepest static route, so it is the one that
    // proves a multi-level trail rather than a two-item one — and unlike the
    // detail pages it needs no seed data, so this clause is checked even in an
    // empty environment.
    await page.goto('/admin/products/new')
    // Structural, not the English label — see the note on the other trail locator.
    const trail = page.locator('main nav[aria-label] ol')
    await expect(trail).toBeVisible()
    await expect(trail.locator('> li')).toHaveCount(3)
    await expect(trail.locator('[aria-current="page"]')).toHaveCount(1)
    // The current page is not a link: there is nowhere to go.
    await expect(trail.locator('a[aria-current="page"]')).toHaveCount(0)
    // And the separators are not read out as words.
    await expect(trail.locator('span[aria-hidden="true"]')).toHaveCount(2)
  })
})
