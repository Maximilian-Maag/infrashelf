import { Suspense } from 'react'
import type { Branding } from '@open-hybrid-cloud/types'
import { LoginForm } from './LoginForm'

const API_SSR = process.env.API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? ''

export default async function LoginPage() {
  let branding: Branding = {
    primaryColor: '#131921',
    secondaryColor: '#febd69',
    shopName: 'Open Hybrid Cloud',
    shopSubtitle: '',
    imprintText: '',
  }
  try {
    const res = await fetch(`${API_SSR}/api/public/branding`, { cache: 'no-store' })
    if (res.ok) branding = await res.json()
  } catch { /* use defaults */ }

  let logoDataUrl: string | null = null
  if (branding.logoMime) {
    try {
      const res = await fetch(`${API_SSR}/api/admin/branding/logo`, { cache: 'no-store' })
      if (res.ok) {
        const buf = await res.arrayBuffer()
        logoDataUrl = `data:${branding.logoMime};base64,${Buffer.from(buf).toString('base64')}`
      }
    } catch { /* non-fatal */ }
  }

  // Suspense boundary: LoginForm reads the query string (`expired`,
  // `callbackUrl`), and `useSearchParams` requires one.
  return (
    <Suspense>
      <LoginForm
        shopName={branding.shopName ?? 'Open Hybrid Cloud'}
        shopSubtitle={branding.shopSubtitle ?? ''}
        logoDataUrl={logoDataUrl}
        primaryColor={branding.primaryColor ?? '#131921'}
        secondaryColor={branding.secondaryColor ?? '#febd69'}
      />
    </Suspense>
  )
}
