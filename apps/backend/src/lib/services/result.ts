export type Ok<T> = { ok: true; data: T }
/**
 * A refusal, with an optional machine-readable `code`.
 *
 * The message is for the person who read it; the code is for the caller that has
 * to DO something about it. Two refusals that need different handling otherwise
 * reach a client as the same 409 with different prose, and the only way to tell
 * them apart is to match on the sentence — which breaks the moment somebody
 * edits it (#509).
 */
export type Err = { ok: false; status: number; message: string; code?: string }
export type Result<T> = Ok<T> | Err
export const ok = <T>(data: T): Ok<T> => ({ ok: true, data })
export const err = (status: number, message: string, code?: string): Err => ({
  ok: false,
  status,
  message,
  code,
})
