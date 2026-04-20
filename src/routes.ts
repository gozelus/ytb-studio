import { loadLlmConfig } from './llm'
import { log, newReqId } from './log'
import { generateViaGeminiFileData } from './gemini-video'
import { PROMPT_VERSION } from './prompt'
import { INVALID_SHARECODE_MESSAGE, hasValidSharecode } from './sharecode'
import { normalizeVideoUrl, parseVideoId } from './youtube'
import type { Env } from './env'
import type { Mode } from './types'

export async function inspect(request: Request, env: Env): Promise<Response> {
  const reqId = newReqId()
  const started = Date.now()
  if (!hasValidSharecode(request, env)) {
    log({ reqId, route: '/api/inspect', phase: 'invalid_sharecode' })
    return json(401, { reqId, error: 'INVALID_SHARECODE', message: INVALID_SHARECODE_MESSAGE })
  }

  let body: { url?: string }
  try { body = await request.json() } catch { return json(400, { reqId, error: 'INVALID_URL' }) }
  const rawUrl = normalizeVideoUrl(body.url ?? '')
  const videoId = parseVideoId(rawUrl)
  if (!videoId) { log({ reqId, route: '/api/inspect', phase: 'invalid_url' }); return json(400, { reqId, error: 'INVALID_URL' }) }

  log({ reqId, route: '/api/inspect', phase: 'done', videoId, durMs: Date.now() - started })
  return json(200, {
    reqId,
    videoId,
    url: rawUrl,
    title: `YouTube · ${videoId}`,
    channel: null,
    durationSec: null,
  })
}

export async function generate(request: Request, env: Env): Promise<Response> {
  const reqId = newReqId()
  const started = Date.now()
  if (!hasValidSharecode(request, env)) {
    log({ reqId, route: '/api/generate', phase: 'invalid_sharecode' })
    return json(401, { reqId, error: 'INVALID_SHARECODE', message: INVALID_SHARECODE_MESSAGE })
  }

  request.signal.addEventListener('abort',
    () => log({ reqId, phase: 'cancelled', durMs: Date.now() - started }),
    { once: true })

  let body: { url?: string; mode?: Mode } & Record<string, unknown>
  try { body = await request.json() } catch { return json(400, { reqId, error: 'INVALID_URL' }) }
  const fileUri = normalizeVideoUrl(body.url ?? '')
  const videoId = parseVideoId(fileUri)
  const mode: Mode = body.mode === 'faithful' ? 'faithful' : 'rewrite'
  if (!videoId) return json(400, { reqId, error: 'INVALID_URL' })

  const cfg = loadLlmConfig(env)
  log({ reqId, route: '/api/generate', phase: 'start', videoId, mode, promptVer: PROMPT_VERSION })
  return generateViaGeminiFileData(request, env, cfg, reqId, fileUri, videoId, mode, started)
}

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}
