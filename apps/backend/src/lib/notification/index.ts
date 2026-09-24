import nodemailer from 'nodemailer'
import { db } from '@/lib/db/client'
import { appConfig } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { readAppSecret } from '@/lib/crypto/appSecrets'

interface SmtpSettings {
  host: string
  port: number
  from: string
  user: string
  pass: string
  tls: boolean
}

let transporterCache: nodemailer.Transporter | null = null
let smtpSettingsCache: SmtpSettings | null = null

// Clear the cached SMTP settings/transporter so the next send picks up config
// changes. Must be called whenever the SMTP config row is updated, otherwise a
// long-running server keeps using the stale settings until restart.
export const resetSmtpCache = (): void => {
  smtpSettingsCache = null
  transporterCache = null
}

// Values interpolated into an email header (Subject) must not contain CR/LF,
// which would allow header injection. Subjects are plain text, so they are not
// HTML-escaped — only newline-stripped.
const headerSafe = (s: string): string => s.replace(/[\r\n]+/g, ' ').trim()

const getSmtpSettings = async (): Promise<SmtpSettings | null> => {
  if (
    process.env.SMTP_HOST &&
    process.env.SMTP_PORT &&
    process.env.SMTP_FROM
  ) {
    return {
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT, 10),
      from: process.env.SMTP_FROM,
      user: process.env.SMTP_USER ?? '',
      pass: process.env.SMTP_PASS ?? '',
      tls: process.env.SMTP_TLS !== 'false',
    }
  }

  if (smtpSettingsCache) return smtpSettingsCache

  const rows = await db.select().from(appConfig).where(eq(appConfig.id, 1)).limit(1)
  if (!rows.length || !rows[0].smtpHost || !rows[0].smtpPort || !rows[0].smtpFrom) return null

  const cfg = rows[0]
  smtpSettingsCache = {
    host: cfg.smtpHost ?? '',
    port: cfg.smtpPort ?? 0,
    from: cfg.smtpFrom ?? '',
    user: cfg.smtpUser ?? '',
    // Through `readAppSecret`, not off the row: the column holds an envelope since
    // #556 and plaintext on rows that predate it. Handing the envelope to nodemailer
    // as a password is a login failure that names the wrong component.
    pass: (await readAppSecret('smtpPass')) ?? '',
    tls: cfg.smtpTls ?? true,
  }
  return smtpSettingsCache
}

const getTransporter = async (): Promise<nodemailer.Transporter | null> => {
  if (transporterCache) return transporterCache

  const settings = await getSmtpSettings()
  if (!settings) return null

  transporterCache = nodemailer.createTransport({
    host: settings.host,
    port: settings.port,
    secure: settings.tls,
    auth: settings.user
      ? { user: settings.user, pass: settings.pass }
      : undefined,
  })
  return transporterCache
}

/**
 * `ada.lovelace@example.org` as `a***e@example.org`.
 *
 * Enough to tell two failures apart and to see a domain refusing everything,
 * without writing addresses into a log that is shipped somewhere else (#482).
 */
const maskRecipient = (address: string): string => {
  const at = address.lastIndexOf('@')
  if (at <= 0) return '***'
  const local = address.slice(0, at)
  const masked = local.length <= 2 ? '***' : `${local[0]}***${local[local.length - 1]}`
  return `${masked}${address.slice(at)}`
}

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')

const send = async (to: string, subject: string, html: string): Promise<void> => {
  try {
    const transporter = await getTransporter()
    if (!transporter) return
    const settings = await getSmtpSettings()
    if (!settings) return
    await transporter.sendMail({ from: settings.from, to, subject, html })
  } catch (err) {
    /*
     * Which message, to whom (#482). Silently dropping a notification is the
     * design here — an approval must not fail because the mail server is down —
     * so this line is the only record that it happened at all, and "an email
     * failed" cannot be matched to the order whose approval never arrived.
     *
     * The recipient is logged as its domain plus a masked local part rather than
     * in full: it is enough to tell one failure from another and to see that a
     * whole domain is refusing mail, without turning the pod log into an address
     * book. The subject already names the order.
     */
    console.error(`[notification] Failed to send "${subject}" to ${maskRecipient(to)}:`, err)
  }
}

export const sendOrderCreated = async (
  to: string,
  productName: string,
  orderId: number,
): Promise<void> =>
  send(
    to,
    `Order #${orderId} Created — ${headerSafe(productName)}`,
    `<p>Your order <strong>#${orderId}</strong> for <strong>${escapeHtml(productName)}</strong> has been created and is pending approval.</p>`,
  )

/**
 * Ask an approver to act on a pending order.
 *
 * `substitutingFor` names the admins whose approval authority this recipient is
 * currently holding (issue #35). Delegation is reflected here as a **CC**, not a
 * redirect: the away admin stays on the recipient list and the substitute's copy
 * gains a line saying why they are also expected to act.
 *
 * Redirecting was the alternative and was rejected. Removing the delegator from
 * the list would turn a delegation into a mail filter that whoever created it can
 * point at somebody else's inbox — an accidental or malicious delegation would
 * make approval traffic invisible to the admin who is still accountable for it.
 * An away mailbox filling up is the cheaper failure, and an admin who returns
 * early or reads mail on their phone keeps working.
 */
export const sendApprovalRequest = async (
  to: string,
  productName: string,
  orderId: number,
  ordererName: string,
  substitutingFor: string[] = [],
): Promise<void> =>
  send(
    to,
    `Approval Required: Order #${orderId} — ${headerSafe(productName)}`,
    `<p><strong>${escapeHtml(ordererName)}</strong> has placed order <strong>#${orderId}</strong> for <strong>${escapeHtml(productName)}</strong> and it requires your approval.</p>` +
      (substitutingFor.length
        ? `<p>You are also receiving this as the substitute approver for ` +
          `<strong>${substitutingFor.map(escapeHtml).join('</strong>, <strong>')}</strong>. ` +
          `You approve under your own name; the delegation is recorded in the audit log.</p>`
        : '') +
      `<p>Please log in to review and approve or reject the order.</p>`,
  )

export const sendOrderApproved = async (
  to: string,
  productName: string,
  orderId: number,
): Promise<void> =>
  send(
    to,
    `Order #${orderId} Approved — ${headerSafe(productName)}`,
    `<p>Your order <strong>#${orderId}</strong> for <strong>${escapeHtml(productName)}</strong> has been approved and provisioning has started.</p>`,
  )

export const sendOrderRejected = async (
  to: string,
  productName: string,
  orderId: number,
  note: string,
): Promise<void> =>
  send(
    to,
    `Order #${orderId} Rejected — ${headerSafe(productName)}`,
    `<p>Your order <strong>#${orderId}</strong> for <strong>${escapeHtml(productName)}</strong> has been rejected.</p><p><strong>Reason:</strong> ${escapeHtml(note)}</p>`,
  )

export const sendProvisioningCompleted = async (
  to: string,
  productName: string,
  infraId: number,
  /**
   * How many elements the order provisioned (issue #104). Defaults to 1, which is
   * what every order was before quantity existed and keeps the single-element mail
   * word for word what it was.
   */
  elementCount = 1,
): Promise<void> =>
  send(
    to,
    `Provisioning Completed — ${headerSafe(productName)}`,
    `<p>Provisioning of <strong>${escapeHtml(productName)}</strong> has completed successfully. ` +
      (elementCount > 1
        ? `<strong>${elementCount}</strong> infrastructure elements were created, starting with ID <strong>${infraId}</strong>.</p>`
        : `Infrastructure element ID: <strong>${infraId}</strong>.</p>`),
  )

export const sendProvisioningFailed = async (
  to: string,
  productName: string,
  orderId: number,
): Promise<void> =>
  send(
    to,
    `Provisioning Failed — ${headerSafe(productName)}`,
    `<p>Provisioning for order <strong>#${orderId}</strong> of <strong>${escapeHtml(productName)}</strong> has failed. Please contact your administrator.</p>`,
  )

export const sendDecommissioned = async (
  to: string,
  productName: string,
  infraId: number,
): Promise<void> =>
  send(
    to,
    `Resource Decommissioned — ${headerSafe(productName)}`,
    `<p>The infrastructure element <strong>${infraId}</strong> (<strong>${escapeHtml(productName)}</strong>) has been decommissioned successfully.</p>`,
  )

/**
 * A public comment was added to an order (issue #34).
 *
 * Sent to the orderer and the admins, never to the author. Internal notes send
 * nothing at all — telling the orderer that a note they cannot read exists would
 * leak exactly what the flag is for.
 *
 * The body is included so the recipient can judge whether to act without logging
 * in, and truncated so a pasted stack trace does not become the email.
 */
export const sendOrderComment = async (
  to: string,
  productName: string,
  orderId: number,
  authorName: string,
  body: string,
): Promise<void> => {
  const excerpt = body.length > 500 ? `${body.slice(0, 500)}…` : body
  return send(
    to,
    `New comment on order #${orderId} — ${headerSafe(productName)}`,
    `<p><strong>${escapeHtml(authorName)}</strong> commented on order <strong>#${orderId}</strong> for <strong>${escapeHtml(productName)}</strong>:</p>` +
      // white-space: pre-wrap so a multi-line comment survives; escaped first, so
      // the pre-wrap cannot be used to smuggle markup.
      `<blockquote style="white-space: pre-wrap; border-left: 3px solid #ccc; margin: 0; padding-left: 12px;">${escapeHtml(excerpt)}</blockquote>`,
  )
}
