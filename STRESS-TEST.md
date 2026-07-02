# Self-Healing Ops — Stress Test

Adversarial review of the target-state architecture. Read from the position of the
person who runs this at 3am and answers for it when it breaks. Findings are ordered
by structural impact, not by section number.

---

## 1. Central attack — the safe zone and the bug zone are nearly disjoint

Walk the Tier 2 predicate honestly. To be auto-fixable a production bug must be
*simultaneously*: reproducible from telemetry, ≤15 diff lines, in strongly-covered
code (§6), outside protected paths, and confidently root-caused.

Ask: what bug is in well-tested, isolated, unprotected code and *still* reached
production? The precondition for safe auto-fix (strong suite) is anti-correlated with
the precondition for the bug existing (weak suite let it through). Principle 6 is not
a phase-gate cleared once — it is a permanent squeeze on how many real incidents ever
qualify for Tier 2.

Stack §15's own admission (most incidents are config/data/capacity/upstream, which the
code-only repair workers cannot touch) and reactive production auto-repair is a
**minority of a minority**. The architecture's center of gravity (§1–8) points at the
tiny, riskiest slice; §9.2 quietly names where the value is (test-suite self-healing).
The doc contains the counter-argument to its own centerpiece.

## 2. "Confidence" is load-bearing and undefined — the fix is marked optional

0.9³≈0.42 is not just a triage-threshold argument; it says end-to-end auto-repair is
below coin-flip unless every factor is *grounded*. LLM self-reported confidence is
~uncorrelated with correctness. The only trustworthy confidence is an observable
boolean: did the sandbox repro reproduce the signal? did the fix flip it green? did the
new regression test fail on pre-fix code (§4)?

§4 marks sandbox repro *optional*. It must be **mandatory** for any Tier 2 auto-apply.
Without a reproduced-then-fixed observation there is no grounded confidence.

## 3. The trust-expansion loop is a positive-feedback runaway

§4/§8 expand autonomy by human override rate. Failure mode: early fixes are subtly
wrong, the weak suite passes them green, damage surfaces slowly and diffusely, nobody
rejects at approval time → override rate reads LOW → system concludes it is trustworthy
→ expands into the classes it is worst at. Low override rate is ambiguous: "good fixes"
and "nobody is checking" produce the identical metric.

Fix: drive the controller off an **independent outcome signal** (did the incident
recur within N days? did a new incident spawn in the touched file? was the fix later
reverted by a human?), not the absence of a veto.

## 4. The repair agent grades its own homework

The worker writes both the fix and the regression test, then "all tests green" clears
the gate. Trap: the generated test asserts the *new code's* behavior rather than
*correct* behavior and passes vacuously. Green is necessary, not sufficient.

Add a non-LLM gate: the regression test MUST fail on the **parent commit** and pass on
the fix commit. If it passes on old code it tests nothing.

Related: the judge-agent (§7) reads the diff *and the RCA narrative*. A confidently
wrong RCA primes the judge to bless a fix matching a false story. Judge independence
must come from **signals** (must-fail repro, static analysis, diff-size policy), not a
second prompt of the same model family — they share blind spots. Feed the judge the
evidence, not the story.

## 5. The strongest RCA heuristic is weakest where it matters

Deploy-correlation-first (§2) is right for the common case and creates anchoring bias
for the dangerous case. Silent degradation and business-signal-without-exception — the
incidents that hurt most — are exactly the ones NOT correlated to a recent deploy. The
agent will over-attribute to the last deploy and confidently root-cause the wrong thing
where being wrong is most expensive. Needs a "no recent deploy → widen search" path.

## 6. The async-HITL schedule is perverse

Nights/weekends, Tier 3 secondary-approver and Tier 4 auto-reject-on-timeout mean the
human-gated tiers go dark exactly when incidents spike and humans sleep. What runs 24/7
is Tier 2 — the ungated class trusted least. The autonomy profile is inverted from the
trust profile. Needs an explicit answer: Tier 2 also pauses to PR outside staffed
hours, or auto-apply gated on business-hours + fast-rollback + traffic-percentage.

## 7. Security — a write-access agent driven by attacker-reachable inputs

No threat model in the doc. Real surface:

- **Signal spoofing.** Webhook/metric ingestion is the trigger. Forge a Sentry payload
  or nudge a business metric → drive the pipeline toward introducing chosen code. Only
  as trustworthy as webhook auth, which §2 omits.
- **Log-borne prompt injection → tool use.** The RCA agent reads logs / stack traces /
  error messages — routinely user-controlled fields — into an agent holding code-search,
  git, and sandboxed code-exec tools. Textbook injection→tool chain.
- **Service-account blast radius.** Repo write + CI trigger + Tier 2 merge on one
  identity is a supply-chain write path into main. Protected-paths limit *where*, not
  *whether* the mechanism can be steered.

Minimum §12 additions: signed/authenticated signal ingestion; treat all telemetry text
as untrusted (no tool-affecting instructions from log content); sandbox egress control;
a documented accountability owner for an auto-merged outage.

## 8. Incident Memory poisons as easily as it teaches

A wrong-but-green past resolution becomes few-shot context that propagates the same
wrong fix to every similar future incident. Retrieval must be **outcome-weighted**:
only confirmed-good resolutions (no recurrence, not reverted) are positive exemplars;
failures are retrieved as labeled anti-patterns. Otherwise memory amplifies the worst
early mistakes exactly as autonomy expands (compounds with #3).

## 9. Smaller but real

- **Reversibility is assumed, not verified.** "Revert commit ready" is not a rollback
  if the fix ran a migration or had side effects. Tier 2 must *prove* side-effect-free.
- **The pipeline races the human and loses on urgent bugs.** 20-min RCA vs. a 3-min
  human rollback → the system inherits the non-urgent long tail, which overlaps with
  "not worth auto-fixing" (#1 again). State a latency budget or accept it is an
  off-peak/batch tool, not incident response.
- **No metric for harm caused.** §13 is all "did it help." The key safety number is
  absent: incidents caused or worsened by an auto-applied fix. Without it, and with a
  confounded before/after MTTR, net-positive is unprovable.
- **Fingerprint drift** silently disables Memory retrieval across refactors, right when
  it is most wanted.

---

## What survives — the defensible core

Keepers unchanged: Tier model, async HITL, replayable why-traces, kill switch, the §6
bootstrapping honesty, the §9.2 insight. The change is **center of gravity**:

1. **RCA node at Tier 1 is the real product** — grounded hypothesis + repro +
   outcome-weighted similar incidents, handed to the on-call human. ~80% of the value,
   ~10% of the risk. Never auto-fixes.
2. **Test-suite self-healing (§9.2)** — humans trust it because they can read the test;
   contained blast radius; dodges #1, #3, #6 entirely. Build this first, not as a side
   lane.
3. **Auto-merge only for the test/lint tier** initially. Production-code Tier 2 is the
   rare, mutation-gated, business-hours, proven-reversible tail, earned on outcome data.

## Hidden decisions to settle before building

| # | Decision | Position |
|---|---|---|
| D1 | Reuse AgenticOps durable + AgenticMind pgvector, or new runtime? (§10 "reuse" vs §11 "pick one") | Reuse — a new runtime is unearned ops load. |
| D2 | Sandbox repro: optional or mandatory for auto-apply? | Mandatory — only grounded-confidence signal. |
| D3 | "Suite strong enough" gate: coverage or mutation score? | Mutation score on touched module. |
| D4 | Regression-test validity: enforce must-fail-on-parent-commit? | Yes, hard non-LLM gate. |
| D5 | Center of gravity: production auto-repair vs RCA-copilot + test-healing? | The latter. |
| D6 | Trust-expansion signal: override-rate alone or + outcome? | Must include outcome. |
| D7 | Threat model (spoofing, log injection): in scope v1 or deferred? | In scope — it is a write path to main. |
| D8 | Judge independence: second prompt or independent signals? | Signals. |
| D9 | Accountability owner for an auto-merged outage? | Name it now; it constrains which tiers can exist. |

**Sharpest takeaway:** §9.2 and §6 are both quietly telling you the centerpiece points
at the wrong target. Move the center of gravity to diagnosis + test-suite healing, make
grounded-repro the confidence source, and gate trust-expansion on outcomes rather than
the absence of vetoes — and most failure modes above stop being reachable.
