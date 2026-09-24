import { describe, it, expect } from 'vitest'
import { CATALOG, type MetricName } from './catalog'
import { renderPrometheus } from './render'

/**
 * The exposition format, which has a few rules that a scraper refuses a whole
 * response over rather than half of it.
 *
 * Tested without a database on purpose: every rule here is about text, and a
 * rule about text that is only checked through a seeded Postgres is a rule that
 * fails in a full run and passes alone.
 */
describe('renderPrometheus', () => {
  it('writes HELP and TYPE once per family, in catalogue order', () => {
    const text = renderPrometheus([
      { name: 'infrashelf_project_info', labels: { project_id: 2, name: 'beta' }, value: 1 },
      { name: 'infrashelf_element_drifted', labels: { element_id: 1 }, value: 1 },
    ])

    const lines = text.trimEnd().split('\n')
    // drifted is declared before project_info, so its block comes first — the
    // order of the response is the order of the catalogue, not of the collector.
    expect(lines[0]).toBe(`# HELP infrashelf_element_drifted ${CATALOG[2].help}`)
    expect(lines[1]).toBe('# TYPE infrashelf_element_drifted gauge')
    expect(lines[2]).toBe('infrashelf_element_drifted{element_id="1"} 1')
    expect(lines[3]).toContain('# HELP infrashelf_project_info')

    // Once, not once per sample: a second HELP line for one family is a parse
    // error at scrape time, and a family emitted twice is how that happens.
    expect(text.match(/# HELP/g)).toHaveLength(2)
    expect(text.match(/# TYPE/g)).toHaveLength(2)
  })

  it('emits nothing for a declared family with no samples', () => {
    const text = renderPrometheus([
      { name: 'infrashelf_metrics_generated_timestamp_seconds', value: 1_760_000_000 },
    ])

    expect(text).toBe(
      `# HELP infrashelf_metrics_generated_timestamp_seconds ${CATALOG[0].help}\n` +
        '# TYPE infrashelf_metrics_generated_timestamp_seconds gauge\n' +
        'infrashelf_metrics_generated_timestamp_seconds 1760000000\n',
    )
    // The other fourteen declared families are absent rather than empty, which is
    // what a Prometheus reads as "this estate has no elements".
    for (const metric of CATALOG.slice(1)) {
      expect(text).not.toContain(metric.name)
    }
  })

  it('sorts series within a family by their labels, so two scrapes differ only by what changed', () => {
    const text = renderPrometheus([
      { name: 'infrashelf_element_drifted', labels: { element_id: 10 }, value: 1 },
      { name: 'infrashelf_element_drifted', labels: { element_id: 9 }, value: 1 },
      { name: 'infrashelf_element_drifted', labels: { element_id: '10', project_id: 1 }, value: 1 },
    ])

    expect(text.trimEnd().split('\n').slice(2)).toEqual([
      // Sorted as rendered text, so a label set that is a prefix of another sorts
      // after it — `,` precedes `}`. What matters is that the order is a property
      // of the labels rather than of the order the collector happened to push.
      'infrashelf_element_drifted{element_id="10",project_id="1"} 1',
      'infrashelf_element_drifted{element_id="10"} 1',
      'infrashelf_element_drifted{element_id="9"} 1',
    ])
  })

  it('escapes the three characters a label value cannot carry raw', () => {
    const text = renderPrometheus([
      {
        name: 'infrashelf_project_info',
        // A project name is operator input, so all three are reachable: a quote
        // would end the value early, and a newline would end the LINE — leaving
        // whatever followed to be parsed as the next sample.
        labels: { project_id: 1, name: 'quote " back\\slash\nnewline' },
        value: 1,
      },
    ])

    expect(text).toContain('infrashelf_project_info{name="quote \\" back\\\\slash\\nnewline",project_id="1"} 1')
    expect(text.trimEnd().split('\n')).toHaveLength(3)
  })

  it('refuses a metric with no declaration, rather than scraping it undocumented', () => {
    expect(() =>
      renderPrometheus([{ name: 'infrashelf_invented' as MetricName, value: 1 }]),
    ).toThrow(/no declaration in the catalogue/)
  })

  it('refuses an invalid metric name', () => {
    expect(() => renderPrometheus([{ name: 'infrashelf bad name' as MetricName, value: 1 }])).toThrow(
      /invalid metric name/,
    )
  })

  it('refuses an invalid or reserved label name', () => {
    expect(() =>
      renderPrometheus([{ name: 'infrashelf_orders', labels: { 'not a label': 'x' }, value: 1 }]),
    ).toThrow(/invalid label name/)

    // `__name__` is how the format itself carries a metric name; emitting it as
    // a label produces a series whose name is not the one a panel asked for.
    expect(() =>
      renderPrometheus([{ name: 'infrashelf_orders', labels: { __name__: 'x' }, value: 1 }]),
    ).toThrow(/reserved label name/)
  })

  it('refuses a duplicate series, which Prometheus answers with a parse error', () => {
    expect(() =>
      renderPrometheus([
        { name: 'infrashelf_project_info', labels: { project_id: 1, name: 'a' }, value: 1 },
        { name: 'infrashelf_project_info', labels: { name: 'a', project_id: 1 }, value: 1 },
      ]),
    ).toThrow(/same series twice/)
  })

  it('refuses a non-finite value', () => {
    expect(() =>
      renderPrometheus([{ name: 'infrashelf_orders', labels: { status: 'pending' }, value: NaN }]),
    ).toThrow(/non-finite value/)
  })
})
