import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  output: 'standalone',
  // Not the repo's tsconfig: see tsconfig.build.json for why the production
  // build must not type-check the test files.
  typescript: { tsconfigPath: 'tsconfig.build.json' },
  serverExternalPackages: ['postgres', 'nodemailer', 'bcryptjs', 'pdfkit'],
}

export default nextConfig
