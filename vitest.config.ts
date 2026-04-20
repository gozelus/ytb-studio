// Using cloudflarePool (lower-level runner form) rather than the
// plugin-form cloudflareTest that the official get-started guide shows —
// both are public API in @cloudflare/vitest-pool-workers@0.14.x
// and functionally equivalent; cloudflarePool is the only export
// available at the '.' path in this package version.
import { configDefaults, defineConfig } from 'vitest/config'
import { cloudflarePool } from '@cloudflare/vitest-pool-workers'

export default defineConfig({
  test: {
    exclude: [
      ...configDefaults.exclude,
      '**/.claude/**',
      '**/.codex/**',
    ],
    pool: cloudflarePool({
      wrangler: { configPath: './wrangler.toml' },
    }),
  },
})
