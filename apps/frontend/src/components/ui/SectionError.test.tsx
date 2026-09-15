import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { SectionError } from './SectionError'

describe('SectionError', () => {
  it('renders nothing when the section loaded', () => {
    const { container } = render(<SectionError error={null} lang="en" />)
    expect(container).toBeEmptyDOMElement()
  })

  it('says it in the reader’s language and keeps the technical reason as-is', () => {
    // Both halves asserted, because both are load-bearing and each was a
    // survivor when only one was: a missing sentence leaves a bare status code
    // in front of a user, and a translated status code is no use to anyone.
    render(<SectionError error="HTTP 502: Bad Gateway" lang="en" />)
    expect(screen.getByRole('alert')).toHaveTextContent(
      'An unexpected error occurred. Please try again. HTTP 502: Bad Gateway',
    )
  })

  it('translates the sentence and only the sentence', () => {
    render(<SectionError error="HTTP 502: Bad Gateway" lang="de" />)
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Ein unerwarteter Fehler ist aufgetreten. Bitte versuchen Sie es erneut. HTTP 502: Bad Gateway',
    )
  })

  it('is an assertive live region, because it can arrive after the page', () => {
    render(<SectionError error="HTTP 500: boom" lang="en" />)
    expect(screen.getByRole('alert')).toBeInTheDocument()
  })
})
