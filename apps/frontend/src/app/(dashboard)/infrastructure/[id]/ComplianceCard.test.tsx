import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { InfrastructureDetail } from '@infrashelf/types'
import { ComplianceCard } from './ComplianceCard'

/**
 * What the element page says about drift and policy (#110, slice 6).
 *
 * The wording is the point, not the layout: "never checked" must never read as
 * "checked and fine", and a policy that could not be asked must not read as one
 * that agreed. Both are the failure mode this card exists to prevent.
 */
const element = (over: Partial<InfrastructureDetail> = {}): InfrastructureDetail =>
  ({
    id: 21,
    orderId: 11,
    productId: 2,
    productName: 'Managed Postgres',
    projectId: 4,
    projectName: 'Platform',
    environmentId: 3,
    environmentName: 'prod',
    status: 'active',
    displayStatus: 'active',
    outputs: {},
    parameters: {},
    pipelineId: [],
    pipelineStatus: {},
    redactedParameters: [],
    ...over,
  }) as unknown as InfrastructureDetail

const show = (over: Partial<InfrastructureDetail> = {}) => render(<ComplianceCard element={element(over)} lang="en" />)

describe('ComplianceCard', () => {
  it('says nothing has checked the element yet, rather than showing it as clean', () => {
    show()

    expect(screen.getByText(/nothing has checked this element yet/i)).toBeDefined()
    expect(screen.queryByText(/plan and what is deployed agree/i)).toBeNull()
    expect(screen.getByText(/policy has not been asked about this element yet/i)).toBeDefined()
    // No green verdict nobody earned.
    expect(screen.queryByText(/policies agree with this element/i)).toBeNull()
  })

  it('shows what a drift report found, and which resources moved', () => {
    show({
      lastRefreshOutcome: 'drifted',
      driftDetectedAt: '2026-09-21T06:00:00.000Z',
      driftSummary: {
        resources: [
          { address: 'linode_instance.vm', action: 'update' },
          { address: 'linode_volume.data', action: 'create' },
        ],
      },
    })

    expect(screen.getByText(/plan and the deployed resources disagree/i)).toBeDefined()
    expect(screen.getByText('linode_instance.vm')).toBeDefined()
    expect(screen.getByText('update')).toBeDefined()
    expect(screen.getByText('linode_volume.data')).toBeDefined()
    expect(screen.getByText(/resources that moved/i)).toBeDefined()
    // The date is the report that found it, so it is shown.
    expect(screen.getByText(/21\/09\/2026|9\/21\/2026/)).toBeDefined()
  })

  it('distinguishes a locked state and an unreadable one from a clean result', () => {
    const { unmount } = show({ lastRefreshOutcome: 'locked' })
    expect(screen.getByText(/state was locked when the refresh ran/i)).toBeDefined()
    unmount()

    show({ lastRefreshOutcome: 'error' })
    expect(screen.getByText(/could not read the state/i)).toBeDefined()
    expect(screen.queryByText(/agree/i)).toBeNull()
  })

  it('prints the rule and the policy\'s own words under a refusal', () => {
    show({
      policyOutcome: 'deny',
      policyRule: 'exposure/public-ip',
      policyMessage: 'A public IP is not permitted in this environment.',
      policyCheckedAt: '2026-09-22T06:00:00.000Z',
      lastRefreshOutcome: 'clean',
    })

    expect(screen.getByText(/a policy refused this element/i)).toBeDefined()
    expect(screen.getByText('exposure/public-ip')).toBeDefined()
    // Shown as written rather than translated: the portal cannot rephrase a rule
    // it did not write.
    expect(screen.getByText('A public IP is not permitted in this environment.')).toBeDefined()
    expect(screen.getByText(/plan and what is deployed agree/i)).toBeDefined()
  })

  it('says the engine could not be asked, and names it', () => {
    show({
      policyOutcome: 'unavailable',
      policyMessage: 'The policy engine "opa-prod" could not be asked, so nothing was decided about this element: ECONNREFUSED.',
      policyCheckedAt: '2026-09-22T06:00:00.000Z',
    })

    expect(screen.getByText(/policy could not be asked about this element/i)).toBeDefined()
    expect(screen.getByText(/opa-prod/)).toBeDefined()
    // Never rendered as agreement.
    expect(screen.queryByText(/policies agree with this element/i)).toBeNull()
  })

  it('reports a warning and a needed approval as themselves, not as refusals', () => {
    const { unmount } = show({ policyOutcome: 'warn', policyRule: 'tagging/missing' })
    expect(screen.getByText(/a policy warned about this element/i)).toBeDefined()
    expect(screen.queryByText(/refused/i)).toBeNull()
    unmount()

    show({ policyOutcome: 'needs-approval', policyRule: 'approval/required' })
    expect(screen.getByText(/needed approval/i)).toBeDefined()
    expect(screen.queryByText(/refused/i)).toBeNull()
  })

  it('shows an agreement as agreement', () => {
    show({
      policyOutcome: 'allow',
      policyCheckedAt: '2026-09-22T06:00:00.000Z',
      lastRefreshOutcome: 'clean',
    })

    expect(screen.getByText(/policies agree with this element/i)).toBeDefined()
  })
})
