import { parseVideoId, fetchWatchPage, extractVideoInfo, timedTextToTranscript, YoutubeError } from './youtube'
import { countTokens, GeminiError } from './gemini'
import { log, logError, newReqId } from './log'
import type { ErrorCode } from './types'

export interface Env {
  GEMINI_API_KEY: string
  GEMINI_MODEL?: string
  ASSETS: Fetcher
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    try {
      if (request.method === 'POST' && url.pathname === '/api/inspect') return await inspect(request, env)
      if (request.method === 'POST' && url.pathname === '/api/generate') return new Response('not yet', { status: 501 })
      return env.ASSETS.fetch(request)
    } catch (err) {
      logError({ phase: 'unhandled', err: String(err) })
      return json(500, { error: 'INTERNAL' as ErrorCode })
    }
  },
} satisfies ExportedHandler<Env>

async function inspect(request: Request, env: Env): Promise<Response> {
  const reqId = newReqId()
  const started = Date.now()
  let body: { url?: string }
  try { body = await request.json() } catch { return json(400, { reqId, error: 'INVALID_URL' }) }
  const videoId = parseVideoId(body.url ?? '')
  if (!videoId) { log({ reqId, route: '/api/inspect', phase: 'invalid_url' }); return json(400, { reqId, error: 'INVALID_URL' }) }

  log({ reqId, route: '/api/inspect', phase: 'start', videoId })
  try {
    const html = await fetchWatchPage(videoId, request.signal)
    log({ reqId, phase: 'youtube.fetch', durMs: Date.now() - started, bytes: html.length })
    const info = extractVideoInfo(html)
    if (!info || !info.videoId) return json(404, { reqId, error: 'VIDEO_NOT_FOUND' })
    if (info.tracks.length === 0) return json(404, { reqId, error: 'NO_CAPTIONS' })

    const tracks = await Promise.all(info.tracks.map(async t => {
      try {
        const res = await fetch(t.baseUrl, { signal: request.signal })
        if (!res.ok) throw new Error(`timedtext status ${res.status}`)
        const xml = await res.text()
        const transcript = timedTextToTranscript(xml)
        const tokens = await countTokens(env, transcript, request.signal)
        return { id: t.id, lang: t.lang, label: t.label, kind: t.kind, tokens }
      } catch (err) {
        logError({ reqId, phase: 'inspect.track.error', trackId: t.id, err: String(err) })
        return { id: t.id, lang: t.lang, label: t.label, kind: t.kind, tokens: 0 }
      }
    }))

    log({ reqId, phase: 'done', durMs: Date.now() - started, trackCount: tracks.length })
    return json(200, { reqId, videoId: info.videoId, title: info.title, channel: info.channel, durationSec: info.durationSec, tracks })
  } catch (err) {
    const code: ErrorCode = err instanceof YoutubeError ? err.code
      : err instanceof GeminiError ? err.code
      : 'INTERNAL'
    logError({ reqId, phase: 'inspect.error', code, durMs: Date.now() - started, err: String(err) })
    return json(code === 'VIDEO_NOT_FOUND' ? 404 : code === 'NO_CAPTIONS' ? 404 : code === 'INVALID_URL' ? 400 : 502, { reqId, error: code })
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}
