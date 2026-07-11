import { test, expect } from 'bun:test'
import type { RepairContext } from '@sho/loop-c'
import { claudeRepairProposer, type FetchLike } from './src/index'

const ctx: RepairContext = {
  incidentId: 'inc-1', classKey: 'src/checkout::E', moduleArea: 'src/checkout', team: 'checkout',
  primaryApprover: 'p', secondaryApprover: 's', loopADecision: 'CONFIRMED',
  autonomy: { level: 'L1', tier: 2, requiredMutationScore: 0.6, accountableOwner: 'o' },
  whyTrace: {
    incidentId: 'inc-1', hypothesis: 'null cart', alternatives: [], confidence: { reproduced: true, explainsAllOccurrences: true, affectedPathInDeployDiff: true, stepVsSlopeConsistent: true },
    correlationState: 'deploy_linked', affectedComponents: ['src/checkout/price.ts'], fixClass: 'code',
    recommendedAction: 'guard', suspiciousContentFlag: false, similarIncidents: [],
  },
}

function fetchReturning(text: string): FetchLike {
  return async () => ({ ok: true, status: 200, async json() { return { content: [{ type: 'text', text }] } }, async text() { return '' } })
}

test('parses a well-formed proposal; touchedPaths gains the test + source files', async () => {
  const model = JSON.stringify({
    summary: 'guard null cart', testPath: 'src/checkout/price.test.ts', testSource: 'test source',
    diff: 'diff --git a/src/checkout/price.ts b/src/checkout/price.ts\n@@\n-x\n+y', sourceFiles: ['src/checkout/price.ts'], touchedPaths: [],
  })
  const propose = claudeRepairProposer({ apiKey: 'k', fetchFn: fetchReturning('here is the fix ' + model) })
  const p = (await propose(ctx, []))!
  expect(p.summary).toBe('guard null cart')
  expect(p.sourceFiles).toEqual(['src/checkout/price.ts'])
  expect(p.touchedPaths.sort()).toEqual(['src/checkout/price.test.ts', 'src/checkout/price.ts'])
})

test('declines (null) on empty diff, missing test, or no source files — never a throw', async () => {
  const noDiff = claudeRepairProposer({ apiKey: 'k', fetchFn: fetchReturning(JSON.stringify({ summary: 's', testPath: 't', testSource: 'x', diff: '', sourceFiles: ['a'] })) })
  expect(await noDiff(ctx, [])).toBeNull()

  const noTest = claudeRepairProposer({ apiKey: 'k', fetchFn: fetchReturning(JSON.stringify({ summary: 's', diff: 'd', sourceFiles: ['a'] })) })
  expect(await noTest(ctx, [])).toBeNull()

  const noSrc = claudeRepairProposer({ apiKey: 'k', fetchFn: fetchReturning(JSON.stringify({ summary: 's', testPath: 't', testSource: 'x', diff: 'd', sourceFiles: [] })) })
  expect(await noSrc(ctx, [])).toBeNull()

  const garbage = claudeRepairProposer({ apiKey: 'k', fetchFn: fetchReturning('no json here at all') })
  expect(await garbage(ctx, [])).toBeNull()
})

test('a non-2xx from the API throws (never silently degrades)', async () => {
  const bad: FetchLike = async () => ({ ok: false, status: 500, async json() { return {} }, async text() { return 'boom' } })
  await expect(claudeRepairProposer({ apiKey: 'k', fetchFn: bad })(ctx, [])).rejects.toThrow(/500/)
})
