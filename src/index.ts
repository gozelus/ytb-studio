/**
 * [WHAT] Cloudflare Worker entry point: routes API requests and serves static assets.
 * [WHY]  Keep the deployment shape as a single Worker while moving route internals into modules.
 * [INVARIANT] /api/generate always responds HTTP 200 immediately, then streams SSE events.
 *             Errors mid-stream are delivered as {"type":"error"} events, not HTTP status codes.
 */

import { inspect, generate, json } from './routes'
import { logError } from './log'
import type { Env } from './env'
import type { ErrorCode } from './types'

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    try {
      if (request.method === 'POST' && url.pathname === '/api/inspect') return await inspect(request, env)
      if (request.method === 'POST' && url.pathname === '/api/generate') return await generate(request, env)
      return env.ASSETS.fetch(request)
    } catch (err) {
      logError({ phase: 'unhandled', err: String(err) })
      return json(500, { error: 'INTERNAL' as ErrorCode })
    }
  },
} satisfies ExportedHandler<Env>
