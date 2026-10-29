import { describe, it, expect } from 'vitest'
import {
  listCatalog,
  getProduct,
  getProductImage,
  getProductImageById,
  CATALOG_MAX_LIMIT,
  CATALOG_COUNT_CAP,
} from './catalog'
import { db } from '@/lib/db/client'
import {
  products,
  productTranslations,
  productEnvironments,
  parameters,
} from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import {
  createCategory,
  createProduct,
  createCiSource,
  createEnvironment,
  createProductImage,
  linkProductEnvironment,
} from '@/test/helpers'

describe('listCatalog', () => {
  it('returns products with translation in requested language', async () => {
    const cat = await createCategory()
    const product = await createProduct(cat.id, 'English Name')
    await db.insert(productTranslations).values({
      productId: product.id,
      languageCode: 'de',
      name: 'Deutscher Name',
      description: 'Beschreibung',
    })

    const result = await listCatalog('de')
    expect(result.ok).toBe(true)
    if (result.ok) {
      const row = result.data.items.find((r) => r.id === product.id)
      expect(row?.name).toBe('Deutscher Name')
      expect(row?.description).toBe('Beschreibung')
    }
  })

  it('falls back to English when requested language is not available', async () => {
    const cat = await createCategory()
    const product = await createProduct(cat.id, 'English Name')
    // only English translation exists from helper

    const result = await listCatalog('fr')
    expect(result.ok).toBe(true)
    if (result.ok) {
      const row = result.data.items.find((r) => r.id === product.id)
      expect(row?.name).toBe('English Name')
    }
  })

  it('case-insensitive substring search on name filters results', async () => {
    const cat = await createCategory()
    await createProduct(cat.id, 'Alpha Product')
    await createProduct(cat.id, 'Beta Service')

    const result = await listCatalog('en', { search: 'alpha' })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.items.length).toBe(1)
      expect(result.data.items[0].name).toBe('Alpha Product')
      expect(result.data.total).toBe(1)
    }
  })

  it('searches the description as well as the name', async () => {
    const cat = await createCategory()
    const product = await createProduct(cat.id, 'Nondescript')
    await db
      .update(productTranslations)
      .set({ description: 'Runs on a Kubernetes cluster' })
      .where(eq(productTranslations.productId, product.id))
    await createProduct(cat.id, 'Something Else')

    const result = await listCatalog('en', { search: 'kubernetes' })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.items.map((r) => r.id)).toEqual([product.id])
    }
  })

  it('treats % and _ in a search term as text, not wildcards', async () => {
    // Issue #91: the term is the user's own text. Unescaped, a search for "50%"
    // matched every product and one for "a_b" matched "axb".
    const cat = await createCategory()
    const discounted = await createProduct(cat.id, 'Reduced by 50% today')
    await createProduct(cat.id, 'Full price')

    const result = await listCatalog('en', { search: '50%' })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.items.map((r) => r.id)).toEqual([discounted.id])
    }

    const underscore = await listCatalog('en', { search: 'a_b' })
    expect(underscore.ok).toBe(true)
    if (underscore.ok) expect(underscore.data.items).toEqual([])
  })

  it('category filter restricts to that category', async () => {
    const cat1 = await createCategory('Cat 1')
    const cat2 = await createCategory('Cat 2')
    await createProduct(cat1.id, 'P1')
    await createProduct(cat2.id, 'P2')

    const result = await listCatalog('en', { categoryId: cat2.id })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.items.length).toBe(1)
      expect(result.data.items[0].categoryId).toBe(cat2.id)
      expect(result.data.total).toBe(1)
    }
  })

  it('returns one page and the full total, so the UI can count what it has not got', async () => {
    const cat = await createCategory()
    for (let i = 0; i < 5; i++) await createProduct(cat.id, `Product ${i}`)

    const first = await listCatalog('en', { limit: 2 })
    expect(first.ok).toBe(true)
    if (first.ok) {
      expect(first.data.items.length).toBe(2)
      expect(first.data.total).toBe(5)
      expect(first.data.limit).toBe(2)
      expect(first.data.offset).toBe(0)
    }

    const second = await listCatalog('en', { limit: 2, offset: 2 })
    expect(second.ok).toBe(true)
    if (second.ok) {
      expect(second.data.items.length).toBe(2)
      // A different page of the same ordering, not the same rows again.
      if (first.ok) {
        expect(second.data.items.map((r) => r.id)).not.toEqual(first.data.items.map((r) => r.id))
      }
    }
  })

  it('reports the total even on a page past the end of the results', async () => {
    // Counted separately from the rows for exactly this: "no rows here" must not
    // be reported as "nothing matched".
    const cat = await createCategory()
    await createProduct(cat.id, 'Only one')

    const result = await listCatalog('en', { limit: 10, offset: 50 })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.items).toEqual([])
      expect(result.data.total).toBe(1)
    }
  })

  /*
   * #236. The count is the expensive half of a searched request: the predicate
   * is a leading-wildcard ILIKE over a COALESCE of correlated per-language
   * subqueries, so it cannot use an index and every row is evaluated in full —
   * and the count used to do that a second time with no LIMIT to stop it.
   *
   * Capped now. Under the cap nothing changes and the number is exact, which
   * for the catalogue this portal is for is every real search.
   */
  describe('the match count is bounded (#236)', () => {
    it('is exact, and says so, for a result set under the cap', async () => {
      const cat = await createCategory()
      for (let i = 0; i < 3; i++) await createProduct(cat.id, `Widget ${i}`)

      const result = await listCatalog('en', { search: 'Widget', limit: 2 })
      expect(result.ok).toBe(true)
      if (!result.ok) return

      expect(result.data.total).toBe(3)
      expect(result.data.totalIsExact).toBe(true)
    })

    it('reports a floor, not a total, once the cap is reached', async () => {
      const cat = await createCategory()
      // One more than the cap. Slow to seed and worth it: this is the only way
      // to reach the branch, and a cap nobody crosses in a test is a cap
      // nobody has checked.
      for (let i = 0; i <= CATALOG_COUNT_CAP; i++) await createProduct(cat.id, `Capped ${i}`)

      const result = await listCatalog('en', { search: 'Capped', limit: 5 })
      expect(result.ok).toBe(true)
      if (!result.ok) return

      // Not CATALOG_COUNT_CAP + 1: the extra row exists only to detect that
      // there are more, and reporting it would be a different wrong number.
      expect(result.data.total).toBe(CATALOG_COUNT_CAP)
      expect(result.data.totalIsExact).toBe(false)
      expect(result.data.items).toHaveLength(5)
    }, 120_000)

    it('still counts an unsearched catalogue exactly', async () => {
      const cat = await createCategory()
      for (let i = 0; i < 4; i++) await createProduct(cat.id, `Plain ${i}`)

      const result = await listCatalog('en', { limit: 2 })
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.data.total).toBe(4)
        expect(result.data.totalIsExact).toBe(true)
      }
    })
  })

  it('caps the page size rather than honouring an unbounded limit', async () => {
    const result = await listCatalog('en', { limit: 100_000 })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.limit).toBe(CATALOG_MAX_LIMIT)
  })

  it('counts matches for the filters, not the whole table', async () => {
    const cat = await createCategory()
    await createProduct(cat.id, 'Match me')
    await createProduct(cat.id, 'Not me')

    const result = await listCatalog('en', { search: 'Match', limit: 1 })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.total).toBe(1)
  })
})

describe('getProduct', () => {
  it('returns 404 for unknown product', async () => {
    const result = await getProduct(999_999, 'en')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(404)
  })

  it('returns product with environments and parameters at all scopes', async () => {
    const cat = await createCategory()
    const product = await createProduct(cat.id, 'My Product')
    const ci = await createCiSource()
    const env = await createEnvironment(ci.id)

    // product_environment link
    await db.insert(productEnvironments).values({
      productId: product.id,
      environmentId: env.id,
      price: '100.00',
    })

    // global, category, product params
    await db.insert(parameters).values([
      { scope: 'global', scopeId: 0, name: 'GLOBAL_P', type: 'string' },
      { scope: 'category', scopeId: cat.id, name: 'CAT_P', type: 'string' },
      { scope: 'product', scopeId: product.id, name: 'PROD_P', type: 'string' },
      // Unrelated category param shouldn't show
      { scope: 'category', scopeId: 9999, name: 'OTHER_CAT_P', type: 'string' },
    ])

    const result = await getProduct(product.id, 'en')
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.data.id).toBe(product.id)
    expect(result.data.environments.length).toBe(1)

    const paramNames = (result.data.parameters as { name: string }[]).map((p) => p.name).sort()
    expect(paramNames).toEqual(['CAT_P', 'GLOBAL_P', 'PROD_P'])
  })

  it('collapses same-name rows to the product-scoped definition (resolved precedence)', async () => {
    const cat = await createCategory()
    const product = await createProduct(cat.id, 'Overlap Product')

    // A global and a product row share the name SHARED. The resolved set the
    // order form renders must keep only the product-scoped definition (product
    // > category > global), not both duplicate controls.
    await db.insert(parameters).values([
      { scope: 'global', scopeId: 0, name: 'SHARED', type: 'string', defaultValue: 'from-global' },
      { scope: 'product', scopeId: product.id, name: 'SHARED', type: 'string', defaultValue: 'from-product' },
    ])

    const result = await getProduct(product.id, 'en')
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const shared = (result.data.parameters as { name: string; scope: string; defaultValue: string }[])
      .filter((p) => p.name === 'SHARED')
    expect(shared).toHaveLength(1)
    expect(shared[0].scope).toBe('product')
    expect(shared[0].defaultValue).toBe('from-product')
  })

  it('does not let an env-A override erase the all-environments definition when no environment is requested', async () => {
    const cat = await createCategory()
    const product = await createProduct(cat.id, 'Cross-Env Product')
    const ci = await createCiSource()
    const envA = await createEnvironment(ci.id)
    const envB = await createEnvironment(ci.id)

    // SHARED exists as an all-environments global row and as a product-scoped
    // override for env A only. Collapsing purely by name (the catalog page
    // fetches WITHOUT an environment — the user picks it in the order form)
    // would keep only the env-A row, and the form would then render no control
    // at all for env B while createOrder still resolves the global one.
    await db.insert(parameters).values([
      { scope: 'global', scopeId: 0, name: 'SHARED', type: 'string', defaultValue: 'all-envs' },
      { scope: 'product', scopeId: product.id, environmentId: envA.id, name: 'SHARED', type: 'string', defaultValue: 'env-a' },
    ])

    const unscoped = await getProduct(product.id, 'en')
    expect(unscoped.ok).toBe(true)
    if (!unscoped.ok) return

    const shared = (unscoped.data.parameters as { name: string; environmentId: number | null; defaultValue: string }[])
      .filter((p) => p.name === 'SHARED')
    // Both candidates survive — one per environment scope, not one overall.
    expect(shared).toHaveLength(2)
    expect(shared.map((p) => p.defaultValue).sort()).toEqual(['all-envs', 'env-a'])

    // Refetching with a concrete environment collapses to exactly what the
    // order service validates against: env A gets its override…
    const forA = await getProduct(product.id, 'en', envA.id)
    expect(forA.ok).toBe(true)
    if (forA.ok) {
      const rows = (forA.data.parameters as { name: string; defaultValue: string }[]).filter((p) => p.name === 'SHARED')
      expect(rows).toHaveLength(1)
      expect(rows[0].defaultValue).toBe('env-a')
    }

    // …and env B still gets the all-environments definition.
    const forB = await getProduct(product.id, 'en', envB.id)
    expect(forB.ok).toBe(true)
    if (forB.ok) {
      const rows = (forB.data.parameters as { name: string; defaultValue: string }[]).filter((p) => p.name === 'SHARED')
      expect(rows).toHaveLength(1)
      expect(rows[0].defaultValue).toBe('all-envs')
    }
  })

  it('still de-duplicates same-name rows within one environment when no environment is requested', async () => {
    const cat = await createCategory()
    const product = await createProduct(cat.id, 'Intra-Env Product')
    const ci = await createCiSource()
    const env = await createEnvironment(ci.id)

    // Two rows, same name, SAME environment, different scopes — the form must
    // not render duplicate controls for these.
    await db.insert(parameters).values([
      { scope: 'global', scopeId: 0, environmentId: env.id, name: 'DUP', type: 'string', defaultValue: 'from-global' },
      { scope: 'product', scopeId: product.id, environmentId: env.id, name: 'DUP', type: 'string', defaultValue: 'from-product' },
    ])

    const result = await getProduct(product.id, 'en')
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const dup = (result.data.parameters as { name: string; scope: string; defaultValue: string }[])
      .filter((p) => p.name === 'DUP')
    expect(dup).toHaveLength(1)
    expect(dup[0].scope).toBe('product')
  })
})

describe('getProduct — the product page payload (#107)', () => {
  it('carries the gallery in order, ids and descriptions only', async () => {
    const cat = await createCategory()
    const product = await createProduct(cat.id, 'Gallery')
    const second = await createProductImage(product.id, { position: 1, alt: 'The back' })
    const first = await createProductImage(product.id, { position: 0, alt: 'The front' })

    const result = await getProduct(product.id, 'en')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.images).toEqual([
        { id: first.id, alt: 'The front' },
        { id: second.id, alt: 'The back' },
      ])
      // The alt the tiles and the cart read is the first picture's.
      expect(result.data.imageAlt).toBe('The front')
    }
  })

  it('lists the environments by name, so the picker does not reshuffle itself', async () => {
    /*
     * This list IS the environment picker on the product page, and it had no
     * ORDER BY: the order was whatever plan Postgres chose, which is not stable
     * across schema changes. Adding four columns to `cost_centers` — the table
     * this query left-joins for the overhead account's name — was enough to flip
     * it, and an e2e journey that ordered into "the first environment" started
     * landing on a different one (#325).
     *
     * Inserted in reverse so a plan that returns insertion order fails this.
     */
    const cat = await createCategory()
    const product = await createProduct(cat.id, 'Picker')
    const ci = await createCiSource()
    const zurich = await createEnvironment(ci.id, undefined, 'Zurich')
    const amsterdam = await createEnvironment(ci.id, undefined, 'Amsterdam')
    const munich = await createEnvironment(ci.id, undefined, 'Munich')
    for (const env of [zurich, munich, amsterdam]) {
      await linkProductEnvironment(product.id, env.id)
    }

    const result = await getProduct(product.id, 'en')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.environments.map((e) => (e as { environmentName: string }).environmentName)).toEqual([
      'Amsterdam',
      'Munich',
      'Zurich',
    ])
  })

  it('has an empty gallery and a null imageAlt on a product with no picture', async () => {
    const cat = await createCategory()
    const product = await createProduct(cat.id, 'Bare')

    const result = await getProduct(product.id, 'en')
    if (result.ok) {
      expect(result.data.images).toEqual([])
      expect(result.data.imageAlt).toBeNull()
    }
  })

  it('translates the long description with the same fallback chain as the short one', async () => {
    const cat = await createCategory()
    const product = await createProduct(cat.id, 'Story')
    await db
      .update(productTranslations)
      .set({ longDescription: 'The English story, at length.' })
      .where(eq(productTranslations.productId, product.id))
    await db.insert(productTranslations).values({
      productId: product.id,
      languageCode: 'fr',
      name: 'Histoire',
      description: 'Court',
      longDescription: "L'histoire française.",
    })

    const french = await getProduct(product.id, 'fr')
    if (french.ok) expect(french.data.longDescription).toBe("L'histoire française.")

    // No Italian translation, so English answers — the page would otherwise show
    // nothing where the story goes.
    const italian = await getProduct(product.id, 'it')
    if (italian.ok) expect(italian.data.longDescription).toBe('The English story, at length.')
  })

  it('falls back when the translation row exists but its long text is empty', async () => {
    // long_description is NOT NULL DEFAULT '', so this row is present and blank —
    // which is exactly what the demo seed writes for de. COALESCE alone treats ''
    // as a value and returns it, so the fallback never fired and the page showed
    // no story. The missing-row case above passes either way, which is why this
    // one has to exist separately.
    const cat = await createCategory()
    const product = await createProduct(cat.id, 'BlankStory')
    await db
      .update(productTranslations)
      .set({ longDescription: 'The English story, at length.' })
      .where(eq(productTranslations.productId, product.id))
    await db.insert(productTranslations).values({
      productId: product.id,
      languageCode: 'de',
      name: 'Geschichte',
      description: 'Kurz',
      longDescription: '',
    })

    const german = await getProduct(product.id, 'de')
    expect(german.ok).toBe(true)
    if (german.ok) expect(german.data.longDescription).toBe('The English story, at length.')
  })

  it("returns '' rather than another language when nobody wrote a long description", async () => {
    const cat = await createCategory()
    const product = await createProduct(cat.id, 'NoStory')

    const result = await getProduct(product.id, 'en')
    if (result.ok) expect(result.data.longDescription).toBe('')
  })

  it('carries the owner and the documentation link, null when unset', async () => {
    const cat = await createCategory()
    const product = await createProduct(cat.id, 'Owned')

    const bare = await getProduct(product.id, 'en')
    if (bare.ok) {
      expect(bare.data.owner).toBeNull()
      expect(bare.data.docsUrl).toBeNull()
    }

    await db
      .update(products)
      .set({ owner: 'Platform Networking', docsUrl: 'https://example.internal/docs' })
      .where(eq(products.id, product.id))

    const filled = await getProduct(product.id, 'en')
    if (filled.ok) {
      expect(filled.data.owner).toBe('Platform Networking')
      expect(filled.data.docsUrl).toBe('https://example.internal/docs')
    }
  })
})

describe('listCatalog — image descriptions come from the gallery', () => {
  it('uses the first picture\'s alt text', async () => {
    const cat = await createCategory()
    const product = await createProduct(cat.id, 'Tile')
    await createProductImage(product.id, { position: 1, alt: 'Second' })
    await createProductImage(product.id, { position: 0, alt: 'First' })

    const result = await listCatalog('en', { categoryId: cat.id })
    if (result.ok) {
      const row = result.data.items.find((item) => item.id === product.id)
      expect(row?.imageAlt).toBe('First')
    }
  })
})

describe('getProductImageById', () => {
  it('returns the bytes, type and description of one gallery picture', async () => {
    const cat = await createCategory()
    const product = await createProduct(cat.id, 'ById')
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0])
    const image = await createProductImage(product.id, { data: jpeg, mime: 'image/jpeg', alt: 'A photo' })

    const result = await getProductImageById(product.id, image.id)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(Buffer.from(result.data.data).equals(jpeg)).toBe(true)
      expect(result.data.mime).toBe('image/jpeg')
      expect(result.data.alt).toBe('A photo')
    }
  })

  it("404s for an image that belongs to another product", async () => {
    const cat = await createCategory()
    const mine = await createProduct(cat.id, 'Mine')
    const theirs = await createProduct(cat.id, 'Theirs')
    const foreign = await createProductImage(theirs.id)

    const result = await getProductImageById(mine.id, foreign.id)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(404)
  })
})

describe('getProductImage', () => {
  it('returns null data when no image set', async () => {
    const cat = await createCategory()
    const product = await createProduct(cat.id, 'P')

    const result = await getProductImage(product.id)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data).toBeNull()
  })

  it('returns { data, mime, alt } for the first picture of the gallery', async () => {
    const cat = await createCategory()
    const product = await createProduct(cat.id, 'P')
    const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47])
    await createProductImage(product.id, { position: 0, data: buf, alt: 'The front of it' })
    await createProductImage(product.id, {
      position: 1,
      data: Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
      mime: 'image/jpeg',
      alt: 'The back of it',
    })

    const result = await getProductImage(product.id)
    expect(result.ok).toBe(true)
    // Not `&& result.data`: a null image would skip every assertion below and pass
    // (#307).
    if (!result.ok) throw new Error(result.message)
    if (!result.data) throw new Error('the product image was not returned')
    expect(Buffer.from(result.data.data).equals(buf)).toBe(true)
    expect(result.data.mime).toBe('image/png')
    expect(result.data.alt).toBe('The front of it')
  })

  it('returns 404 for unknown product', async () => {
    const result = await getProductImage(999_999)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(404)
  })
})
