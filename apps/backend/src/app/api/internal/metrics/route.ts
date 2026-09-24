import { type NextRequest, NextResponse } from 'next/server'
import { createHash, timingSafeEqual } from 'node:crypto'
import { collectPortalMetrics } from '@/lib/metrics/collect'

/**
 * The portal's own metrics, in the Prometheus exposition format (#548: the
 * metric source #117 asks for, and what `infra/grafana/dashboards` reads).
 *
 * GET /api/internal/metrics
 *
 * ── Why `/internal` ────────────────────────────────────────────────────────
 *
 * The scraper is a Prometheus, not a client: it has no session, and the spec at
 * `/api/docs` has exactly one security scheme — a session JWT — which would be
 * wrong for it. So this joins the endpoints the spec deliberately does not
 * document, and `contract.test.ts` names it in that exclusion the way it names
 * the other four: a decision somebody makes, not an omission nobody notices.
 *
 * ── Why a bearer token rather than the family's X-…-Secret header ──────────
 *
 * `X-Drift-Secret` and friends were written for shell scripts, where setting a
 * header is setting a header. Prometheus and Grafana have first-class support
 * for `authorization: credentials:` in a scrape config and in a datasource, and
 * nothing for arbitrary headers before v2.54 — so the standard mechanism is the
 * one that makes the shipped configuration work without a version caveat. The
 * comparison is the same constant-time one the other four use.
 *
 * ── Why it is not merely unauthenticated on the internal network ───────────
 *
 * The response is the shape of the estate: how many elements, which projects
 * have drifted, which integrations are failing. That is operational information
 * about customers, and "the network is private" is an assumption about a
 * deployment this chart does not control. Unconfigured means 503, exactly like
 * the drift and sweep endpoints — a deployment that never set the secret gets no
 * metrics rather than free ones.
 *
 * ── Read-only, so not audited ──────────────────────────────────────────────
 *
 * The internal endpoints that write are audited (`integration.probed` is the
 * administrator-facing one). This one reads rows and renders text, changes
 * nothing and decrypts nothing: no credential is selected by the collector, so
 * there is nothing here an audit entry would be about.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const expected = process.env.METRICS_SECRET

  if (!expected) {
    return NextResponse.json(
      { error: 'Metrics are not configured — set METRICS_SECRET' },
      { status: 503 },
    )
  }

  const provided = bearerToken(req.headers.get('authorization'))
  if (!constantTimeMatch(provided, expected)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await collectPortalMetrics()

  return new NextResponse(body, {
    status: 200,
    headers: {
      // The version is part of the content type by specification, and a scraper
      // that does not recognise it is entitled to refuse the body rather than
      // guess at a dialect.
      'content-type': 'text/plain; version=0.0.4; charset=utf-8',
      // A cached scrape is a scrape that lies about when it was taken, and
      // Prometheus would timestamp the copy rather than the collection.
      'cache-control': 'no-store',
    },
  })
}

/**
 * The token out of an `Authorization: Bearer …` header, or an empty string.
 *
 * Empty rather than throwing on any other scheme: the caller compares the
 * result, and an empty string can only match an empty secret — which the 503
 * above already refused to have. What must NOT happen is a `Basic` header's
 * base64 blob being read as the token, or a `Bearer` with no value silently
 * passing a length check.
 */
const bearerToken = (header: string | null): string => {
  if (!header) return ''
  const match = /^Bearer[ ]+(.+)$/i.exec(header.trim())
  return match ? match[1].trim() : ''
}

/**
 * Compare without leaking the secret's length or a prefix match through timing.
 *
 * Hashed to a fixed width first, since timingSafeEqual throws on a length
 * mismatch — which would itself be an oracle for the length. The reasoning and
 * the shape are `drift-report`'s: this is the fifth endpoint in this codebase
 * using it, and the shared helper is deliberately not extracted until there is a
 * reason to change all five at once.
 */
const constantTimeMatch = (provided: string, expected: string): boolean =>
  timingSafeEqual(
    createHash('sha256').update(provided, 'utf8').digest(),
    createHash('sha256').update(expected, 'utf8').digest(),
  )
