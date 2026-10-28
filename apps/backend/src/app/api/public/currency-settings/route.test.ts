import { describe, it, expect } from 'vitest'
import { eq } from 'drizzle-orm'
import { GET } from './route'
import { db } from '@/lib/db/client'
import { appConfig } from '@/lib/db/schema'

describe('GET /api/public/currency-settings', () => {
  it('returns EUR by default without requiring authentication', async () => {
    const res = await GET()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ baseCurrency: 'EUR' })
  })

  it('returns the configured base currency', async () => {
    await db.update(appConfig).set({ baseCurrency: 'USD' }).where(eq(appConfig.id, 1))

    const res = await GET()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ baseCurrency: 'USD' })
  })
})
