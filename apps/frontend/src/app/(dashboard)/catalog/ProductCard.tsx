'use client'

import Link from 'next/link'
import { t } from '@/lib/i18n'
import { FavoriteButton } from './FavoriteButton'
import { ProductImage } from '@/components/ui/ProductImage'

interface Props {
  id: number
  name: string
  description: string
  /** The picture's own description; falls back to the product name. */
  imageAlt?: string | null
  categoryName?: string
  favorited: boolean
  busy?: boolean
  onToggleFavorite: () => void
  lang: string
  /**
   * Where this card's title sits in the page outline.
   *
   * The two grids on /catalog are at different depths: the main one hangs
   * straight off the page's <h1>, the favourites shelf off its own <h2>. A
   * fixed <h3> was fine while the page had no h1 at all, and became an
   * h1 → h3 skip the moment it got one (#185). Only the level differs — the
   * card still renders identically, which is the point of the component.
   */
  level?: 2 | 3
}

/**
 * One catalogue product tile.
 *
 * Extracted from the catalogue page so the "My Favorites" section and the main
 * grid render identical cards — a favourite that looked different from the same
 * product below it would read as a different thing.
 */
export function ProductCard({
  id,
  name,
  description,
  imageAlt,
  categoryName,
  favorited,
  busy,
  onToggleFavorite,
  lang,
  level = 3,
}: Props) {
  const Heading = `h${level}` as const
  return (
    <div
      data-testid={`product-card-${id}`}
      className="bg-white border border-slate-200 rounded-lg overflow-hidden flex flex-col hover:shadow-md transition-all"
      onMouseEnter={(e) => (e.currentTarget.style.borderColor = 'var(--bp)')}
      onMouseLeave={(e) => (e.currentTarget.style.borderColor = '')}
    >
      <div
        className="relative h-40 border-b border-slate-100"
        style={{ backgroundColor: 'color-mix(in srgb, var(--bp) 8%, white)' }}
      >
        {/* The picture is the obvious thing to click, so it is the link. Named for
            the product rather than left nameless: when the fallback placeholder
            renders there is no alt text for the link to borrow. */}
        <Link
          href={`/catalog/${id}`}
          aria-label={name}
          className="block h-full w-full p-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500"
        >
          <ProductImage productId={id} alt={imageAlt ?? name} />
        </Link>
        {/* A SIBLING of the link, not a child: a button inside a link is invalid
            HTML and splits one control in two. The axe gate does not reject it —
            see ButtonLink — so keeping them siblings is on the author. */}
        <div className="absolute top-2 right-2">
          <FavoriteButton favorited={favorited} busy={busy} onToggle={onToggleFavorite} lang={lang} />
        </div>
      </div>
      <div className="p-3 flex flex-col flex-1">
        {categoryName && (
          <span className="text-xs font-semibold uppercase tracking-wide mb-1" style={{ color: 'var(--bp-text)' }}>
            {categoryName}
          </span>
        )}
        <Heading className="font-semibold text-sm text-slate-800 leading-snug mb-1 line-clamp-2">{name}</Heading>
        {description && (
          <p className="text-xs text-slate-500 leading-relaxed flex-1 mb-3 line-clamp-2">{description}</p>
        )}
        {/* "Details", not "Place Order": it opens the product page, where the
            environment, the price and the parameters are chosen. Promising an order
            and delivering a form is a broken promise. */}
        <Link
          href={`/catalog/${id}`}
          className="w-full py-2 px-3 min-h-11 rounded text-center text-sm font-semibold flex items-center justify-center hover:brightness-95 transition-all mt-auto"
          // The ink is derived from the secondary, not fixed: `--bs` is whatever
          // the operator saved, and a hard-coded dark foreground goes unreadable
          // the moment they pick a dark one. `--bs-ink` is readableInk's answer
          // for that exact colour, which is what every other `--bs` surface uses.
          style={{ backgroundColor: 'var(--bs)', color: 'var(--bs-ink)' }}
        >
          {t('details', lang)}
          {/* A grid of twenty links all called "Details" is WCAG 2.4.9: read out of
              context, none of them says what it opens. The product name goes in the
              accessible name only — visibly repeating it under its own heading would
              be noise, and keeping "Details" as the visible label keeps the
              accessible name a superset of it (2.5.3 Label in Name). */}
          <span className="sr-only">: {name}</span>
        </Link>
      </div>
    </div>
  )
}
