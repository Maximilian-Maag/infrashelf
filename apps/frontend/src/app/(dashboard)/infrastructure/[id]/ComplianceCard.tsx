import { Card } from '@/components/ui/Card'
import { Alert } from '@/components/ui/Alert'
import { t } from '@/lib/i18n'
import type { InfrastructureDetail } from '@infrashelf/types'

/**
 * Where this element actually stands: what the last refresh found, and what
 * policy says about it (#110, slice 6).
 *
 * The two are one card because neither reads correctly alone. "A policy refuses
 * this element" means one thing about an element that still matches its plan and a
 * different thing about one that has drifted away from it — the policy was written
 * against the order, and the drift is the reason it no longer describes what is
 * running. Showing a verdict without the drift beside it invites the wrong repair.
 *
 * Neither line is a live region: both are page content, painted with the page,
 * not a reaction to something the user just did. The verdict's wording is the
 * policy's own (`policyMessage`), shown as written rather than translated — the
 * portal cannot phrase a rule it did not write, which is the same argument #215
 * settled for `outputsError`.
 */
export function ComplianceCard({ element, lang }: { element: InfrastructureDetail; lang: string }) {
  const outcome = element.lastRefreshOutcome ?? null
  const policy = element.policyOutcome ?? null
  const resources = element.driftSummary?.resources ?? []

  return (
    <Card title={t('complianceTitle', lang)}>
      <div className="space-y-5">
        <section className="space-y-2">
          <h3 className="text-xs font-medium uppercase tracking-wide text-slate-600">
            {t('refreshTitle', lang)}
          </h3>
          <p className="text-sm text-slate-900">{refreshSentence(outcome, lang)}</p>

          {/*
            When drift was found, not when the caret was read: the element records
            the report that found it (and clears it when a later report is clean),
            which is what "has drifted since" means. A clean element carries no
            per-element timestamp — the sweep's own time lives on the report, not on
            every element it touched — so this line appears only when there is
            something to date.
          */}
          {element.driftDetectedAt && (
            <p className="text-xs text-slate-600">
              {t('checkedAt', lang)}: {new Date(element.driftDetectedAt).toLocaleString(lang)}
            </p>
          )}

          {resources.length > 0 && (
            <div>
              <p className="text-xs font-medium text-slate-600">{t('driftResources', lang)}</p>
              <ul className="mt-1 divide-y divide-slate-100">
                {resources.map((resource) => (
                  <li
                    key={resource.address}
                    className="flex flex-col gap-1 py-1 sm:flex-row sm:items-baseline sm:gap-4"
                  >
                    <span className="font-mono text-xs text-slate-700">{resource.address}</span>
                    <span className="font-mono text-xs text-slate-500">{resource.action}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>

        <section className="space-y-2">
          <h3 className="text-xs font-medium uppercase tracking-wide text-slate-600">
            {t('policyTitle', lang)}
          </h3>
          <Alert tone={policyTone(policy)}>
            <p>{policySentence(policy, lang)}</p>
            {/* The rule first, then its words: the rule name is what an operator
                greps for, and the sentence is what explains it. */}
            {element.policyRule && (
              <p className="mt-1 text-xs">
                {t('ruleLabel', lang)}: <span className="font-mono">{element.policyRule}</span>
              </p>
            )}
            {element.policyMessage && <p className="mt-1">{element.policyMessage}</p>}
            {element.policyCheckedAt && (
              <p className="mt-1 text-xs opacity-80">
                {t('checkedAt', lang)}: {new Date(element.policyCheckedAt).toLocaleString(lang)}
              </p>
            )}
          </Alert>
        </section>
      </div>
    </Card>
  )
}

type RefreshOutcome = NonNullable<InfrastructureDetail['lastRefreshOutcome']>

/** What the last refresh meant, including the one every other reader forgets. */
const refreshSentence = (outcome: RefreshOutcome | null, lang: string): string => {
  switch (outcome) {
    case 'clean':
      return t('refreshClean', lang)
    case 'drifted':
      return t('refreshDrifted', lang)
    case 'locked':
      return t('refreshLocked', lang)
    case 'error':
      return t('refreshError', lang)
    /*
     * `null` and anything unrecognised both land here, and they land on the
     * truthful sentence: the element carries no record of a check, so "nothing has
     * checked this element yet" is what this portal knows. It must never fall
     * through to the clean one — an element nothing has looked at is not a healthy
     * one (#108).
     */
    default:
      return t('refreshNever', lang)
  }
}

type PolicyOutcome = NonNullable<InfrastructureDetail['policyOutcome']>

/** `unavailable` is a warning, not a verdict: it says the engine was not asked. */
const policyTone = (outcome: PolicyOutcome | null): 'error' | 'warning' | 'success' | 'info' => {
  switch (outcome) {
    case 'allow':
      return 'success'
    case 'warn':
    case 'needs-approval':
    case 'unavailable':
      return 'warning'
    case 'deny':
      return 'error'
    default:
      return 'info'
  }
}

/** `null` is "nobody has asked", which is deliberately not "the policies agree". */
const policySentence = (outcome: PolicyOutcome | null, lang: string): string => {
  switch (outcome) {
    case 'allow':
      return t('policyAllow', lang)
    case 'warn':
      return t('policyWarn', lang)
    case 'deny':
      return t('policyDeny', lang)
    case 'needs-approval':
      return t('policyNeedsApproval', lang)
    /*
     * `unavailable` has a sentence of its own after all: "the engine could not be
     * asked" is a fact about the check, and the stored message below it says which
     * engine and why — one line to say what happened, one to say where to look.
     */
    case 'unavailable':
      return t('policyUnavailable', lang)
    default:
      return t('policyNever', lang)
  }
}
