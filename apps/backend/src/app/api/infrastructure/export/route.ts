import { type NextRequest, NextResponse } from 'next/server'
import { requireRole, isAuth } from '@/lib/auth/middleware'
import { toCsv } from '@/lib/csv'
import { requestLang } from '@/lib/http'
import { parseInfraFilters } from '@/lib/services/infraFilters'
import { buildInfraExportRows, type InfraExportRow } from '@/lib/services/infraExport'
import { getBranding } from '@/lib/services/admin/branding'
import PDFDocument from 'pdfkit'

// `parameters` stays LAST: buildCsv drops the final column when parameters were
// not requested, so anything appended after it would be dropped instead.
const HEADER = [
  'id', 'product', 'environment', 'project', 'costCenter', 'status',
  'size', 'element', 'deployedAt', 'parameters',
] as const

const cells = (row: InfraExportRow) => [
  row.id, row.productName, row.environmentName, row.projectName,
  row.costCenter, row.status, row.size, row.element, row.deployedAt, row.parameters,
]

const buildCsv = (rows: InfraExportRow[], includeParameters: boolean): string => {
  // Drop the parameters column entirely when it was not requested, rather than
  // emitting a column of empty cells that looks like "this element has none".
  const keep = includeParameters ? HEADER.length : HEADER.length - 1
  return toCsv([...HEADER].slice(0, keep), rows.map((r) => cells(r).slice(0, keep)))
}

const buildPdf = async (
  rows: InfraExportRow[],
  shopName: string,
  includeParameters: boolean,
): Promise<Buffer> => {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 40, size: 'A4', layout: 'landscape' })
    const chunks: Buffer[] = []
    doc.on('data', (chunk: Buffer) => chunks.push(chunk))
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)

    // The report is branded with the configured shop name so an exported
    // inventory is identifiable once it has left the portal.
    doc.fontSize(16).font('Helvetica-Bold').text(shopName, { align: 'center' })
    doc.fontSize(12).font('Helvetica-Bold').text('Infrastructure Inventory', { align: 'center' })
    doc.fontSize(10).font('Helvetica').text(`Generated: ${new Date().toISOString()}`, { align: 'center' })
    doc.fontSize(10).text(`${rows.length} element(s)`, { align: 'center' })
    doc.moveDown()

    const cols = includeParameters
      ? [
          { label: 'ID', width: 35 },
          { label: 'Product', width: 90 },
          { label: 'Environment', width: 85 },
          { label: 'Project', width: 85 },
          { label: 'Cost Center', width: 85 },
          { label: 'Status', width: 75 },
          { label: 'Size', width: 40 },
          { label: 'Elem', width: 38 },
          { label: 'Deployed', width: 95 },
          { label: 'Parameters', width: 112 },
        ]
      : [
          { label: 'ID', width: 40 },
          { label: 'Product', width: 115 },
          { label: 'Environment', width: 105 },
          { label: 'Project', width: 105 },
          { label: 'Cost Center', width: 105 },
          { label: 'Status', width: 90 },
          { label: 'Size', width: 45 },
          { label: 'Elem', width: 40 },
          { label: 'Deployed', width: 105 },
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
      drawRow(cells(row).slice(0, cols.length).map((v) => String(v ?? '')), y, false)
      y += rowHeight
    }

    doc.end()
  })
}

export async function GET(req: NextRequest) {
  // Admin and above, matching the audit export. The list itself is visible to a
  // project manager, but a downloadable inventory file is a reporting artefact.
  const session = await requireRole('admin')(req)
  if (!isAuth(session)) return session

  const { searchParams } = new URL(req.url)

  // Identical parsing to GET /infrastructure, so "export respects the active
  // filters" is a property of the code rather than of two lists staying in sync.
  const filters = parseInfraFilters(searchParams)
  if (!filters.ok) return NextResponse.json({ error: filters.message }, { status: filters.status })

  const format = searchParams.get('format') ?? 'csv'
  if (format !== 'csv' && format !== 'pdf') {
    return NextResponse.json({ error: 'Invalid format — expected csv or pdf' }, { status: 400 })
  }
  const includeParameters = searchParams.get('includeParameters') === 'true'

  const result = await buildInfraExportRows(session, filters.data, requestLang(req), { includeParameters })
  if (!result.ok) return NextResponse.json({ error: result.message }, { status: result.status })

  if (format === 'pdf') {
    const branding = await getBranding()
    const shopName = branding.ok ? branding.data.shopName : 'Open Hybrid Cloud'
    const pdf = await buildPdf(result.data, shopName, includeParameters)
    return new NextResponse(new Blob([new Uint8Array(pdf)], { type: 'application/pdf' }), {
      headers: { 'Content-Disposition': 'attachment; filename="infrastructure.pdf"' },
    })
  }

  return new NextResponse(buildCsv(result.data, includeParameters), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="infrastructure.csv"',
    },
  })
}
