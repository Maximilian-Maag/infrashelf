import { type NextRequest, NextResponse } from 'next/server'
import { requireAuth, isAuth } from '@/lib/auth/middleware'
import { toCsv } from '@/lib/csv'
import { requestLang } from '@/lib/http'
import { getCostRows, getCostReport, assertMaySeeProject, type CostRowExport } from '@/lib/services/costs'
import { parseCostFilters } from '@/lib/services/costFilters'
import { getBranding } from '@/lib/services/admin/branding'
import PDFDocument from 'pdfkit'

// `price` is the UNIT price and `lineTotalEur` is what reconciles with the report
// total — an order of 20 costs 20 times one (issues #98/#104).
const HEADER = [
  'orderId', 'createdAt', 'project', 'costCenter', 'product', 'environment',
  'size', 'quantity', 'status', 'price', 'currency', 'priceEur', 'lineTotalEur',
  'estimated',
] as const

const cells = (row: CostRowExport) => [
  row.orderId,
  row.createdAt?.toISOString(),
  row.projectName,
  row.costCenter,
  row.productName,
  row.environmentName,
  row.size,
  row.quantity,
  row.status,
  row.price,
  row.currency,
  // Blank rather than 0 when no rate was available: 0 would read as "free".
  row.priceEur === null ? '' : row.priceEur,
  row.lineTotalEur === null ? '' : row.lineTotalEur,
  row.estimated ? 'yes' : 'no',
]

const buildPdf = async (
  rows: CostRowExport[],
  totalEur: number,
  shopName: string,
): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 40, size: 'A4', layout: 'landscape' })
    const chunks: Buffer[] = []
    doc.on('data', (chunk: Buffer) => chunks.push(chunk))
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)

    doc.fontSize(16).font('Helvetica-Bold').text(shopName, { align: 'center' })
    doc.fontSize(12).font('Helvetica-Bold').text('Cost Report', { align: 'center' })
    doc.fontSize(10).font('Helvetica').text(`Generated: ${new Date().toISOString()}`, { align: 'center' })
    doc.fontSize(10).text(`${rows.length} order(s) · total ${totalEur.toFixed(2)} EUR`, { align: 'center' })
    // Said on the document itself, not only in the UI: an exported report outlives
    // the page that produced it.
    doc.fontSize(8).text(
      'Sum of the recorded price of each provisioned order in the range. Not a time-based projection — ' +
      'the catalogue stores no billing period.',
      { align: 'center' },
    )
    doc.moveDown()

    // Widths narrowed rather than the page widened: Size and Qty are short, and
    // the total still has to fit one landscape A4 line.
    const cols = [
      { label: 'Order', width: 42 },
      { label: 'Date', width: 92 },
      { label: 'Project', width: 92 },
      { label: 'Cost Center', width: 92 },
      { label: 'Product', width: 92 },
      { label: 'Environment', width: 82 },
      { label: 'Size', width: 45 },
      { label: 'Qty', width: 28 },
      { label: 'Price', width: 62 },
      { label: 'EUR', width: 65 },
      { label: 'Est.', width: 30 },
    ]

    const rowHeight = 18
    const startX = doc.page.margins.left

    const drawRow = (values: string[], y: number, isHeader: boolean) => {
      let x = startX
      doc.font(isHeader ? 'Helvetica-Bold' : 'Helvetica').fontSize(8)
      if (isHeader) {
        doc.rect(startX, y - 2, cols.reduce((s, c) => s + c.width, 0), rowHeight).fill('#e2e8f0').stroke('#e2e8f0')
        doc.fillColor('black')
      }
      for (let i = 0; i < cols.length; i++) {
        doc.text(values[i] ?? '', x + 2, y, { width: cols[i].width - 4, lineBreak: false, ellipsis: true })
        x += cols[i].width
      }
    }

    let y = doc.y
    drawRow(cols.map((c) => c.label), y, true)
    y += rowHeight

    for (const row of rows) {
      if (y + rowHeight > doc.page.height - doc.page.margins.bottom) {
        doc.addPage()
        y = doc.page.margins.top
        drawRow(cols.map((c) => c.label), y, true)
        y += rowHeight
      }
      drawRow([
        String(row.orderId),
        row.createdAt ? new Date(row.createdAt).toLocaleString('en-GB') : '',
        row.projectName,
        row.costCenter,
        row.productName,
        row.environmentName,
        row.size,
        String(row.quantity),
        `${row.price} ${row.currency}`,
        // The LINE total, so the column sums to the figure in the header.
        row.lineTotalEur === null ? '—' : row.lineTotalEur.toFixed(2),
        row.estimated ? 'yes' : '',
      ], y, false)
      y += rowHeight
    }

    doc.end()
  })

/**
 * CSV/PDF of the cost breakdown (issue #32).
 *
 * One row per counted order rather than the aggregate, so a total can be
 * reconciled — a figure nobody can break down is a figure nobody trusts. Uses the
 * same filter parser as the report, so the two always cover the same orders.
 */
export async function GET(req: NextRequest) {
  const session = await requireAuth(req)
  if (!isAuth(session)) return session

  const { searchParams } = new URL(req.url)
  const filters = parseCostFilters(searchParams)
  if (!filters.ok) return NextResponse.json({ error: filters.message }, { status: filters.status })

  if (filters.data.projectId !== undefined) {
    const allowed = await assertMaySeeProject(session, filters.data.projectId)
    if (!allowed.ok) return NextResponse.json({ error: allowed.message }, { status: allowed.status })
  }

  const format = searchParams.get('format') ?? 'csv'
  if (format !== 'csv' && format !== 'pdf') {
    return NextResponse.json({ error: 'Invalid format — expected csv or pdf' }, { status: 400 })
  }

  const lang = requestLang(req)
  const result = await getCostRows(session, filters.data, lang)
  if (!result.ok) return NextResponse.json({ error: result.message }, { status: result.status })

  if (format === 'pdf') {
    const report = await getCostReport(session, filters.data, lang)
    const branding = await getBranding()
    const pdf = await buildPdf(
      result.data,
      report.ok ? report.data.totalEur : 0,
      branding.ok ? branding.data.shopName : 'Open Hybrid Cloud',
    )
    return new NextResponse(new Blob([new Uint8Array(pdf)], { type: 'application/pdf' }), {
      headers: { 'Content-Disposition': 'attachment; filename="costs.pdf"' },
    })
  }

  return new NextResponse(toCsv([...HEADER], result.data.map(cells)), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="costs.csv"',
    },
  })
}
