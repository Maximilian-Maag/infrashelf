import { type NextRequest } from 'next/server'
import { requireAuth, isAuth } from '@/lib/auth/middleware'
import { toResponse } from '@/lib/http'
import { revokeSession } from '@/lib/services/sessions'

/**
 * End the session this request is made with (#425).
 *
 * The sign-out button used to do this in two round trips: `GET /api/sessions` to
 * find which of the caller's sessions was `current`, then `DELETE` it by id. The
 * first call exists only to learn an id the backend already has on the
 * authenticated caller, and both had to fit inside one 3s deadline — the bound
 * #359 put on sign-out so it can never hang. On a loaded runner two proxied round
 * trips did not fit, the deadline blew, and the revoke was skipped: the cookie
 * cleared, the session stayed live on the server, and #391's resurrection race
 * decided whether it came back. Intermittently, which is what `signout.spec` saw.
 *
 * Same deadline, half the work. There is no new authorisation surface either:
 * the session revoked is `caller.sessionId`, read off the verified token, so
 * there is nothing in the request that could name somebody else's.
 */
export async function DELETE(req: NextRequest) {
  const session = await requireAuth(req)
  if (!isAuth(session)) return session

  return toResponse(await revokeSession(session, session.sessionId))
}
