import type { ProductSnapshot } from '@open-hybrid-cloud/types'

/**
 * The product name an order should be shown under, in the reader's language.
 *
 * The snapshot is deliberately the FIRST place to look, not the last: it records
 * what was ordered, and the live catalogue may have been renamed, retranslated or
 * retired since (issue #38). What changes here is only WHICH of the recorded names
 * is picked — never whether history is rewritten, because every candidate below is
 * a string the snapshot itself froze at capture time (issue #162).
 *
 * The chain is the catalogue's, applied to the snapshot's own map: the reader's
 * language, then English, then German, then whatever was recorded, in a stable
 * order so the same order does not read differently on two visits. `productName`
 * is the last step rather than the first because a snapshot taken before
 * `productNames` existed has only that — it is the whole answer for an old order
 * and a redundant copy for a new one.
 *
 * Null when there is no snapshot at all, which is what the caller's fallback to the
 * live product is for.
 */
export function snapshotProductName(
  snapshot: ProductSnapshot | null | undefined,
  lang: string,
): string | null {
  if (!snapshot) return null
  const names = snapshot.productNames
  if (names) {
    const code = lang.split('-')[0].toLowerCase()
    const recorded =
      names[code] ??
      names.en ??
      names.de ??
      // Sorted, so "whatever was recorded" is the same string every time rather
      // than whichever key the object happens to enumerate first.
      names[Object.keys(names).sort()[0]]
    if (recorded) return recorded
  }
  return snapshot.productName || null
}
