import type { ReactNode } from 'react'

interface PageHeaderProps {
  title: string
  subtitle?: string
  actions?: ReactNode
}

export function PageHeader({ title, subtitle, actions }: PageHeaderProps) {
  return (
    /*
      Wraps. This row is shared by 24 pages, nine of which pass `actions`, and
      it had no `flex-wrap` and no column variant — so on `/infrastructure` the
      actions cluster (a checkbox, a label and two export buttons) started at
      x=187 and ran to 427 on a 375px viewport, clipping both buttons with no
      way to scroll to them (#168).

      `min-w-0` on the title column so a long title yields to the actions
      instead of pushing them out; `gap-y` because a wrapped row needs vertical
      spacing that `justify-between` does not give it.
    */
    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3 mb-6">
      <div className="min-w-0">
        <h1 className="text-2xl font-bold text-slate-900">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-slate-600">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2 sm:gap-3">{actions}</div>}
    </div>
  )
}
