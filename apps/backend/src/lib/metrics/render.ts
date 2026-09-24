/**
 * The exposition format, by hand (#548).
 *
 * ── Why not a client library ────────────────────────────────────────────────
 *
 * `prom-client` exists and would be the right answer for counters in a request
 * path, which is where it is normally used. This endpoint is the other case: a
 * fixed, small set of gauges read out of Postgres on demand. A library would add
 * a process-global registry, its own startup side effects and a dependency to
 * audit, in exchange for escaping rules that are four `replace` calls.
 *
 * What the format does require, and what is easy to get wrong:
 *
 * - A `# HELP` and `# TYPE` line before a family's samples, ONCE per family in
 *   the response, and no family may appear twice — a second block is a parse
 *   error at scrape time ("second HELP line"), not a merge.
 * - Label values are escaped for backslash, double quote and newline; HELP text
 *   for backslash and newline (a quote is not special there, and escaping it
 *   anyway produces a value an operator reads with the backslash in it).
 * - A duplicate series — same name, same label set — is refused by Prometheus,
 *   so emitting one is a silent way to break a scrape. This throws instead,
 *   because the bug is in a collector and the person who can fix it is the
 *   person reading a test failure.
 */
import { CATALOG, type MetricSample, type MetricName } from './catalog'

export type Sample = MetricSample

/** https://prometheus.io/docs/concepts/data_model/#metric-names-and-labels */
const METRIC_NAME_PATTERN = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/
const LABEL_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/

/**
 * Label names that Prometheus reserves. `__name__` in particular is how a
 * client sends a metric name, so emitting it as a label produces a series
 * whose name is not the one the dashboard asked for.
 */
const RESERVED_LABEL_PREFIX = '__'

/**
 * A label VALUE is escaped for the three characters that would otherwise end
 * the quoted string or be read as an escape. Order matters: backslash first, or
 * the backslashes this adds are escaped by the next rule.
 */
const escapeLabelValue = (value: string): string =>
  value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')

/** HELP text is not quoted, so only an escape and a newline can break the line. */
const escapeHelp = (help: string): string => help.replace(/\\/g, '\\\\').replace(/\n/g, '\\n')

const formatValue = (value: number, metric: MetricName): string => {
  if (!Number.isFinite(value)) {
    // NaN and Infinity are representable in the format but mean something
    // specific (a division that had no answer), and neither is true here.
    throw new Error(`metric ${metric} has a non-finite value (${value})`)
  }
  return String(value)
}

const renderLabels = (metric: MetricName, labels: Readonly<Record<string, string | number>>): string => {
  const names = Object.keys(labels).sort()
  if (!names.length) return ''
  const parts = names.map((name) => {
    if (!LABEL_NAME_PATTERN.test(name)) {
      throw new Error(`metric ${metric} has an invalid label name (${name})`)
    }
    if (name.startsWith(RESERVED_LABEL_PREFIX)) {
      throw new Error(`metric ${metric} uses the reserved label name ${name}`)
    }
    return `${name}="${escapeLabelValue(String(labels[name]))}"`
  })
  return `{${parts.join(',')}}`
}

/**
 * Turn samples into text/plain; version=0.0.4.
 *
 * Families are emitted in catalogue order and series are sorted by their label
 * set, so two scrapes of an unchanged estate are byte-identical. That is what
 * makes a diff of two responses a way to see what actually changed, which is how
 * this was checked while it was being written.
 */
export const renderPrometheus = (samples: readonly Sample[]): string => {
  const declared = new Map<string, (typeof CATALOG)[number]>(CATALOG.map((m) => [m.name, m]))
  const families = new Map<string, Sample[]>()

  for (const sample of samples) {
    if (!METRIC_NAME_PATTERN.test(sample.name)) {
      throw new Error(`invalid metric name (${sample.name})`)
    }
    if (!declared.has(sample.name)) {
      throw new Error(
        `metric ${sample.name} has no declaration in the catalogue — it would be scraped ` +
          `but not documented, and no dashboard test can know about it`,
      )
    }
    const family = families.get(sample.name)
    if (family) family.push(sample)
    else families.set(sample.name, [sample])
  }

  const lines: string[] = []

  for (const declaration of CATALOG) {
    const family = families.get(declaration.name)
    if (!family || family.length === 0) continue

    lines.push(`# HELP ${declaration.name} ${escapeHelp(declaration.help)}`)
    lines.push(`# TYPE ${declaration.name} ${declaration.type}`)

    const series = family.map((sample) => {
      const labels = renderLabels(sample.name, sample.labels ?? {})
      return {
        sortKey: labels,
        line: `${sample.name}${labels} ${formatValue(sample.value, sample.name)}`,
      }
    })
    series.sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0))

    const seen = new Set<string>()
    for (const { sortKey, line } of series) {
      if (seen.has(sortKey)) {
        throw new Error(
          `metric ${declaration.name} emitted the same series twice (labels ${sortKey}) — ` +
            `Prometheus refuses a scrape containing a duplicate series`,
        )
      }
      seen.add(sortKey)
      lines.push(line)
    }
  }

  // A trailing newline: the format is line-based and a scraper reading the last
  // line is not required to cope with a missing terminator.
  return `${lines.join('\n')}\n`
}
