import { unstable_rethrow } from 'next/navigation'
import { get } from '@/lib/serverApi'
import type { Branding } from '@infrashelf/types'
import Link from 'next/link'
import { getLang } from '@/lib/getLang'
import { t } from '@/lib/i18n'

export default async function ImpressumPage() {
  const lang = await getLang()

  let branding: Partial<Branding> = {}
  try {
    branding = (await get<Partial<Branding>>('/api/public/branding')) ?? {}
  } catch (e) {
    // A 401 redirect is not a failed fetch (#434).
    unstable_rethrow(e)
    /* non-fatal */
  }

  const shopName = branding.shopName ?? 'InfraShelf'
  const imprintText = branding.imprintText ?? ''

  if (!imprintText) {
    // The same landmark and the same <h1> as the branch below. This is the
    // branch every CI database and every fresh install renders, and it used to
    // be a bare div: no `main`, no heading, so the page had neither a landmark
    // nor a level-one heading — invisible to the gate until #185 asked axe for
    // `landmark-one-main` and `page-has-heading-one`.
    return (
      <main className="min-h-screen flex flex-col items-center justify-center gap-2 bg-slate-50 px-6 text-center">
        <h1 className="text-2xl font-bold text-slate-900">{t('imprint', lang)}</h1>
        <p className="text-slate-600">{t('noImprintConfigured', lang)}</p>
      </main>
    )
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="bg-white border-b border-slate-200 px-6 py-4 flex items-center justify-between">
        <span className="font-semibold text-slate-800">{shopName}</span>
        <Link href="/" className="text-sm text-blue-600 hover:underline">← {t('back', lang)}</Link>
      </header>
      <main className="max-w-3xl mx-auto px-6 py-12">
        <h1 className="text-2xl font-bold text-slate-900 mb-6">{t('imprint', lang)}</h1>
        <div className="bg-white rounded-xl border border-slate-200 p-8 text-sm text-slate-700 whitespace-pre-wrap leading-relaxed">
          {imprintText}
        </div>
      </main>
    </div>
  )
}
