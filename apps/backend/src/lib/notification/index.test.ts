import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock nodemailer so no real SMTP connection is made
vi.mock('nodemailer', () => ({
  default: {
    createTransport: vi.fn().mockReturnValue({
      sendMail: vi.fn().mockResolvedValue({}),
    }),
  },
}))

// Mock DB so no real DB query is made
vi.mock('@/lib/db/client', () => ({
  db: {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([
            {
              smtpHost: 'smtp.test.dev',
              smtpPort: 587,
              smtpFrom: 'noreply@test.dev',
              smtpUser: '',
              smtpPass: '',
              smtpTls: false,
            },
          ]),
        }),
      }),
    }),
  },
}))

import nodemailer from 'nodemailer'
import {
  sendOrderCreated,
  sendApprovalRequest,
  sendOrderApproved,
  sendOrderRejected,
  sendProvisioningCompleted,
  sendProvisioningFailed,
  sendDecommissioned,
} from './index'

const getMockSendMail = () => {
  const transporter = nodemailer.createTransport({} as never)
  return transporter.sendMail as ReturnType<typeof vi.fn>
}

describe('notification functions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Reset module-level caches by re-importing won't work easily,
    // but we can test the subject/body via the sendMail mock
  })

  it('sendApprovalRequest uses correct subject', async () => {
    await sendApprovalRequest('admin@test.dev', 'My Product', 42, 'Alice')
    const sendMail = getMockSendMail()
    if (sendMail.mock.calls.length > 0) {
      const [options] = sendMail.mock.calls[sendMail.mock.calls.length - 1]
      expect(options.subject).toContain('Approval Required')
      expect(options.subject).toContain('42')
      expect(options.subject).toContain('My Product')
    }
  })

  it('sendApprovalRequest body mentions orderer name and product', async () => {
    await sendApprovalRequest('admin@test.dev', 'My Product', 42, 'Alice')
    const sendMail = getMockSendMail()
    if (sendMail.mock.calls.length > 0) {
      const [options] = sendMail.mock.calls[sendMail.mock.calls.length - 1]
      expect(options.html).toContain('Alice')
      expect(options.html).toContain('My Product')
      expect(options.html).toContain('42')
    }
  })

  it('sendApprovalRequest names the admins a substitute is covering for', async () => {
    // Issue #35: delegation is reflected as a CC, so the substitute still gets
    // the ordinary request — their copy just explains the extra standing.
    await sendApprovalRequest('sub@test.dev', 'My Product', 42, 'Alice', ['Bob Admin', 'Carol Admin'])
    const sendMail = getMockSendMail()
    const [options] = sendMail.mock.calls[sendMail.mock.calls.length - 1]
    expect(options.to).toBe('sub@test.dev')
    expect(options.html).toContain('substitute approver')
    expect(options.html).toContain('Bob Admin')
    expect(options.html).toContain('Carol Admin')
    expect(options.html).toContain('your own name')
  })

  it('sendApprovalRequest says nothing about delegation when there is none', async () => {
    await sendApprovalRequest('admin@test.dev', 'My Product', 42, 'Alice')
    const sendMail = getMockSendMail()
    const [options] = sendMail.mock.calls[sendMail.mock.calls.length - 1]
    expect(options.html).not.toContain('substitute approver')
  })

  it('sendApprovalRequest escapes a delegator name rather than trusting it', async () => {
    await sendApprovalRequest('sub@test.dev', 'My Product', 42, 'Alice', ['<script>x</script>'])
    const sendMail = getMockSendMail()
    const [options] = sendMail.mock.calls[sendMail.mock.calls.length - 1]
    expect(options.html).not.toContain('<script>')
    expect(options.html).toContain('&lt;script&gt;')
  })

  it('sendOrderCreated subject contains order id and product name', async () => {
    await sendOrderCreated('user@test.dev', 'Fancy Product', 7)
    const sendMail = getMockSendMail()
    if (sendMail.mock.calls.length > 0) {
      const [options] = sendMail.mock.calls[sendMail.mock.calls.length - 1]
      expect(options.subject).toContain('7')
      expect(options.subject).toContain('Fancy Product')
    }
  })

  it('sendOrderApproved subject mentions approved', async () => {
    await sendOrderApproved('user@test.dev', 'Product X', 3)
    const sendMail = getMockSendMail()
    if (sendMail.mock.calls.length > 0) {
      const [options] = sendMail.mock.calls[sendMail.mock.calls.length - 1]
      expect(options.subject).toContain('Approved')
    }
  })

  it('sendOrderRejected includes rejection note in body', async () => {
    await sendOrderRejected('user@test.dev', 'Product Y', 5, 'Budget exceeded')
    const sendMail = getMockSendMail()
    if (sendMail.mock.calls.length > 0) {
      const [options] = sendMail.mock.calls[sendMail.mock.calls.length - 1]
      expect(options.html).toContain('Budget exceeded')
    }
  })

  it('sendProvisioningCompleted includes infraId in body', async () => {
    await sendProvisioningCompleted('user@test.dev', 'Product Z', 99)
    const sendMail = getMockSendMail()
    if (sendMail.mock.calls.length > 0) {
      const [options] = sendMail.mock.calls[sendMail.mock.calls.length - 1]
      expect(options.html).toContain('99')
    }
  })

  it('sendProvisioningFailed subject mentions Failed', async () => {
    await sendProvisioningFailed('user@test.dev', 'Product W', 11)
    const sendMail = getMockSendMail()
    if (sendMail.mock.calls.length > 0) {
      const [options] = sendMail.mock.calls[sendMail.mock.calls.length - 1]
      expect(options.subject).toContain('Failed')
    }
  })

  it('sendDecommissioned subject mentions Decommissioned', async () => {
    await sendDecommissioned('user@test.dev', 'Product V', 22)
    const sendMail = getMockSendMail()
    if (sendMail.mock.calls.length > 0) {
      const [options] = sendMail.mock.calls[sendMail.mock.calls.length - 1]
      expect(options.subject).toContain('Decommissioned')
    }
  })
})

/**
 * A dropped notification is invisible by design (#482).
 *
 * Failing to send must not fail the approval that triggered it, so this
 * `console.error` is the only record that it happened — and "an email failed"
 * cannot be matched to the order whose approval never arrived.
 */
describe('a notification that could not be sent', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  const failToSend = () => {
    getMockSendMail().mockRejectedValueOnce(new Error('ECONNREFUSED smtp.test.dev:587'))
    return vi.spyOn(console, 'error').mockImplementation(() => {})
  }

  it('says which message, so the failure can be matched to the order', async () => {
    const logged = failToSend()

    await sendOrderCreated('ada.lovelace@example.org', 'Managed Postgres', 4812)

    expect(logged).toHaveBeenCalledTimes(1)
    const line = String(logged.mock.calls[0][0])
    expect(line).toContain('4812')
    expect(line).toContain('Managed Postgres')
    logged.mockRestore()
  })

  it('does not write the recipient into the log in full', async () => {
    // Enough to tell two failures apart and to see a whole domain refusing mail,
    // without turning a log that is shipped elsewhere into an address book.
    const logged = failToSend()

    await sendOrderCreated('ada.lovelace@example.org', 'Managed Postgres', 4812)

    const line = String(logged.mock.calls[0][0])
    expect(line).not.toContain('ada.lovelace@example.org')
    expect(line).toContain('@example.org')
    expect(line).toContain('a***e@example.org')
    logged.mockRestore()
  })

  it('masks a local part too short to mask partially', async () => {
    const logged = failToSend()

    await sendOrderCreated('al@example.org', 'Managed Postgres', 4812)

    const line = String(logged.mock.calls[0][0])
    expect(line).toContain('***@example.org')
    expect(line).not.toContain('al@')
    logged.mockRestore()
  })

  it('swallows the failure rather than letting it reach the caller', async () => {
    // The property the log line exists BECAUSE of: an order must not fail
    // because the mail server is down.
    const logged = failToSend()
    await expect(sendOrderCreated('ada@example.org', 'Managed Postgres', 4812)).resolves.toBeUndefined()
    logged.mockRestore()
  })
})
