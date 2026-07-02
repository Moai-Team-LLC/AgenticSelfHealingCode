/**
 * Credentials are read ONLY from the environment (which the operator populates from the gitignored
 * connectors/.env). This module never contains a key value and never logs one. If a required key is
 * missing, it fails loudly with a pointer — it does not silently degrade to an unauthenticated call.
 */

export function requireEnv(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`${name} is not set. Put it in connectors/.env (gitignored) — never commit it, never paste it in chat.`)
  return v
}

export function optionalEnv(name: string): string | undefined {
  const v = process.env[name]
  return v && v.length > 0 ? v : undefined
}

/** Injected HTTP surface so adapter logic is testable offline (no real network, no real key). */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown>; text: () => Promise<string> }>

export const realFetch: FetchLike = (url, init) => fetch(url, init) as unknown as ReturnType<FetchLike>
