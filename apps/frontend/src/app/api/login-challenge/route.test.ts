import { describe, it, expect, vi, afterEach } from 'vitest'
import { POST } from './route'

const makeReq = (body: unknown) =>
  new Request('http://localhost/api/login-challenge', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

const mockBackend = (body: unknown, status = 200) => {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('POST /api/login-challenge', () => {
  it('reports that a code is needed, and passes the challenge through', async () => {
    mockBackend({ mfaRequired: true, mfaToken: 'challenge', expiresIn: 300 })
    const body = await (await POST(makeReq({ email: 'root@x.dev', password: 'pw' }))).json()
    expect(body).toEqual({
      ok: true,
      mfaRequired: true,
      mfaToken: 'challenge',
      // No `methods` from the backend is an account with no key — and, for an
      // older backend, the shape that predates them. Both mean "the code field".
      methods: [],
      webauthnOptions: null,
    })
  })

  // Issue #197 part 2. The WebAuthn options ride along with the challenge rather
  // than costing a second pre-auth round trip; see the route for why that is
  // worth more than a tidier endpoint.
  describe('when the account holds a security key', () => {
    /** Backend answers the challenge first, then the options request. */
    const mockChallengeThenOptions = (options: unknown, optionsOk = true) => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            mfaRequired: true,
            mfaToken: 'challenge',
            expiresIn: 300,
            methods: ['webauthn', 'totp'],
          }),
        })
        .mockResolvedValueOnce({ ok: optionsOk, status: optionsOk ? 200 : 500, json: async () => options })
      vi.stubGlobal('fetch', fetchMock)
      return fetchMock
    }

    it('fetches the request options and hands them to the form', async () => {
      const fetchMock = mockChallengeThenOptions({ challenge: 'abc', allowCredentials: [] })
      const body = await (await POST(makeReq({ email: 'root@x.dev', password: 'pw' }))).json()

      expect(body.methods).toEqual(['webauthn', 'totp'])
      expect(body.webauthnOptions).toEqual({ challenge: 'abc', allowCredentials: [] })
      // The options request carries the challenge, which is what proves the
      // password step to a route that opens nothing.
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ mfaToken: 'challenge' })
    })

    it('still returns the challenge when the options cannot be built', async () => {
      // Not a failed sign-in: the account may hold an authenticator app too, and
      // `methods` is what the form reads to decide what to offer.
      mockChallengeThenOptions({ error: 'boom' }, false)
      const body = await (await POST(makeReq({ email: 'root@x.dev', password: 'pw' }))).json()

      expect(body.mfaToken).toBe('challenge')
      expect(body.webauthnOptions).toBeNull()
      expect(body.methods).toEqual(['webauthn', 'totp'])
    })

    it('does not ask for options when the account has no key', async () => {
      const fetchMock = mockBackend({
        mfaRequired: true,
        mfaToken: 'challenge',
        expiresIn: 300,
        methods: ['totp'],
      })
      const body = await (await POST(makeReq({ email: 'root@x.dev', password: 'pw' }))).json()

      expect(body.webauthnOptions).toBeNull()
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })
  })

  it('says only "no code needed" on the no-second-factor path', async () => {
    mockBackend({ mfaRequired: false })
    const res = await POST(makeReq({ email: 'root@x.dev', password: 'pw' }))
    expect(await res.json()).toEqual({ ok: true, mfaRequired: false })
  })

  /**
   * Belt and braces. `challengeOnly` means the backend mints nothing to leak —
   * but if that ever regressed, this route still must not put a session token in
   * JavaScript's reach outside NextAuth, where it would have no cookie, no expiry
   * handling and no sign-out.
   */
  it('never returns a session token, even if the backend sends one', async () => {
    mockBackend({ token: 'a.real.session.token', user: { id: 1, email: 'root@x.dev', name: 'R', role: 'root' } })
    const res = await POST(makeReq({ email: 'root@x.dev', password: 'pw' }))
    const text = await res.text()

    expect(JSON.parse(text)).toEqual({ ok: true, mfaRequired: false })
    expect(text).not.toContain('a.real.session.token')
    expect(text).not.toContain('token')
  })

  it('passes a 401 through so the form can say the credentials were wrong', async () => {
    mockBackend({ error: 'Invalid credentials' }, 401)
    const res = await POST(makeReq({ email: 'root@x.dev', password: 'nope' }))
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ ok: false, error: 'Invalid credentials' })
  })

  it('passes a 429 through with the backend message, which says how long to wait', async () => {
    mockBackend({ error: 'Too many login attempts. Try again in 15 minutes.' }, 429)
    const res = await POST(makeReq({ email: 'root@x.dev', password: 'pw' }))
    expect(res.status).toBe(429)
    expect((await res.json()).error).toMatch(/15 minutes/)
  })

  describe('passwordless step one (#241)', () => {
    it('asks the backend for options that name no account', async () => {
      const fetchMock = mockBackend({ challenge: 'c', rpId: 'localhost' })

      const res = await POST(makeReq({ passwordless: true }))

      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({ challenge: 'c' })
      // The unauthenticated endpoint, reached server-side. Written against
      // `/api/proxy` this 401'd for every visitor, because the proxy checks the
      // session and nobody on the login page has one.
      const [url, init] = fetchMock.mock.calls[0]
      expect(url).toContain('/api/auth/webauthn/options')
      expect(url).not.toContain('/api/proxy')
      expect(init.method).toBe('POST')
    })

    it('sends no credentials with it', async () => {
      // There are none to send. A body carrying an email would make this an
      // account oracle for anyone who can reach the login page.
      const fetchMock = mockBackend({ challenge: 'c' })
      await POST(makeReq({ passwordless: true, email: 'someone@test.dev', password: 'hunter2' }))

      const [, init] = fetchMock.mock.calls[0]
      expect(init.body).toBeUndefined()
    })

    it('passes a backend refusal through rather than reporting success', async () => {
      mockBackend({ error: 'Too many sign-in attempts.' }, 429)
      const res = await POST(makeReq({ passwordless: true }))
      expect(res.status).toBe(429)
    })

    it('answers 502 when the backend cannot be reached', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))
      const res = await POST(makeReq({ passwordless: true }))
      expect(res.status).toBe(502)
    })

    it('does not take the passwordless branch without the flag', async () => {
      // `passwordless: false`, or absent, is an ordinary password check — the
      // branch is keyed on `=== true`, not on truthiness.
      const fetchMock = mockBackend({ mfaRequired: false })
      await POST(makeReq({ email: 'a@test.dev', password: 'pw', passwordless: false }))
      expect(fetchMock.mock.calls[0][0]).toContain('/api/auth/login')
    })
  })

  it('rejects a request with no credentials without calling the backend', async () => {
    const fetchMock = mockBackend({})
    for (const body of [{}, { email: 'a@b.c' }, { password: 'pw' }, { email: 1, password: 2 }]) {
      const res = await POST(makeReq(body))
      expect(res.status, JSON.stringify(body)).toBe(400)
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reports an unreachable backend rather than throwing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))
    const res = await POST(makeReq({ email: 'root@x.dev', password: 'pw' }))
    expect(res.status).toBe(502)
    expect((await res.json()).ok).toBe(false)
  })

  it('forwards the credentials to the backend login endpoint and nowhere else', async () => {
    const fetchMock = mockBackend({ mfaRequired: true, mfaToken: 'c', expiresIn: 300 })
    await POST(makeReq({ email: 'root@x.dev', password: 'pw' }))

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toMatch(/\/api\/auth\/login$/)
    expect(JSON.parse(String(init.body))).toEqual({
      email: 'root@x.dev',
      password: 'pw',
      rememberMe: false,
      challengeOnly: true,
    })
  })

  /**
   * The whole point of `challengeOnly`: this hop checks a password, and opening a
   * session here would leave a row in the user's own session list that no browser
   * holds (#37).
   */
  it('always asks with challengeOnly, so this hop can never open a session', async () => {
    for (const backendSays of [
      { mfaRequired: true, mfaToken: 'c', expiresIn: 300 },
      { mfaRequired: false },
    ]) {
      const fetchMock = mockBackend(backendSays)
      await POST(makeReq({ email: 'root@x.dev', password: 'pw' }))
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
      expect(JSON.parse(String(init.body)).challengeOnly).toBe(true)
    }
  })

  it('carries "remember me" to the password step, where it is sealed into the challenge', async () => {
    const fetchMock = mockBackend({ mfaRequired: true, mfaToken: 'c', expiresIn: 300 })
    await POST(makeReq({ email: 'root@x.dev', password: 'pw', rememberMe: true }))
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(JSON.parse(String(init.body)).rememberMe).toBe(true)
  })
})
