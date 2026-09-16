import { describe, it, expect, vi, beforeAll } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ProductGallery } from './ProductGallery'

// jsdom does not implement the native <dialog> methods the zoom relies on.
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
    this.open = true
  })
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
    this.open = false
  })
})

const images = [
  { id: 11, alt: 'The front of the gateway' },
  { id: 12, alt: 'The gateway dashboard' },
  { id: 13, alt: 'The rack it lives in' },
]

const shown = () => document.querySelector('.object-contain') as HTMLImageElement | null

describe('ProductGallery', () => {
  it('leads with the first picture, described by its own alt text', () => {
    render(<ProductGallery productId={7} images={images} lang="en" />)

    const main = screen.getByRole('img', { name: 'The front of the gateway' })
    expect(main.getAttribute('src')).toContain('/api/catalog/7/images/11')
  })

  it('gives every thumbnail the picture\'s description as its accessible name', () => {
    // Not "button, button, button": a thumbnail strip is only navigable if each
    // one says what it is.
    render(<ProductGallery productId={7} images={images} lang="en" />)

    for (const image of images) {
      expect(screen.getByRole('button', { name: image.alt })).toBeInTheDocument()
    }
  })

  it('marks the thumbnail of the picture on show as the current one', async () => {
    const user = userEvent.setup()
    render(<ProductGallery productId={7} images={images} lang="en" />)

    expect(screen.getByRole('button', { name: images[0].alt })).toHaveAttribute('aria-current', 'true')

    await user.click(screen.getByRole('button', { name: images[2].alt }))

    expect(screen.getByRole('button', { name: images[2].alt })).toHaveAttribute('aria-current', 'true')
    expect(screen.getByRole('button', { name: images[0].alt })).not.toHaveAttribute('aria-current')
    expect(shown()?.getAttribute('src')).toContain('/images/13')
  })

  it('steps forwards and backwards with named buttons, wrapping round', async () => {
    const user = userEvent.setup()
    render(<ProductGallery productId={7} images={images} lang="en" />)

    await user.click(screen.getByRole('button', { name: /next image/i }))
    expect(shown()?.getAttribute('src')).toContain('/images/12')

    await user.click(screen.getByRole('button', { name: /previous image/i }))
    expect(shown()?.getAttribute('src')).toContain('/images/11')

    // Wrapping means the controls never dead-end, so neither has to be disabled.
    await user.click(screen.getByRole('button', { name: /previous image/i }))
    expect(shown()?.getAttribute('src')).toContain('/images/13')
  })

  it('steps with the arrow keys, which is what a keyboard user tries first', async () => {
    const user = userEvent.setup()
    render(<ProductGallery productId={7} images={images} lang="en" />)

    await user.click(screen.getByRole('button', { name: images[0].alt }))
    await user.keyboard('{ArrowRight}')
    expect(shown()?.getAttribute('src')).toContain('/images/12')

    await user.keyboard('{ArrowLeft}')
    expect(shown()?.getAttribute('src')).toContain('/images/11')
  })

  it('opens the zoom from the keyboard and closes it again', async () => {
    // The zoom has to be reachable by tabbing to a real button and escapable
    // without a mouse; the native <dialog> is what gives Escape for free.
    const user = userEvent.setup()
    render(<ProductGallery productId={7} images={images} lang="en" />)

    const enlarge = screen.getByRole('button', { name: /enlarge image/i })
    enlarge.focus()
    await user.keyboard('{Enter}')

    const dialog = document.querySelector('dialog')
    expect(dialog?.open).toBe(true)
    // The enlarged picture keeps the description its uploader wrote.
    expect(screen.getAllByRole('img', { name: 'The front of the gateway' }).length).toBeGreaterThan(0)

    await user.click(screen.getByRole('button', { name: /close/i }))
    expect(dialog?.open).toBe(false)
  })

  it('zooms whichever picture is on show, not always the first', async () => {
    const user = userEvent.setup()
    render(<ProductGallery productId={7} images={images} lang="en" />)

    await user.click(screen.getByRole('button', { name: images[1].alt }))
    await user.click(screen.getByRole('button', { name: /enlarge image/i }))

    const zoomed = document.querySelector('dialog img') as HTMLImageElement | null
    expect(zoomed?.getAttribute('src')).toContain('/images/12')
    expect(zoomed?.getAttribute('alt')).toBe('The gateway dashboard')
  })

  it('falls back to the placeholder when the enlarged picture will not load', async () => {
    // The modal used to render a bare <img>, so a picture the gallery had already
    // replaced with the placeholder came back as the browser's broken-image icon
    // the moment it was enlarged.
    const user = userEvent.setup()
    render(<ProductGallery productId={7} images={images} lang="en" />)

    await user.click(screen.getByRole('button', { name: /enlarge image/i }))
    const zoomed = document.querySelector('dialog img') as HTMLImageElement
    fireEvent.error(zoomed)

    expect(document.querySelector('dialog img')).toBeNull()
    expect(document.querySelector('dialog svg.opacity-25')).not.toBeNull()
  })

  it('opens straight to the placeholder for a picture that already failed in the gallery', async () => {
    const user = userEvent.setup()
    render(<ProductGallery productId={7} images={images} lang="en" />)

    fireEvent.error(shown() as HTMLImageElement)
    await user.click(screen.getByRole('button', { name: /enlarge image/i }))

    expect(document.querySelector('dialog img')).toBeNull()
    expect(document.querySelector('dialog svg.opacity-25')).not.toBeNull()
  })

  it('has no thumbnails or stepper for a single picture', () => {
    render(<ProductGallery productId={7} images={[images[0]]} lang="en" />)

    expect(screen.queryByRole('button', { name: /next image/i })).not.toBeInTheDocument()
    // The only remaining button is the enlarge control.
    expect(screen.getAllByRole('button')).toHaveLength(1)
  })

  it('shows the placeholder, and no broken controls, for a product with no pictures', () => {
    render(<ProductGallery productId={7} images={[]} lang="en" />)

    expect(screen.queryAllByRole('button')).toHaveLength(0)
    expect(document.querySelector('img')).toBeNull()
    expect(document.querySelector('svg')).toBeInTheDocument()
  })

  it('does not leave the selection pointing past a shortened gallery', () => {
    // The page re-renders with new props and this component does not remount, so
    // an index chosen against the old list survives into the new one (#450).
    const { rerender } = render(<ProductGallery productId={1} images={images} lang="en" />)
    fireEvent.click(screen.getByRole('button', { name: /next/i }))
    fireEvent.click(screen.getByRole('button', { name: /next/i }))
    expect(shown()?.getAttribute('alt')).toBe('The rack it lives in')

    rerender(<ProductGallery productId={1} images={images.slice(0, 2)} lang="en" />)
    expect(shown()?.getAttribute('alt')).toBe('The front of the gateway')
  })

  it('keeps the selection when the gallery is replaced by one just as long', () => {
    // Only an out-of-range index is corrected: resetting on every change would
    // throw away the picture the reader had chosen.
    const { rerender } = render(<ProductGallery productId={1} images={images} lang="en" />)
    fireEvent.click(screen.getByRole('button', { name: /next/i }))
    expect(shown()?.getAttribute('alt')).toBe('The gateway dashboard')

    rerender(<ProductGallery productId={1} images={[...images]} lang="en" />)
    expect(shown()?.getAttribute('alt')).toBe('The gateway dashboard')
  })
})
