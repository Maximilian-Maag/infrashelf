import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/ci', () => ({
  triggerPipeline: vi.fn(),
}))

import { triggerProductWebhooksTracked, triggerPipelineStacksTracked } from './webhooks'
import { elementStateSuffix } from './stateKey'
import { triggerPipeline } from './index'
import { db } from '@/lib/db/client'
import { productWebhooks, pipelineStacks } from '@/lib/db/schema'
import {
  createCategory,
  createProduct,
  createCiSource,
  createEnvironment,
} from '@/test/helpers'

const mockedTriggerPipeline = vi.mocked(triggerPipeline)

beforeEach(() => {
  mockedTriggerPipeline.mockReset()
  mockedTriggerPipeline.mockResolvedValue('pipe-default')
})

describe('triggerProductWebhooksTracked — pipeline ids', () => {
  it('returns an empty array when no webhooks are configured for the product/env', async () => {
    const cat = await createCategory()
    const product = await createProduct(cat.id)
    const ci = await createCiSource()
    const env = await createEnvironment(ci.id)

    const { pipelineIds: result } = await triggerProductWebhooksTracked(product.id, env.id, { FOO: 'bar' })
    expect(result).toEqual([])
    expect(mockedTriggerPipeline).not.toHaveBeenCalled()
  })

  it('triggers one pipeline per webhook in exec order and returns IDs', async () => {
    const cat = await createCategory()
    const product = await createProduct(cat.id)
    const ci = await createCiSource()
    const env = await createEnvironment(ci.id)

    // Insert two webhooks with explicit ordering
    await db.insert(productWebhooks).values([
      {
        productId: product.id,
        environmentId: env.id,
        name: 'second',
        webhookUrl: 'https://gl.example.com/api/v4/projects/2/trigger/pipeline',
        webhookToken: 'tok2',
        execOrder: 2,
      },
      {
        productId: product.id,
        environmentId: env.id,
        name: 'first',
        webhookUrl: 'https://gl.example.com/api/v4/projects/1/trigger/pipeline',
        webhookToken: 'tok1',
        execOrder: 1,
      },
    ])

    mockedTriggerPipeline
      .mockResolvedValueOnce('pipe-1')
      .mockResolvedValueOnce('pipe-2')

    const { pipelineIds: result } = await triggerProductWebhooksTracked(product.id, env.id, { ORDER_ID: '42' })

    expect(result).toEqual(['pipe-1', 'pipe-2'])
    expect(mockedTriggerPipeline).toHaveBeenCalledTimes(2)
    // First call should be the lower execOrder
    const firstCall = mockedTriggerPipeline.mock.calls[0]
    expect(firstCall[1]).toBe('https://gl.example.com/api/v4/projects/1/trigger/pipeline')
    expect(firstCall[2]).toBe('tok1')
    expect(firstCall[3]).toEqual({ ORDER_ID: '42' })
  })

  it('returns an empty array when the CI source is missing for the environment', async () => {
    const cat = await createCategory()
    const product = await createProduct(cat.id)
    // No env created at all — environmentId 999 won't resolve to a CI source
    const { pipelineIds: result } = await triggerProductWebhooksTracked(product.id, 999, { FOO: 'bar' })
    expect(result).toEqual([])
    expect(mockedTriggerPipeline).not.toHaveBeenCalled()
  })

  it('catches a pipeline trigger failure and continues with remaining webhooks', async () => {
    const cat = await createCategory()
    const product = await createProduct(cat.id)
    const ci = await createCiSource()
    const env = await createEnvironment(ci.id)

    await db.insert(productWebhooks).values([
      {
        productId: product.id,
        environmentId: env.id,
        name: 'will-fail',
        webhookUrl: 'https://gl.example.com/api/v4/projects/1/trigger/pipeline',
        webhookToken: 'tok-a',
        execOrder: 1,
      },
      {
        productId: product.id,
        environmentId: env.id,
        name: 'will-succeed',
        webhookUrl: 'https://gl.example.com/api/v4/projects/2/trigger/pipeline',
        webhookToken: 'tok-b',
        execOrder: 2,
      },
    ])

    mockedTriggerPipeline
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce('pipe-ok')

    // Silence the expected console.error
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const { pipelineIds: result } = await triggerProductWebhooksTracked(product.id, env.id, {})

    expect(result).toEqual(['pipe-ok'])
    expect(mockedTriggerPipeline).toHaveBeenCalledTimes(2)

    errSpy.mockRestore()
  })
})

describe('triggerProductWebhooksTracked', () => {
  it('reports the webhooks that could not be started alongside the ones that were', async () => {
    const cat = await createCategory()
    const product = await createProduct(cat.id)
    const ci = await createCiSource()
    const env = await createEnvironment(ci.id)

    await db.insert(productWebhooks).values([
      {
        productId: product.id,
        environmentId: env.id,
        name: 'will-fail',
        webhookUrl: 'https://gl.example.com/api/v4/projects/1/trigger/pipeline',
        webhookToken: 'tok-a',
        execOrder: 1,
      },
      {
        productId: product.id,
        environmentId: env.id,
        name: 'will-succeed',
        webhookUrl: 'https://gl.example.com/api/v4/projects/2/trigger/pipeline',
        webhookToken: 'tok-b',
        execOrder: 2,
      },
    ])

    mockedTriggerPipeline
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce('pipe-ok')

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    // The failure must not abort the remaining webhooks, but it must not vanish
    // either — the teardown paths decide what to do based on `failures`.
    const outcome = await triggerProductWebhooksTracked(product.id, env.id, {})

    expect(outcome.pipelineIds).toEqual(['pipe-ok'])
    expect(outcome.failures).toHaveLength(1)
    expect(outcome.failures[0]).toContain('will-fail')
    expect(outcome.failures[0]).toContain('boom')

    errSpy.mockRestore()
  })

  it('reports no failures when every webhook starts', async () => {
    const cat = await createCategory()
    const product = await createProduct(cat.id)
    const ci = await createCiSource()
    const env = await createEnvironment(ci.id)

    await db.insert(productWebhooks).values({
      productId: product.id,
      environmentId: env.id,
      name: 'ok',
      webhookUrl: 'https://gl.example.com/api/v4/projects/1/trigger/pipeline',
      webhookToken: 'tok',
      execOrder: 1,
    })
    mockedTriggerPipeline.mockResolvedValueOnce('pipe-1')

    const outcome = await triggerProductWebhooksTracked(product.id, env.id, {})
    expect(outcome).toEqual({ pipelineIds: ['pipe-1'], failures: [] })
  })
})

describe('elementStateSuffix', () => {
  it('leaves element 1 unsuffixed and suffixes the rest', () => {
    // Element 1 has to be byte-identical to the pre-quantity behaviour, or the
    // teardown of every element provisioned before this change would target a
    // state file that does not exist.
    expect(elementStateSuffix('1')).toBe('')
    expect(elementStateSuffix(1)).toBe('')
    expect(elementStateSuffix(undefined)).toBe('')
    expect(elementStateSuffix('not a number')).toBe('')
    expect(elementStateSuffix('2')).toBe('-2')
    expect(elementStateSuffix(20)).toBe('-20')
  })
})

describe('TF_STATE_NAME per element (issue #104)', () => {
  const seedStack = async (stateKeyParam: string) => {
    const cat = await createCategory()
    const product = await createProduct(cat.id)
    const ci = await createCiSource()
    const env = await createEnvironment(ci.id)
    await db.insert(pipelineStacks).values({
      productId: product.id,
      environmentId: env.id,
      name: 'stack',
      stateKeyParam,
      steps: [{ template: 'vm', suffix: 'vm' }] as never,
    })
    return { product, env }
  }

  const stateNameOf = () =>
    (mockedTriggerPipeline.mock.calls[0][3] as Record<string, string>).TF_STATE_NAME

  it('derives the state key from ORDER_ID and suffixes it per element', async () => {
    const { product, env } = await seedStack('hostname')

    await triggerPipelineStacksTracked(product.id, env.id, { ORDER_ID: '42', ELEMENT_SEQUENCE: '1' })
    expect(stateNameOf()).toBe('42')

    mockedTriggerPipeline.mockClear()
    await triggerPipelineStacksTracked(product.id, env.id, { ORDER_ID: '42', ELEMENT_SEQUENCE: '3' })
    // Element three of order 42 gets its own state, so it cannot apply on top of
    // element one's.
    expect(stateNameOf()).toBe('42-3')
  })

  it("suffixes the stack's own stateKeyParam too", async () => {
    const { product, env } = await seedStack('hostname')

    await triggerPipelineStacksTracked(product.id, env.id, {
      hostname: 'web-01',
      ORDER_ID: '42',
      ELEMENT_SEQUENCE: '2',
    })

    // The parameter is the same for every element of one line — it is what the
    // customer typed — so without the suffix all twenty would share a state file.
    expect(stateNameOf()).toBe('web-01-2')
  })

  it('never produces a bare suffix when nothing identifies the state', async () => {
    const { product, env } = await seedStack('hostname')

    await triggerPipelineStacksTracked(product.id, env.id, { ELEMENT_SEQUENCE: '2' })

    // '-2' is not a state name; empty is the existing signal for "unidentified".
    expect(stateNameOf()).toBe('')
  })

  // Issue #183. The stateKeyParam value is typed by whoever places the order, so
  // before these the state key was too.
  it('namespaces the stateKeyParam value with the order id', async () => {
    const { product, env } = await seedStack('hostname')

    await triggerPipelineStacksTracked(product.id, env.id, {
      hostname: 'web-01',
      ORDER_ID: '42',
      ELEMENT_SEQUENCE: '1',
      TF_STATE_NAMESPACE: '42',
    })

    expect(stateNameOf()).toBe('web-01-42')
  })

  it('gives two orders that typed the same hostname different states', async () => {
    const { product, env } = await seedStack('hostname')

    await triggerPipelineStacksTracked(product.id, env.id, {
      hostname: 'web-01', ORDER_ID: '42', ELEMENT_SEQUENCE: '1', TF_STATE_NAMESPACE: '42',
    })
    const first = stateNameOf()

    mockedTriggerPipeline.mockClear()
    // A different user, same product, same value typed into the same field. This
    // pipeline used to point at the state the first one created — and destroying
    // this element then destroyed the first user's infrastructure.
    await triggerPipelineStacksTracked(product.id, env.id, {
      hostname: 'web-01', ORDER_ID: '43', ELEMENT_SEQUENCE: '1', TF_STATE_NAMESPACE: '43',
    })

    expect(stateNameOf()).not.toBe(first)
    expect(stateNameOf()).toBe('web-01-43')
  })

  it('strips what a state key may not contain from the typed value', async () => {
    const { product, env } = await seedStack('hostname')

    await triggerPipelineStacksTracked(product.id, env.id, {
      hostname: '../../other/state',
      ORDER_ID: '42',
      ELEMENT_SEQUENCE: '1',
      TF_STATE_NAMESPACE: '42',
    })

    // The orchestrator treats the name as a path, so the separators go and the
    // leading dots with them.
    expect(stateNameOf()).toBe('other-state-42')
  })

  it('still suffixes a namespaced key per element', async () => {
    const { product, env } = await seedStack('hostname')

    await triggerPipelineStacksTracked(product.id, env.id, {
      hostname: 'web-01', ORDER_ID: '42', ELEMENT_SEQUENCE: '3', TF_STATE_NAMESPACE: '42',
    })

    expect(stateNameOf()).toBe('web-01-42-3')
  })

  it('leaves the key of an element provisioned before the namespace exactly as it was', async () => {
    const { product, env } = await seedStack('hostname')

    // No TF_STATE_NAMESPACE: the element predates #183, and its Terraform state
    // exists under the raw value. Re-deriving it would point the teardown at a
    // state that was never created.
    await triggerPipelineStacksTracked(product.id, env.id, {
      hostname: 'web-01',
      ORDER_ID: '42',
      ELEMENT_SEQUENCE: '2',
    })

    expect(stateNameOf()).toBe('web-01-2')
  })
})
