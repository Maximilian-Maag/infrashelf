import { describe, it, expect, beforeEach } from 'vitest'
import {
  getBranding,
  updateBranding,
  getBrandingLogo,
  updateBrandingLogo,
} from './branding'
import { db } from '@/lib/db/client'
import { auditLog } from '@/lib/db/schema'
import { eq, sql } from 'drizzle-orm'
import { createUser } from '@/test/helpers'

// The `branding` row with id=1 is seeded once in beforeAll, but the table is
// not in the TRUNCATE list — so the row persists across tests. Reset it here
// to keep tests isolated.
beforeEach(async () => {
  await db.execute(sql`
    UPDATE branding SET
      logo_data = NULL, logo_mime = NULL,
      primary_color = '#1e40af', secondary_color = '#3b82f6',
      shop_name = 'InfraShelf', shop_subtitle = '', imprint_text = ''
    WHERE id = 1
  `)
})

describe('getBranding', () => {
  it('returns the default seed values', async () => {
    const result = await getBranding()
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.primaryColor).toBe('#1e40af')
      expect(result.data.secondaryColor).toBe('#3b82f6')
      expect(result.data.shopName).toBe('InfraShelf')
      expect(result.data.shopSubtitle).toBe('')
      expect(result.data.imprintText).toBe('')
      expect(result.data.logoMime).toBeNull()
    }
  })
})

describe('updateBranding', () => {
  it('persists changes; getBranding reflects them', async () => {
    const updated = await updateBranding({
      primaryColor: '#000000',
      shopName: 'My Shop',
      imprintText: 'Imprint',
    })
    expect(updated.ok).toBe(true)

    const result = await getBranding()
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.primaryColor).toBe('#000000')
      expect(result.data.shopName).toBe('My Shop')
      expect(result.data.imprintText).toBe('Imprint')
    }
  })
})

describe('getBrandingLogo', () => {
  it('returns null when no logo set', async () => {
    const result = await getBrandingLogo()
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data).toBeNull()
  })
})

/** Enough of a PNG for the magic-byte check: the 8-byte signature plus padding. */
const pngBytes = (extra = 8) =>
  Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(extra)])

describe('updateBrandingLogo', () => {
  it('stores the buffer and the sniffed mime; getBrandingLogo returns them', async () => {
    const buf = pngBytes()
    const setRes = await updateBrandingLogo(buf)
    expect(setRes.ok).toBe(true)
    if (setRes.ok) expect(setRes.data.mime).toBe('image/png')

    const result = await getBrandingLogo()
    expect(result.ok).toBe(true)
    // Guarded, not skipped. `if (result.ok && result.data)` passed having asserted
    // nothing when the logo was NOT stored — the store losing it would look green
    // (#307).
    if (!result.ok) throw new Error(result.message)
    if (!result.data) throw new Error('the logo was stored but not returned')
    expect(Buffer.from(result.data.data).equals(buf)).toBe(true)
    expect(result.data.mime).toBe('image/png')
  })

  // Issue #143: the route took `file.type` on trust, stored it, and echoed it as
  // the Content-Type of an unauthenticated GET — stored XSS on the backend origin.
  it('refuses an HTML document with a 415, whatever it was declared as', async () => {
    const html = Buffer.from('<script>alert(document.domain)</script><!-- padding -->')
    const result = await updateBrandingLogo(html)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(415)

    // Nothing was stored, so the GET still has nothing to serve.
    const after = await getBrandingLogo()
    expect(after.ok).toBe(true)
    if (after.ok) expect(after.data).toBeNull()
  })

  it('refuses an SVG, which is a script-carrying document', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>')
    const result = await updateBrandingLogo(svg)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(415)
  })

  it('refuses an empty file with a 400', async () => {
    const result = await updateBrandingLogo(Buffer.alloc(0))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(400)
  })

  it('refuses anything over 10 MB with a 413', async () => {
    // A valid PNG header on an 11 MB body: the cap is about the size, not the type.
    const result = await updateBrandingLogo(pngBytes(11 * 1024 * 1024))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(413)
  })

  it('writes an audit entry naming the actor', async () => {
    const root = await createUser({ role: 'root' })
    const result = await updateBrandingLogo(pngBytes(), root.id)
    expect(result.ok).toBe(true)

    const rows = await db.select().from(auditLog).where(eq(auditLog.action, 'branding.logo_updated'))
    expect(rows.length).toBe(1)
    expect(rows[0].userId).toBe(root.id)
  })
})

describe('getBrandingLogo', () => {
  // Validating new writes does nothing for rows already in the table.
  it('clamps a legacy row whose stored mime is not an image type', async () => {
    await db.execute(sql`
      UPDATE branding SET logo_data = ${pngBytes()}, logo_mime = 'text/html' WHERE id = 1
    `)

    const result = await getBrandingLogo()
    expect(result.ok).toBe(true)
    // Not `&& result.data`: a dropped row would skip the only assertion (#307).
    if (!result.ok) throw new Error(result.message)
    if (!result.data) throw new Error('the legacy row was dropped rather than clamped')
    expect(result.data.mime).toBe('application/octet-stream')
  })
})
