# Security Policy

## Supported versions

AgenticSelfHealingCode is pre-1.0; security fixes land on the latest `0.x` minor.

| Version | Supported |
| ------- | --------- |
| 0.1.x   | ✅        |
| < 0.1   | ❌        |

## Reporting a vulnerability

Please report security issues **privately** — do not open a public issue or PR.

Use GitHub's private vulnerability reporting: the repository's **Security** tab →
**Report a vulnerability**. We aim to acknowledge within 5 business days and to
share a remediation timeline after triage.

Helpful details: affected version or commit, reproduction steps, and impact.
Coordinated disclosure is appreciated.

## Scope notes

This system is a write-capable agent network driven by attacker-reachable inputs,
and it ships with an explicit threat model — read
[`SECURITY-THREATMODEL.md`](SECURITY-THREATMODEL.md) before deploying. The
non-negotiables it encodes:

- **Signal ingestion is authenticated** (HMAC over the raw body, verify-before-normalize).
  Never expose an unsigned webhook endpoint.
- **All telemetry text is untrusted data, never instructions** — log-borne prompt
  injection is surfaced (`suspiciousContentFlag`), never acted on. The RCA loop
  (Loop A) holds zero write/exec tools by construction.
- **Autonomy is bounded**: protected paths are never machine-writable, every
  auto-apply requires a named accountable owner, and one signed command freezes
  the whole system to diagnosis-only (the kill switch is heartbeat-fail-safe).
- **Credentials live only in the environment** (`connectors/.env`, gitignored).
  Never commit a key; rotate any key that ever left the `.env` file.

See also the Agentic Product Standard's security layer for the broader model.
