import { auth } from '@/lib/auth'
import { get } from '@/lib/api'
import { redirect, notFound } from 'next/navigation'
import type { Order, OrderComment, Role } from '@open-hybrid-cloud/types'
import { PageHeader } from '@/components/layout/PageHeader'
import { Breadcrumbs } from '@/components/layout/Breadcrumbs'
import { Card } from '@/components/ui/Card'
import { Alert } from '@/components/ui/Alert'
import { StatusBadge } from '@/components/ui/StatusBadge'
import { ButtonLink } from '@/components/ui/Button'
import { getLang } from '@/lib/getLang'
import { snapshotProductName } from '@/lib/snapshotName'
import { t } from '@/lib/i18n'
import { OrderComments } from './OrderComments'

interface Props {
  params: Promise<{ id: string }>
}

export default async function OrderDetailPage({ params }: Props) {
  const { id } = await params
  const session = await auth()
  if (!session) redirect('/login')

  const token = (session as unknown as { apiToken: string }).apiToken
  const lang = await getLang()

  let order: Order
  try {
    order = await get<Order>(`/api/orders/${id}?lang=${lang}`, token)
  } catch {
    notFound()
  }

  const role = (session.user as unknown as { role: Role }).role
  // The API already excludes internal notes for a non-admin, so nothing has to be
  // filtered here — this only decides whether the WRITE control is offered.
  const canWriteInternal = role === 'admin' || role === 'root'
  const currentUserId = Number((session.user as unknown as { id: string }).id)

  // Non-fatal: a comments outage should cost the thread, not the order page.
  let comments: OrderComment[] = []
  try {
    comments = (await get<OrderComment[]>(`/api/orders/${id}/comments`, token)) ?? []
  } catch {
    /* empty */
  }

  const paramEntries = Object.entries(order.parameters ?? {})

  // Issue #38: render from the snapshot taken when the order was placed, not from
  // the live product. Showing today's price and description on a months-old order
  // silently misreports what was approved. Orders placed before snapshots existed
  // have none, and the page says so rather than pretending.
  const snapshot = order.productSnapshot ?? null
  // The snapshot records the DEFINITIONS that applied; the submitted values live in
  // order.parameters. Pairing them lets the page label a value with the definition
  // it was validated against, even if that definition has since been removed.
  const snapshotParams = new Map((snapshot?.parameters ?? []).map((p) => [p.name, p]))

  // Absent on an order placed before quantity existed, which asked for exactly one.
  const quantity = order.quantity && order.quantity >= 1 ? order.quantity : 1
  const unitPrice = Number(snapshot?.price ?? '0')
  const lineTotal = Number.isFinite(unitPrice) ? (unitPrice * quantity).toFixed(2) : snapshot?.price

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <Breadcrumbs
        label={t('breadcrumb', lang)}
        items={[
          { label: t('orders', lang), href: '/orders' },
          { label: `${t('order', lang)} #${order.id}` },
        ]}
      />
      <PageHeader
        title={`${t('order', lang)} #${order.id}`}
        actions={
          <ButtonLink href="/orders" variant="secondary" size="sm">
            {t('backToOrders', lang)}
          </ButtonLink>
        }
      />

      <Card title={t('orderDetails', lang)}>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-4 text-sm">
          <div>
            <dt className="font-medium text-slate-500">{t('product', lang)}</dt>
            <dd className="text-slate-900">
              {snapshotProductName(snapshot, lang) ?? order.productName ?? `#${order.productId}`}
            </dd>
          </div>
          {snapshot && (
            <div>
              <dt className="font-medium text-slate-500">{t('price', lang)}</dt>
              <dd className="text-slate-900">
                {/* The snapshot's price is the UNIT price that applied — the size's
                    once sizes exist (issue #98). Multiplied out here because the
                    order is for `quantity` elements and the line total is the
                    number the reader is looking for. */}
                {quantity > 1
                  ? `${lineTotal} ${snapshot.currency} (${quantity} × ${snapshot.price} ${snapshot.currency})`
                  : `${snapshot.price} ${snapshot.currency}`}
              </dd>
            </div>
          )}
          {/* Shown whenever the order named a size, snapshot or not: the label from
              the snapshot is what it read as at the time, the code survives a
              rename. */}
          {(snapshot?.sizeCode ?? order.sizeCode) && (
            <div>
              <dt className="font-medium text-slate-500">{t('size', lang)}</dt>
              <dd className="text-slate-900">
                {snapshot?.sizeLabel || snapshot?.sizeCode || order.sizeCode}
              </dd>
            </div>
          )}
          {quantity > 1 && (
            <div>
              <dt className="font-medium text-slate-500">{t('quantity', lang)}</dt>
              {/* One order, N infrastructure elements (issue #104) — one approval
                  covered all of them. */}
              <dd className="text-slate-900">{quantity}</dd>
            </div>
          )}
          <div>
            <dt className="font-medium text-slate-500">{t('status', lang)}</dt>
            <dd><StatusBadge status={order.status} lang={lang} /></dd>
          </div>
          <div>
            <dt className="font-medium text-slate-500">{t('environment', lang)}</dt>
            <dd className="text-slate-900">{order.environmentName ?? `#${order.environmentId}`}</dd>
          </div>
          <div>
            <dt className="font-medium text-slate-500">{t('project', lang)}</dt>
            <dd className="text-slate-900">{order.projectName ?? `#${order.projectId}`}</dd>
          </div>
          <div>
            <dt className="font-medium text-slate-500">{t('orderedBy', lang)}</dt>
            <dd className="text-slate-900">{order.userName ?? `User #${order.userId}`}</dd>
          </div>
          <div>
            <dt className="font-medium text-slate-500">{t('created', lang)}</dt>
            <dd className="text-slate-900">{new Date(order.createdAt).toLocaleString(lang)}</dd>
          </div>
          <div>
            <dt className="font-medium text-slate-500">{t('updated', lang)}</dt>
            <dd className="text-slate-900">{new Date(order.updatedAt).toLocaleString(lang)}</dd>
          </div>
          {order.costCenterId && (
            <div>
              <dt className="font-medium text-slate-500">{t('costCenter', lang)}</dt>
              <dd className="text-slate-900">#{order.costCenterId}</dd>
            </div>
          )}
        </dl>

        <p className="mt-4 text-xs text-slate-500">
          {snapshot
            ? `${t('asOrdered', lang)} — ${t('asOrderedHint', lang)}`
            : t('noSnapshotHint', lang)}
        </p>

        {order.status === 'rejected' && order.rejectionNote && (
          <Alert className="mt-4">
            <p className="text-sm font-medium text-red-800 mb-1">{t('rejectionNote', lang)}</p>
            <p className="text-sm text-red-700">{order.rejectionNote}</p>
          </Alert>
        )}
      </Card>

      {paramEntries.length > 0 && (
        <Card title={t('parameters', lang)}>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm divide-y divide-slate-100">
              <thead>
                <tr>
                  <th className="text-left py-2 pr-4 font-medium text-slate-500">{t('parameter', lang)}</th>
                  <th className="text-left py-2 font-medium text-slate-500">{t('value', lang)}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {paramEntries.map(([key, val]) => {
                  const def = snapshotParams.get(key)
                  return (
                    <tr key={key}>
                      <td className="py-2 pr-4 text-xs text-slate-600">
                        {/* The label as it was at order time; the raw name stays
                            visible because that is what reaches the pipeline. */}
                        {def?.label ? <span className="text-slate-900">{def.label} </span> : null}
                        <span className="font-mono">{key}</span>
                      </td>
                      <td className="py-2 font-mono text-xs text-slate-900 break-all">
                        {def?.sensitive ? '••••••' : val}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <Card title={`${t('comments', lang)}${comments.length > 0 ? ` (${comments.length})` : ''}`}>
        <OrderComments
          orderId={order.id}
          initialComments={comments}
          currentUserId={currentUserId}
          canWriteInternal={canWriteInternal}
          token={token}
          lang={lang}
        />
      </Card>

      {order.pipelineId && order.pipelineId.length > 0 && (
        <Card title={t('pipelineIds', lang)}>
          <ul className="space-y-1">
            {order.pipelineId.map((pid, i) => (
              <li key={i} className="font-mono text-xs text-slate-700 bg-slate-50 rounded px-3 py-1.5">
                {pid}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  )
}
