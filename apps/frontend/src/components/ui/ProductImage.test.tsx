import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ProductImage } from './ProductImage'

describe('ProductImage', () => {
  it('uses the description it was given as the alt text', () => {
    render(<ProductImage productId={5} alt="Dashboard showing traffic graphs" />)
    expect(screen.getByRole('img', { name: 'Dashboard showing traffic graphs' })).toBeInTheDocument()
  })

  it('treats an empty description as decorative', () => {
    // Correct only where the same information is already in text beside it — a
    // cart row names the product the thumbnail belongs to.
    render(<ProductImage productId={5} alt="" />)
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
    expect(document.querySelector('img')).toHaveAttribute('alt', '')
  })

  it('requests the product image endpoint', () => {
    render(<ProductImage productId={42} alt="x" />)
    expect(document.querySelector('img')?.getAttribute('src')).toContain('/api/catalog/42/image')
  })

  it('gives a different picture a fresh chance after one failed', () => {
    // The flag is per URL, not per mount: the page re-renders with new props and
    // this component does not remount, so a product whose predecessor had no
    // image would otherwise keep showing the placeholder (#450).
    const { rerender } = render(<ProductImage productId={5} alt="first" />)
    fireEvent.error(document.querySelector('img') as HTMLImageElement)
    expect(document.querySelector('img')).toBeNull()

    rerender(<ProductImage productId={6} alt="second" />)
    expect(document.querySelector('img')?.getAttribute('src')).toContain('/api/catalog/6/image')
  })

  it('gives the SAME product a fresh chance once its image is replaced', () => {
    // A new `version` is a new URL, so the old failure says nothing about it.
    const { rerender } = render(<ProductImage productId={5} alt="x" />)
    fireEvent.error(document.querySelector('img') as HTMLImageElement)
    expect(document.querySelector('img')).toBeNull()

    rerender(<ProductImage productId={5} alt="x" version={2} />)
    expect(document.querySelector('img')?.getAttribute('src')).toContain('?v=2')
  })

  it('keeps showing the placeholder while nothing about the picture changed', () => {
    const { rerender } = render(<ProductImage productId={5} alt="x" />)
    fireEvent.error(document.querySelector('img') as HTMLImageElement)

    rerender(<ProductImage productId={5} alt="a different description" />)
    expect(document.querySelector('img')).toBeNull()
  })

  it('busts the cache when a version is given', () => {
    // The endpoint sets max-age=3600, so a replaced image needs a changed URL.
    render(<ProductImage productId={42} alt="x" version={3} />)
    expect(document.querySelector('img')?.getAttribute('src')).toContain('?v=3')
  })
})
