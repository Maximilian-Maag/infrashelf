import { auth } from '@/lib/auth'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import type { Role } from '@infrashelf/types'
import { PageHeader } from '@/components/layout/PageHeader'
import { t, type Translations } from '@/lib/i18n'
import { getLang } from '@/lib/getLang'

/**
 * The 12 destinations, as keys rather than as words.
 *
 * Every one of these was written out in English, in a module-level array, so
 * nothing that looks at JSX could see them: a root admin on a German portal got
 * a translated page heading over 22 untranslated strings, which reads as a
 * deliberate choice rather than as a gap (WCAG 3.1.2 — #186). Each destination
 * already had a title and a subtitle in the tables — the page it links to uses
 * them — so this is the same words the next screen says.
 */
const adminSections: { href: string; title: keyof Translations; description: keyof Translations }[] = [
  { href: '/admin/categories', title: 'categories', description: 'categoriesSubtitle' },
  { href: '/admin/products', title: 'productsTitle', description: 'manageCatalogProducts' },
  { href: '/admin/environments', title: 'environments', description: 'environmentsSubtitle' },
  { href: '/admin/ci-sources', title: 'ciSources', description: 'ciSourcesSubtitle' },
  { href: '/admin/integrations', title: 'integrations', description: 'integrationsSubtitle' },
  { href: '/admin/cost-centers', title: 'costCenters', description: 'costCentersSubtitle' },
  { href: '/admin/users', title: 'users', description: 'usersSubtitle' },
  { href: '/admin/parameters', title: 'globalParameters', description: 'globalParametersSubtitle' },
  { href: '/admin/branding', title: 'branding', description: 'brandingSubtitle' },
  { href: '/admin/config/smtp', title: 'smtpConfiguration', description: 'smtpSubtitle' },
  { href: '/admin/config/ai', title: 'aiConfiguration', description: 'aiSubtitle' },
  { href: '/admin/exchange-rates', title: 'exchangeRates', description: 'exchangeRatesSubtitle' },
  { href: '/admin/deployment-windows', title: 'deploymentWindows', description: 'deploymentWindowsSubtitle' },
]

export default async function AdminPage() {
  const session = await auth()
  if (!session) redirect('/login')

  const role = (session.user as unknown as { role: Role }).role
  if (role !== 'root') redirect('/')

  const lang = await getLang()

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <PageHeader title={t('adminDashboard', lang)} subtitle={t('adminDashboardSubtitle', lang)} />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {adminSections.map((section) => (
          <Link
            key={section.href}
            href={section.href}
            className="group block rounded-xl border border-slate-200 bg-white p-5 shadow-sm hover:border-blue-300 hover:shadow-md transition-all"
          >
            {/* h2, not h3: these tiles hang straight off the PageHeader's <h1>
                with nothing between, so h3 skipped a level (#185). */}
            <h2 className="font-semibold text-slate-900 group-hover:text-blue-700 transition-colors mb-1">
              {t(section.title, lang)}
            </h2>
            <p className="text-sm text-slate-600">{t(section.description, lang)}</p>
          </Link>
        ))}
      </div>
    </div>
  )
}
