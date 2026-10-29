import { describe, it, expect } from 'vitest'
import { MFA_LOCKED_OUT } from './loginErrors'

/**
 * The sign-in failure codes (#240, #245).
 *
 * The value IS the contract: NextAuth carries this identifier through the
 * `CredentialsSignin` error and the URL, and the login form switches on it. A
 * change here silently turns "your second factor is locked, wait" back into
 * "invalid credentials" — the advice that makes a locked-out user keep retrying.
 * So the literal is asserted, not merely the constant.
 */
describe('loginErrors', () => {
  it('names the locked-out second factor exactly as the callback sends it', () => {
    expect(MFA_LOCKED_OUT).toBe('mfa_locked_out')
  })
})
