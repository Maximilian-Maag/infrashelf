import { type NextRequest, NextResponse } from 'next/server'
import { randomBytes } from 'crypto'
import { requireAuth, isAuth } from '@/lib/auth/middleware'

/**
 * Locked to this origin, because the page is authenticated.
 *
 * `script-src 'self'` is the directive that matters: the assets used to come
 * from unpkg.com at a floating `@5` with no integrity hash, so a CDN compromise
 * or a hostile 5.x publish would have run as the signed-in user against this API
 * (issue #146). They are now committed under public/swagger-ui/, copied from the
 * release pnpm-lock.yaml pins by `pnpm --filter backend vendor:swagger-ui`.
 *
 * The permissive parts are deliberate and each covers something Swagger UI does:
 * `'unsafe-inline'` for styles (it sets element styles as it renders), `data:`
 * and `blob:` images (inline icons, and downloading a "Try it out" response
 * body). Scripts get a per-request nonce rather than `'unsafe-inline'`, which is
 * what keeps the one inline block below from also permitting an injected one.
 */
const csp = (nonce: string) =>
  [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ')

export async function GET(req: NextRequest) {
  const session = await requireAuth(req)
  if (!isAuth(session)) return session

  const nonce = randomBytes(16).toString('base64')

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Open Hybrid Cloud API Docs</title>
  <link rel="stylesheet" href="/swagger-ui/swagger-ui.css" />
  <style>
    body { margin: 0; padding: 0; }
    #swagger-ui { max-width: 1200px; margin: 0 auto; }
  </style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="/swagger-ui/swagger-ui-bundle.js" nonce="${nonce}"></script>
  <script nonce="${nonce}">
    window.onload = () => {
      SwaggerUIBundle({
        url: '/api/docs/spec',
        dom_id: '#swagger-ui',
        presets: [SwaggerUIBundle.presets.apis],
        deepLinking: true,
      })
    }
  </script>
</body>
</html>`

  return new NextResponse(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': csp(nonce),
      // The nonce is single-use, and the page is behind requireAuth either way.
      'Cache-Control': 'no-store',
    },
  })
}
