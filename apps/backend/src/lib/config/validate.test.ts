import { describe, it, expect, vi, afterEach } from 'vitest'
import { configProblems, reportConfigProblems, MIN_JWT_SECRET_LENGTH, type ConfigEnv } from './validate'

const validEnv = {
  JWT_SECRET: 'x'.repeat(MIN_JWT_SECRET_LENGTH),
  DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/db',
  // Part of a complete configuration since #413 made this key encrypt CI source
  // tokens and not only integration credentials (#414).
  SECRET_ENCRYPTION_KEY: 'a'.repeat(64),
} satisfies ConfigEnv

/** The variables reported, so a test does not have to care about severity. */
const named = (problems: { variable: string }[]) => problems.map((p) => p.variable)

afterEach(() => vi.restoreAllMocks())

describe('configProblems', () => {
  it('accepts a complete configuration', () => {
    expect(configProblems(validEnv)).toEqual([])
  })

  it('reports a JWT_SECRET that is too short, with its actual length', () => {
    // The shipped backend .env.example had a 23-character value, which fails
    // every login with an error that never leaves the server log.
    const problems = configProblems({ ...validEnv, JWT_SECRET: 'change-me-in-production' })
    expect(problems).toHaveLength(1)
    expect(problems[0].variable).toBe('JWT_SECRET')
    expect(problems[0].message).toContain('23 characters')
  })

  it('distinguishes an unset secret from a short one', () => {
    const problems = configProblems({ ...validEnv, JWT_SECRET: '' })
    expect(problems[0].message).toContain('not set')
  })

  it('accepts a secret of exactly the minimum length', () => {
    expect(configProblems({ ...validEnv, JWT_SECRET: 'a'.repeat(MIN_JWT_SECRET_LENGTH) })).toEqual([])
  })

  it('reports a missing DATABASE_URL', () => {
    const problems = configProblems({ ...validEnv, DATABASE_URL: '' })
    expect(problems.map((p) => p.variable)).toEqual(['DATABASE_URL'])
  })

  it('reports every problem at once rather than the first', () => {
    expect(named(configProblems({} satisfies ConfigEnv))).toEqual([
      'JWT_SECRET',
      'DATABASE_URL',
      'SECRET_ENCRYPTION_KEY',
    ])
  })

  it('marks what is broken as an error and what is merely missing as a warning', () => {
    const bySeverity = Object.fromEntries(
      configProblems({} satisfies ConfigEnv).map((p) => [p.variable, p.severity]),
    )
    expect(bySeverity).toEqual({
      JWT_SECRET: 'error',
      DATABASE_URL: 'error',
      SECRET_ENCRYPTION_KEY: 'warning',
    })
  })

  describe('SECRET_ENCRYPTION_KEY (issues #111, #414)', () => {
    const key = 'a'.repeat(64)

    it('says nothing when it is a valid key', () => {
      expect(configProblems({ ...validEnv, SECRET_ENCRYPTION_KEY: key })).toEqual([])
    })

    it('warns when it is absent, because a CI source token can no longer be stored', () => {
      // Before #413 absence bought nothing but the integration registry, and
      // reporting it was noise. #413 made the key encrypt CI source access
      // tokens too, so a deployment without one now refuses a token rotation
      // with a 503 — months later, and with no boot line connecting the two.
      const problems = configProblems({ ...validEnv, SECRET_ENCRYPTION_KEY: undefined })
      expect(named(problems)).toEqual(['SECRET_ENCRYPTION_KEY'])
      expect(problems[0].severity).toBe('warning')
      expect(problems[0].message).toContain('503')
    })

    it('treats an empty string the same as absent, and reports it once', () => {
      // How a compose file with `SECRET_ENCRYPTION_KEY: "${SECRET_ENCRYPTION_KEY:-}"`
      // presents an unset variable — see infra/docker-host/docker-compose.yml.
      // Reported once and not twice: an empty string is also not valid hex, so
      // the two branches have to stay exclusive or the same variable arrives
      // with both severities at boot.
      const problems = configProblems({ ...validEnv, SECRET_ENCRYPTION_KEY: '' })
      expect(named(problems)).toEqual(['SECRET_ENCRYPTION_KEY'])
      expect(problems[0].severity).toBe('warning')
    })

    it('says a missing key is not rotatable, so it is set once per environment', () => {
      const problems = configProblems({ ...validEnv, SECRET_ENCRYPTION_KEY: '' })
      expect(problems[0].message).toContain('own key')
    })

    it('reports a key that is set but the wrong length, as an error', () => {
      const problems = configProblems({ ...validEnv, SECRET_ENCRYPTION_KEY: 'a'.repeat(32) })
      expect(named(problems)).toEqual(['SECRET_ENCRYPTION_KEY'])
      expect(problems[0].severity).toBe('error')
      expect(problems[0].message).toContain('64 hex characters')
    })

    it('reports a key that is the right length but not hex', () => {
      // A base64 key is the likely mistake — 44 characters, or 64 if someone
      // pads it — and it would otherwise be accepted as bytes it is not.
      const problems = configProblems({ ...validEnv, SECRET_ENCRYPTION_KEY: 'z'.repeat(64) })
      expect(named(problems)).toEqual(['SECRET_ENCRYPTION_KEY'])
      expect(problems[0].severity).toBe('error')
    })

    it('warns that a changed key cannot decrypt existing credentials', () => {
      const problems = configProblems({ ...validEnv, SECRET_ENCRYPTION_KEY: 'nope' })
      expect(problems[0].message).toContain('cannot')
    })
  })
})

describe('reportConfigProblems', () => {
  it('writes each error to stderr and returns them', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const problems = reportConfigProblems({ ...validEnv, JWT_SECRET: 'too-short' })

    expect(problems).toHaveLength(1)
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('[config] JWT_SECRET'))
  })

  it('writes a warning to stdout, not stderr, so it pages nobody', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    reportConfigProblems({ ...validEnv, SECRET_ENCRYPTION_KEY: '' })

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[config] SECRET_ENCRYPTION_KEY'))
    expect(err).not.toHaveBeenCalled()
  })

  it('says nothing when the configuration is fine', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    reportConfigProblems(validEnv)
    expect(err).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
  })
})
