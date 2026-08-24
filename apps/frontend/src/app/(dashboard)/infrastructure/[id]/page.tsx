import { auth } from '@/lib/auth'
import { get } from '@/lib/api'
import Link from 'next/link'
import { redirect, notFound } from 'next/navigation'
import type { InfrastructureDetail, Role } from '@open-hybrid-cloud/types'
import { PageHeader } from '@/components/layout/PageHeader'
import { Breadcrumbs } from '@/components/layout/Breadcrumbs'
import { Card } from '@/components/ui/Card'
import { StatusBadge } from '@/components/ui/StatusBadge'
import { InfraActions } from '../InfraActions'
import { getLang } from '@/lib/getLang'
import { t } from '@/lib/i18n'

interface Props {
  params: Promise<{ id: string }>
}

/**
 * One infrastructure element (issue #96).
 *
 * The Terraform outputs are the reason someone opens this page — the endpoint, the
 * generated name, the connection string — so they are the first card on it rather
 * than a disclosure triangle inside a list row, which is where they used to live.
 */
export default async function InfrastructureDetailPage({ params }: Props) {
  const { id } = await params
  const session = await auth()
  if (!session) redirect('/login')

  const token = (session as unknown as { apiToken: string }).apiToken
  const lang = await getLang()
  const role = (session.user as unknown as { role: Role }).role
  // Same bar as the list's actions and the export: these re-fire or tear down real
  // infrastructure.
  const canAct = role === 'admin' || role === 'root'

  let element: InfrastructureDetail
  try {
    element = await get<InfrastructureDetail>(`/api/infrastructure/${id}?lang=${lang}`, token)
  } catch {
    // The API answers 404 for an element outside the caller's scope as well, so
    // this covers "gone" and "not yours" without distinguishing them here either.
    notFound()
  }

  const deploymentFailed = element.orderStatus === 'failed'
  const outputs = Object.entries(element.outputs ?? {})
  const parameters = Object.entries(element.parameters ?? {})
  const pipelines = element.pipelineId ?? []
  // Entries in the status map with no matching pipeline id: a trigger that never
  // started leaves a `trigger-failed:<n>` sentinel whose value is the reason (see
  // fireDestroyTriggers / retryProvisioning). Listing only the ids would hide the
  // one case where nothing ran at all.
  const failedTriggers = Object.entries(element.pipelineStatus ?? {}).filter(
    ([key]) => !pipelines.includes(key),
  )

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <Breadcrumbs
        label={t('breadcrumb', lang)}
        items={[
          { label: t('infrastructureTitle', lang), href: '/infrastructure' },
          { label: element.productName ?? `Product #${element.productId}` },
        ]}
      />
      <PageHeader
        title={element.productName ?? `Product #${element.productId}`}
        subtitle={[element.environmentName, element.projectName].filter(Boolean).join(' · ')}
        actions={
          <div className="flex items-center gap-3">
            {/* A styled Link, not a Button inside a Link: an <a> wrapping a
                <button> is nested interactive content, which the axe gate in
                e2e/a11y.spec.ts rejects and screen readers announce twice. */}
            <Link
              href="/infrastructure"
              className="inline-flex min-h-11 items-center justify-center rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2"
            >
              {t('infrastructureTitle', lang)}
            </Link>
          </div>
        }
      />

      <Card>
        <div className="flex items-start justify-between gap-4">
          <dl className="grid flex-1 grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
            <Field label={t('status', lang)}>
              <span className="flex items-center gap-2">
                <StatusBadge status={deploymentFailed ? 'failed' : element.status} lang={lang} />
                {deploymentFailed && (
                  <span className="text-xs text-slate-500">{t('deploymentFailed', lang)}</span>
                )}
              </span>
            </Field>
            <Field label={t('order', lang)}>
              <Link
                href={`/orders/${element.orderId}`}
                className="hover:underline"
                style={{ color: 'var(--bp-text)' }}
              >
                #{element.orderId}
              </Link>
            </Field>
            <Field label={t('project', lang)}>{element.projectName ?? `#${element.projectId}`}</Field>
            <Field label={t('environment', lang)}>
              {element.environmentName ?? `#${element.environmentId}`}
            </Field>
            <Field label={t('costCenter', lang)}>{element.costCenter ?? '—'}</Field>
            <Field label={t('deployedAt', lang)}>
              {element.deployedAt
                ? new Date(element.deployedAt).toLocaleString(lang)
                : t('notDeployed', lang)}
            </Field>
            {element.scheduledDecommissionAt && (
              <Field label={t('scheduledFor', lang)}>
                {new Date(element.scheduledDecommissionAt).toLocaleString(lang)}
              </Field>
            )}
          </dl>
          <InfraActions item={element} token={token} lang={lang} canRetry={canAct} />
        </div>
      </Card>

      {/* The reason this page exists */}
      <Card title={t('outputsTitle', lang)}>
        {outputs.length === 0 ? (
          <p className="text-sm text-slate-600">{t('noOutputs', lang)}</p>
        ) : (
          <dl className="divide-y divide-slate-100">
            {outputs.map(([key, value]) => (
              <div key={key} className="flex flex-col gap-1 py-2 sm:flex-row sm:items-baseline sm:gap-4">
                <dt className="min-w-48 font-mono text-xs text-slate-500">{key}</dt>
                <dd className="break-all font-mono text-sm text-slate-900">{value}</dd>
              </div>
            ))}
          </dl>
        )}
      </Card>

      <Card title={t('parameters', lang)}>
        {parameters.length === 0 ? (
          <p className="text-sm text-slate-600">{t('noParameters', lang)}</p>
        ) : (
          <>
            <dl className="divide-y divide-slate-100">
              {parameters.map(([key, value]) => (
                <div key={key} className="flex flex-col gap-1 py-2 sm:flex-row sm:items-baseline sm:gap-4">
                  <dt className="min-w-48 font-mono text-xs text-slate-500">{key}</dt>
                  <dd className="break-all font-mono text-sm text-slate-900">{value}</dd>
                </div>
              ))}
            </dl>
            {element.redactedParameters?.length > 0 && (
              <p className="mt-3 text-xs text-slate-500">
                {t('sensitiveRedacted', lang)} {element.redactedParameters.join(', ')}
              </p>
            )}
          </>
        )}
      </Card>

      <Card title={t('pipelines', lang)}>
        {pipelines.length === 0 && failedTriggers.length === 0 ? (
          <p className="text-sm text-slate-600">{t('noPipelines', lang)}</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {pipelines.map((pipelineId) => (
              <li key={pipelineId} className="flex items-baseline justify-between gap-4 py-2">
                <span className="font-mono text-xs text-slate-700">{pipelineId}</span>
                <span className="text-xs text-slate-500">
                  {/* The status comes from the run these ids belong to — the order
                      for a provisioning run, the element for a teardown — which the
                      API resolves via pipelinePhase. */}
                  {element.pipelineStatus?.[pipelineId] ?? t('statusPending', lang)}
                </span>
              </li>
            ))}
            {failedTriggers.map(([key, reason]) => (
              <li key={key} className="flex items-baseline justify-between gap-4 py-2">
                <span className="font-mono text-xs text-slate-700">{key}</span>
                <span className="text-xs text-red-700">{reason}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="mt-0.5 text-sm text-slate-900">{children}</dd>
    </div>
  )
}
