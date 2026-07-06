import { test, expect } from 'bun:test'
import { isProtectedPath, protectedPathsTouched } from './src/index'

test('Tier-4 areas are protected (never autonomous at any level)', () => {
  for (const p of [
    'src/auth/session.ts',
    'src/billing/charge.ts',
    'infra/terraform/main.tf',
    'db/migrations/0007_add.sql',
    'server/migrations/0001.sql',
    '.github/workflows/ci.yml',
    '.env',
    '.env.production',
    'secrets/token.txt',
    'deploy/key.pem',
    'certs/tls.key',
  ]) {
    expect(isProtectedPath(p)).toBe(true)
  }
})

test('ordinary source paths are proposable', () => {
  for (const p of ['src/checkout/price.ts', 'src/checkout/price.test.ts', 'lib/format.ts', 'app/cart/index.ts']) {
    expect(isProtectedPath(p)).toBe(false)
  }
})

test('leading ./ and / are normalized before matching', () => {
  expect(isProtectedPath('./src/auth/x.ts')).toBe(true)
  expect(isProtectedPath('/infra/x.tf')).toBe(true)
})

test('protectedPathsTouched returns only the offending subset', () => {
  expect(protectedPathsTouched(['src/checkout/price.ts', 'src/billing/charge.ts', 'lib/x.ts'])).toEqual(['src/billing/charge.ts'])
  expect(protectedPathsTouched(['src/checkout/price.ts'])).toEqual([])
})
