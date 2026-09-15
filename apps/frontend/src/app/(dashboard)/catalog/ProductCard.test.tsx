import { describe, it, expect, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ProductCard } from './ProductCard'

vi.mock('@/components/ui/ProductImage', () => ({
  // A stub for the real ProductImage; nothing here is served to a browser.
  // eslint-disable-next-line @next/next/no-img-element
  ProductImage: ({ alt }: { alt: string }) => <img alt={alt} src="/stub.png" />,
}))

/**
 * One catalogue tile, which had no test at all.
 *
 * Almost every decision in this file is an accessibility one the code comments
 * argue for at length — the heading level, the two links that must not nest, the
 * "Details" label that has to say what it opens. None of them was asserted, so
 * any of them could be undone without a test noticing.
 */
const renderCard = (over?: Partial<Parameters<typeof ProductCard>[0]>) => {
  const onToggleFavorite = vi.fn()
  const result = render(
    <ProductCard
      id={7}
      name="Managed Postgres"
      description="A database, managed"
      favorited={false}
      onToggleFavorite={onToggleFavorite}
      lang="en"
      {...over}
    />,
  )
  return { ...result, onToggleFavorite }
}

describe('what the card says', () => {
  it('shows the name, the description and the category', () => {
    renderCard({ categoryName: 'Databases' })
    expect(screen.getByText('Managed Postgres')).toBeInTheDocument()
    expect(screen.getByText('A database, managed')).toBeInTheDocument()
    expect(screen.getByText('Databases')).toBeInTheDocument()
  })

  it('omits the category strip entirely when there is none', () => {
    /*
     * Asserted structurally, not by its text.
     * `queryByText('Databases')` passes whether the strip is absent OR present
     * and empty — which is exactly what the `categoryName &&` guard becomes when
     * it is broken. Counting the element is what tells those two apart, and the
     * mutation run is what showed the text assertion did not.
     */
    const { container } = renderCard()
    expect(container.querySelectorAll('span.uppercase')).toHaveLength(0)
  })

  it('renders exactly one category strip when there is one', () => {
    const { container } = renderCard({ categoryName: 'Databases' })
    expect(container.querySelectorAll('span.uppercase')).toHaveLength(1)
  })

  it('omits the description paragraph when it is empty', () => {
    // An empty <p> still takes vertical space and pushes the button off the grid.
    const { container } = renderCard({ description: '' })
    expect(container.querySelector('p')).toBeNull()
  })
})

describe('the heading level is a prop, because the two grids sit at different depths', () => {
  it('defaults to h3, under the main grid’s h2', () => {
    renderCard()
    expect(screen.getByRole('heading', { level: 3, name: 'Managed Postgres' })).toBeInTheDocument()
  })

  it('renders an h2 when the card hangs straight off the page heading', () => {
    // A fixed h3 was an h1 → h3 skip the moment /catalog got an h1 (#185).
    renderCard({ level: 2 })
    expect(screen.getByRole('heading', { level: 2, name: 'Managed Postgres' })).toBeInTheDocument()
  })
})

describe('the two links', () => {
  it('both point at the product page', () => {
    renderCard()
    const links = screen.getAllByRole('link')
    /*
     * The COUNT matters as much as the hrefs.
     * An <a> with no href has no link role at all, so an empty href drops out of
     * `getAllByRole` entirely and a loop over what is left passes without ever
     * seeing the broken one.
     */
    expect(links).toHaveLength(2)
    for (const link of links) {
      expect(link).toHaveAttribute('href', '/catalog/7')
    }
  })

  it('names the picture link for the product, since a placeholder has no alt to borrow', () => {
    renderCard()
    expect(screen.getByRole('link', { name: 'Managed Postgres' })).toBeInTheDocument()
  })

  it('says what "Details" opens, for anyone reading links out of context', () => {
    // WCAG 2.4.9: a grid of twenty links all called "Details" names nothing. The
    // product goes in the accessible name only — and "Details" stays the visible
    // label, so the accessible name remains a superset of it (2.5.3).
    renderCard()
    const details = screen.getByRole('link', { name: /details: Managed Postgres/i })
    expect(within(details).getByText('Details')).toBeInTheDocument()
  })
})

describe('the favourite control', () => {
  it('is a sibling of the picture link, never nested inside it', () => {
    // A button inside a link is invalid HTML and splits one control in two. The
    // axe gate does not reject it, so this is the only thing that would.
    renderCard()
    const button = screen.getByRole('button')
    expect(button.closest('a')).toBeNull()
  })

  it('reports a toggle to the parent rather than deciding anything itself', async () => {
    const user = userEvent.setup()
    const { onToggleFavorite } = renderCard()
    await user.click(screen.getByRole('button'))
    expect(onToggleFavorite).toHaveBeenCalledTimes(1)
  })

  it('passes the favourited state down', () => {
    renderCard({ favorited: true })
    expect(screen.getByRole('button').getAttribute('aria-pressed')).toBe('true')
  })
})

describe('the picture', () => {
  it('uses the uploader’s own description when there is one', () => {
    renderCard({ imageAlt: 'A blue elephant' })
    expect(screen.getByAltText('A blue elephant')).toBeInTheDocument()
  })

  it('falls back to the product name when there is not', () => {
    renderCard({ imageAlt: null })
    expect(screen.getByAltText('Managed Postgres')).toBeInTheDocument()
  })
})
