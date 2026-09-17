import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'

let lang = 'en'

vi.mock('@/lib/auth', () => ({ auth: async () => ({ user: { role: 'root' } }) }))
vi.mock('@/lib/getLang', () => ({ getLang: async () => lang }))
vi.mock('next/navigation', () => ({ redirect: vi.fn() }))

import AdminPage from './page'

/** The title and description of every card, in DOM order. */
async function cardTexts(forLang: string): Promise<string[]> {
  lang = forLang
  const { container, unmount } = render(await AdminPage())
  const texts = [...container.querySelectorAll('a h2, a p')].map((el) => el.textContent ?? '')
  unmount()
  return texts
}

beforeEach(() => { lang = 'en' })

/**
 * The destinations were written out in English in a module-level array, where
 * nothing that looks at JSX could see them — so the gate stayed green while a
 * German root admin got a translated page heading over untranslated strings
 * (WCAG 3.1.2 — #186).
 *
 * The count is asserted so that adding a destination without translating it
 * fails here rather than on somebody's German portal. Deployment windows (#330)
 * made it twelve; the integration registry (#111) made it thirteen.
 */
describe('AdminPage', () => {
  it('offers thirteen destinations, each with a title and a description', async () => {
    render(await AdminPage())
    expect(screen.getAllByRole('link')).toHaveLength(13)
    expect(await cardTexts('en')).toHaveLength(26)
  })

  it('leaves no card written in English on a German page', async () => {
    const en = await cardTexts('en')
    const de = await cardTexts('de')

    // "Branding" is the same word in both — a loanword German uses unchanged,
    // not a literal that escaped the tables. Everything else has to move.
    expect(de.filter((text, i) => text === en[i])).toEqual(['Branding'])
  })

  it('says the same thing the destination itself says', async () => {
    // These are the titles and subtitles the linked pages already use, so the
    // dashboard and the page it opens do not describe the same screen two ways.
    lang = 'de'
    render(await AdminPage())

    expect(screen.getByRole('heading', { name: 'Deployment-Umgebungen' })).toBeInTheDocument()
    expect(screen.getByText('KI-Anbieter für Übersetzungen konfigurieren.')).toBeInTheDocument()
  })
})
