import { auth } from '@/lib/auth'
import { get } from '@/lib/serverApi'
import { section } from '@/lib/section'
import { redirect } from 'next/navigation'
import type { Role, Parameter, DeploymentEnvironment, Project } from '@infrashelf/types'
import { PageHeader } from '@/components/layout/PageHeader'
import { ParametersManager } from './ParametersManager'
import { t } from '@/lib/i18n'
import { getLang } from '@/lib/getLang'

export default async function ParametersPage() {
  const session = await auth()
  if (!session) redirect('/login')
  const role = (session.user as unknown as { role: Role }).role
  if (role !== 'root') redirect('/admin')

  const lang = await getLang()

  /*
   * Three fetches here rather than on mount (#460), and their failures are not
   * the same failure. The parameters ARE this screen; the environments and the
   * projects only fill the dropdowns a new parameter is scoped with, so without
   * them there is nothing to choose from but every existing parameter still
   * edits and saves.
   *
   * `section()` for all three rather than `.catch(() => [])`: a catch around a
   * `serverApi` call swallows the login redirect it throws for an ended session
   * (#434).
   */
  const [paramsRes, envsRes, projectsRes] = await Promise.allSettled([
    get<Parameter[]>('/api/admin/parameters'),
    get<DeploymentEnvironment[]>('/api/admin/environments'),
    get<Project[]>('/api/projects'),
  ])
  const parameters = section(paramsRes, [] as Parameter[], 'global parameters')
  const environments = section(envsRes, [] as DeploymentEnvironment[], 'environments for the parameter form')
  const projects = section(projectsRes, [] as Project[], 'projects for the parameter form')

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <PageHeader title={t('globalParameters', lang)} subtitle={t('globalParametersSubtitle', lang)} />
      {/* The scope filter used to run in the browser, after asking for every
          parameter in the installation. */}
      <ParametersManager
        initial={parameters.data.filter((p) => p.scope === 'global')}
        initialEnvironments={environments.data}
        initialProjects={projects.data}
        initialError={parameters.error}
      />
    </div>
  )
}
