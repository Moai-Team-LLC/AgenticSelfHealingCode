/**
 * §6 — KILL-SWITCH RELEASE: a signed on-call action over the authenticated HITL channel is the ONLY path
 * that can clear the freeze. This layer proves INTENT; the orchestrator's KillSwitch is the single writer
 * of the bit (keystone §5). No agent tool can toggle it — this is deliberately not a registered agent tool.
 *
 * The auth chain (§6.1), all verified before we ever touch the switch:
 *   1. AUTHN   — the Telegram identity is bound to a real on-call member (small on-call writer set).
 *   2. MFA     — an MFA-backed assertion is verified out-of-band.
 *   3. SIGNATURE — a detached signature over (action ∥ by ∥ nonce ∥ killed_at) with the member's key;
 *                  binding killed_at means a signature cannot be replayed across freezes.
 *   4. NONCE   — single-use; replays are rejected.
 *   5. DUAL ATTRIBUTION — audited with releaser + the engage record it clears.
 *   6. APPLY   — hand the verified release to KillSwitch.release (ORCHESTRATION §5 owns the write).
 *
 * Only after ALL of 1–5 pass do we call KillSwitch.release with the signed token. A failure at any step
 * refuses + audits and NEVER calls release — fail-safe: a DoS of this channel can only KEEP the freeze.
 */

import { KillSwitch } from '@sho/orchestrator'

export interface KillReleaseRequest {
  action: 'release'
  by: string // Telegram identity → on-call role
  mfaAssertion: string
  reason: string // free text, audited
  signature: string // detached signature over canonical(action, by, nonce, killedAt)
  nonce: string // single-use
}

export interface ReleaseResult {
  released: boolean
  reason:
    | 'ok'
    | 'not_on_call'
    | 'mfa_failed'
    | 'bad_signature'
    | 'nonce_replayed'
    | 'still_killed' // auth passed but the switch stayed killed (e.g. stale heartbeat — fail-safe)
}

export interface AuditEvent {
  kind: 'kill_switch_release' | 'kill_switch_release_refused'
  by: string
  reason: string
  nonce: string
  atMs: number
  detail?: string
}

/** Injected verifiers — real adapters wrap MFA/crypto/registry; the fakes make the path testable NOW. */
export interface KillReleaseDeps {
  isOnCall(by: string): boolean
  verifyMfa(by: string, assertion: string): boolean
  /** Verify the detached signature over the canonical message for `by`. */
  verifySignature(signature: string, canonicalMsg: string, by: string): boolean
  /** The signed release TOKEN the orchestrator's KillSwitch expects (the shared release secret proof). */
  releaseToken(by: string): string
  audit(e: AuditEvent): void
}

/** Canonical message bound by the signature — includes killed_at so a signature can't cross freezes. */
export function canonical(action: string, by: string, nonce: string, killedAtMs: number): string {
  return `${action}‖${by}‖${nonce}‖${killedAtMs}`
}

/**
 * The release actuator. Verifies the whole chain, then — and ONLY then — calls KillSwitch.release. Every
 * outcome (grant or refusal) is audited with dual attribution. `nowMs` and `killedAtMs` are parameters
 * (determinism). Replay protection is a single-use nonce set held here (a used-nonce table in prod).
 */
export class KillReleaseGate {
  private usedNonces = new Set<string>()
  constructor(private readonly deps: KillReleaseDeps) {}

  requestRelease(req: KillReleaseRequest, ks: KillSwitch, nowMs: number, killedAtMs: number): ReleaseResult {
    const refuse = (reason: ReleaseResult['reason'], detail: string): ReleaseResult => {
      this.deps.audit({ kind: 'kill_switch_release_refused', by: req.by, reason: req.reason, nonce: req.nonce, atMs: nowMs, detail })
      return { released: false, reason }
    }

    // 1. AUTHN — must be in the small on-call writer set.
    if (!this.deps.isOnCall(req.by)) return refuse('not_on_call', 'identity not in on-call writer set')
    // 2. MFA — out-of-band assertion.
    if (!this.deps.verifyMfa(req.by, req.mfaAssertion)) return refuse('mfa_failed', 'mfa assertion rejected')
    // 3. SIGNATURE — bound to the current killed_at so it cannot be replayed across freezes.
    const msg = canonical(req.action, req.by, req.nonce, killedAtMs)
    if (!this.deps.verifySignature(req.signature, msg, req.by)) return refuse('bad_signature', 'signature verify failed')
    // 4. NONCE — single-use.
    if (this.usedNonces.has(req.nonce)) return refuse('nonce_replayed', 'nonce already used')
    this.usedNonces.add(req.nonce)

    // 5. DUAL ATTRIBUTION — record the grant BEFORE applying (auditable intent).
    this.deps.audit({ kind: 'kill_switch_release', by: req.by, reason: req.reason, nonce: req.nonce, atMs: nowMs })

    // 6. APPLY — hand the signed token to the orchestrator, the single writer of the bit. `release` only
    //    clears an explicit engage; the EFFECTIVE killed-state (which also folds in a stale-heartbeat kill,
    //    the fail-safe) is read back via isKilled(nowMs). If it is still killed — e.g. a DoS'd heartbeat —
    //    fail-safe holds: we report still_killed, not released. A channel outage can only KEEP the freeze.
    ks.release(this.deps.releaseToken(req.by))
    const stillKilled = ks.isKilled(nowMs)
    return stillKilled ? { released: false, reason: 'still_killed' } : { released: true, reason: 'ok' }
  }
}
