/**
 * Standalone in-memory fakes (the codebase pattern: loop-a ships fakeTools/FakeLlmClient from its index).
 * These make the whole propose→gate→confirm→land loop runnable and testable OFFLINE — no LLM, no git, no
 * GitHub, no keys. The real adapters (Claude repair-author, GitHub PR publisher, gate/verify.ts wrapper)
 * plug in behind the same ports for a live deployment.
 */

import type { GateResult } from '@sho/contracts'
import type {
  RepairAuthor,
  StagedPatch,
  RepairContext,
  ChangeRequestPublisher,
  ChangeRequestInput,
  PublishedChangeRequest,
  RunGate,
} from './types'

/** A repair worker that returns a fixed staged patch (or null = declined). */
export class FakeRepairAuthor implements RepairAuthor {
  constructor(private readonly staged: StagedPatch | null) {}
  async author(_ctx: RepairContext): Promise<StagedPatch | null> {
    return this.staged
  }
}

/** A change-request publisher that records inputs and hands back deterministic PR refs. */
export class RecordingPublisher implements ChangeRequestPublisher {
  readonly published: ChangeRequestInput[] = []
  private seq: number
  constructor(startAt = 1) {
    this.seq = startAt
  }
  async publish(input: ChangeRequestInput): Promise<PublishedChangeRequest> {
    this.published.push(input)
    const number = this.seq++
    return { url: `https://github.test/${input.classKey}/pull/${number}`, number, headSha: input.headSha }
  }
}

/** A passing contracts-shaped GateResult; override any field for a specific scenario. */
export function fakeGateResult(over: Partial<GateResult> = {}): GateResult {
  return {
    pass: true,
    moduleArea: 'src/checkout',
    loop: 'C',
    tier: 2,
    signals: {
      mustFailOnParent: { pass: true, code: 'DISCRIMINATING' },
      mutationScore: { pass: true, score: 0.82, threshold: 0.6 },
      noWeakening: { pass: true },
      diffLines: 6,
      exceedsClassBudget: false,
    },
    reason: 'PASS — all hard gates green',
    ...over,
  }
}

/** A RunGate that always passes (optionally with overrides). */
export const passGate =
  (over?: Partial<GateResult>): RunGate =>
  async () =>
    fakeGateResult(over)

/** A RunGate that always rejects on a vacuous (non-discriminating) test. */
export const failGate = (): RunGate => async () =>
  fakeGateResult({
    pass: false,
    signals: {
      mustFailOnParent: { pass: false, code: 'VACUOUS' },
      mutationScore: { pass: true, score: 0.7, threshold: 0.6 },
      noWeakening: { pass: true },
      diffLines: 6,
      exceedsClassBudget: false,
    },
    reason: 'REJECT — must-fail-on-parent (VACUOUS)',
  })

/** A staged patch on a clean (non-protected) module with grounded repro booleans true. */
export function fakeStaged(over: Partial<StagedPatch> = {}): StagedPatch {
  return {
    summary: 'Guard against a null cart in price(); regression test added.',
    commitSubject: 'fix(checkout): guard against a null cart in price()',
    repo: '/sandbox/checkout',
    parentSha: 'parent00',
    fixSha: 'fix11111',
    testPaths: ['src/checkout/price.test.ts'],
    sourceFiles: ['src/checkout/price.ts'],
    touchedPaths: ['src/checkout/price.ts', 'src/checkout/price.test.ts'],
    reproReproducedSignal: true,
    fixFlippedReproGreen: true,
    checks: [],
    ...over,
  }
}
