import type { SessionUser } from '@open-hybrid-cloud/types'
import {
  REDACTED,
  loadSensitiveParameterNames,
  loadSnapshotSensitiveNames,
  union,
} from '@/lib/services/parameterRedaction'
import { ok, type Result } from '@/lib/services/result'
import { listInfrastructure, type InfraFilters } from '@/lib/services/infrastructure'
import { getCostCentersForInfra } from '@/lib/services/infraCostCenters'

export interface InfraExportRow {
  id: number
  productName: string
  environmentName: string
  projectName: string
  costCenter: string
  status: string
  /** The size this element runs at (issue #98); blank when the offering has none. */
  size: string
  /** "3/20" for element three of an order of twenty (issue #104), else "1/1". */
  element: string
  deployedAt: string
  parameters: string
}

// Re-exported for the export route and its tests, which import it from here.
export { REDACTED } from '@/lib/services/parameterRedaction'

/**
 * Flatten the filtered infrastructure list into export rows.
 *
 * Runs through listInfrastructure so the export is, by construction, the same
 * query the page ran — including the caller's visibility scope. An export that
 * could return rows the list would not is a data leak; one that applies its
 * filters differently is worse than no export at all, because it looks
 * authoritative.
 */
export const buildInfraExportRows = async (
  session: SessionUser,
  filters: InfraFilters,
  lang: string,
  options: { includeParameters?: boolean } = {},
): Promise<Result<InfraExportRow[]>> => {
  const listed = await listInfrastructure(session, filters, lang)
  if (!listed.ok) return listed

  const elements = listed.data
  const costCenters = await getCostCentersForInfra(elements.map((e) => e.orderId))
  // Two sources, unioned per row: the live catalogue, and the sensitivity recorded
  // in each order's own snapshot. The catalogue alone loses the flag as soon as a
  // definition is renamed or deleted — and then an export of an OLD order emits the
  // secret it was placed with verbatim.
  const sensitive = options.includeParameters
    ? await loadSensitiveParameterNames()
    : new Set<string>()
  const sensitivePerOrder = options.includeParameters
    ? await loadSnapshotSensitiveNames(elements.map((e) => e.orderId))
    : new Map<number, Set<string>>()

  return ok(
    elements.map((el) => ({
      id: el.id,
      productName: el.productName ?? `#${el.productId}`,
      environmentName: el.environmentName ?? `#${el.environmentId}`,
      projectName: el.projectName ?? `#${el.projectId}`,
      costCenter: costCenters.get(el.orderId) ?? '',
      status: el.status,
      size: el.sizeCode ?? '',
      // Which of its order's elements this is. An inventory of twenty identical
      // rows is unreadable without it.
      element: `${el.sequence}/${el.orderQuantity ?? el.sequence}`,
      deployedAt: el.deployedAt ? new Date(el.deployedAt).toISOString() : '',
      parameters: options.includeParameters
        ? formatParameters(el.parameters, union(sensitive, sensitivePerOrder.get(el.orderId)))
        : '',
    })),
  )
}

const formatParameters = (
  values: Record<string, string>,
  sensitive: Set<string>,
): string =>
  Object.entries(values ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${sensitive.has(key) ? REDACTED : value}`)
    .join('; ')
