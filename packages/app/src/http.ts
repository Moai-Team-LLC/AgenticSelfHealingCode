/**
 * The HTTP surface: a fetch handler (testable by calling with a Request — no port needed). server.ts
 * wraps it in Bun.serve. Webhook bodies are attacker-reachable, so the signature header is verified by
 * the signal layer inside handleSignal (verify-before-normalize).
 */

import type { SignalSource } from '@sho/contracts'
import { handleSignal, type AppDeps } from './runtime'

const SOURCE_RE = /^\/webhook\/(sentry|otel|rum|business-metric)$/

export function createFetchHandler(deps: AppDeps): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url)
    if (req.method === 'GET' && url.pathname === '/health') return Response.json({ ok: true })

    const m = url.pathname.match(SOURCE_RE)
    if (req.method === 'POST' && m) {
      const source = m[1] as SignalSource
      const rawBody = await req.text()
      const signature = req.headers.get('x-signature') ?? undefined
      const result = await handleSignal(rawBody, source, { secret: deps.secret, signature }, deps)
      return Response.json(result, { status: result.ok ? 200 : 400 })
    }
    return new Response('not found', { status: 404 })
  }
}
