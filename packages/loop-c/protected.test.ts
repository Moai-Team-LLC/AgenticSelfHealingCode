import { test, expect } from 'bun:test'
import { isProtectedPath, protectedPathsTouched, pathsFromUnifiedDiff } from './src/index'

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

test('dependency manifests + lockfiles are protected (no-new-dependency policy, §4.4)', () => {
  for (const p of ['package.json', 'apps/web/package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'go.mod', 'go.sum', 'Cargo.toml', 'Cargo.lock', 'requirements.txt']) {
    expect(isProtectedPath(p)).toBe(true)
  }
  expect(isProtectedPath('src/checkout/package-info.ts')).toBe(false) // not a manifest
})

test('pathsFromUnifiedDiff extracts the ACTUAL written paths from diff headers', () => {
  const diff = [
    'diff --git a/src/checkout/price.ts b/src/checkout/price.ts',
    '--- a/src/checkout/price.ts',
    '+++ b/src/checkout/price.ts',
    '@@ -1 +1 @@',
    '-old',
    '+new',
  ].join('\n')
  expect(pathsFromUnifiedDiff(diff)).toEqual(['src/checkout/price.ts'])

  // a diff that touches a protected path is caught even if not declared as such
  const sneaky = 'diff --git a/src/auth/session.ts b/src/auth/session.ts\n--- a/src/auth/session.ts\n+++ b/src/auth/session.ts\n@@ -1 +1 @@\n-a\n+b\n'
  expect(protectedPathsTouched(pathsFromUnifiedDiff(sneaky))).toEqual(['src/auth/session.ts'])

  // /dev/null (file add/delete) is ignored
  const added = '--- /dev/null\n+++ b/src/new.ts\n@@ -0,0 +1 @@\n+x\n'
  expect(pathsFromUnifiedDiff(added)).toEqual(['src/new.ts'])
})
