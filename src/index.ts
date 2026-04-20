import { parseVideoId, fetchWatchPage, fetchTimedText, extractVideoInfo, timedTextToTranscript, YoutubeError } from './youtube'
import { countTokens, streamGenerate, keepaliveTransform, GeminiError } from './gemini'
import { buildPrompt, PROMPT_VERSION } from './prompt'
import { createNdjsonParser } from './parser'
import { log, logError, newReqId } from './log'
import type { ErrorCode, Mode, StreamEvent } from './types'

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
      if (request.method === 'POST' && url.pathname === '/api/generate') return await generate(request, env)
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

async function generate(request: Request, env: Env): Promise<Response> {
  const reqId = newReqId()
  const started = Date.now()

  request.signal.addEventListener('abort',
    () => log({ reqId, phase: 'cancelled', durMs: Date.now() - started }),
    { once: true })

  let body: { url?: string; trackId?: string; mode?: Mode }
  try { body = await request.json() } catch { return json(400, { reqId, error: 'INVALID_URL' }) }
  const videoId = parseVideoId(body.url ?? '')
  const mode: Mode = body.mode === 'faithful' ? 'faithful' : 'rewrite'
  if (!videoId || !body.trackId) return json(400, { reqId, error: 'INVALID_URL' })

  log({ reqId, route: '/api/generate', phase: 'start', videoId, mode, trackId: body.trackId, promptVer: PROMPT_VERSION })

  let title: string, channel: string, durationSec: number, transcript: string
  try {
    const html = await fetchWatchPage(videoId, request.signal)
    const info = extractVideoInfo(html)
    if (!info) return json(404, { reqId, error: 'VIDEO_NOT_FOUND' })
    if (info.tracks.length === 0) return json(404, { reqId, error: 'NO_CAPTIONS' })
    const track = info.tracks.find(t => t.id === body.trackId)
    if (!track) return json(404, { reqId, error: 'NO_CAPTIONS' })
    title = info.title; channel = info.channel; durationSec = info.durationSec
    log({ reqId, phase: 'youtube.fetch', durMs: Date.now() - started })
    const captionXml = await fetchTimedText(track.baseUrl, request.signal)
    transcript = timedTextToTranscript(captionXml)
    log({ reqId, phase: 'caption.download', bytes: captionXml.length, chars: transcript.length })
  } catch (err) {
    const code: ErrorCode = err instanceof YoutubeError ? err.code : 'INTERNAL'
    logError({ reqId, phase: 'pre.error', code, err: String(err) })
    return json(code === 'VIDEO_NOT_FOUND' ? 404 : 502, { reqId, error: code })
  }

  const prompt = buildPrompt(mode, { videoId, title, channel, durationSec }, transcript)

  const ka = keepaliveTransform(15_000)
  const writer = ka.writable.getWriter()
  const enc = new TextEncoder()
  const writeEvent = (e: StreamEvent) =>
    writer.write(enc.encode(`data: ${JSON.stringify(e)}\n\n`)).catch(() => {})

  ;(async () => {
    let firstChunk = true
    let events = 0
    try {
      await writeEvent({ type: 'meta', reqId, title, subtitle: channel, durationSec })
      const parser = createNdjsonParser(e => {
        if (e.type === 'meta') return
        writeEvent(e)
        events++
      })
      for await (const chunk of streamGenerate(env, prompt, request.signal)) {
        if (firstChunk) { log({ reqId, phase: 'gemini.first', durMs: Date.now() - started }); firstChunk = false }
        parser.feed(chunk)
      }
      parser.end()
      await writeEvent({ type: 'end' })
      log({ reqId, phase: 'done', durMs: Date.now() - started, events })
    } catch (err) {
      const code: ErrorCode = err instanceof GeminiError ? err.code : 'GEMINI_STREAM_DROP'
      logError({ reqId, phase: 'generate.error', code, durMs: Date.now() - started, err: String(err) })
      await writeEvent({ type: 'error', code, message: String(err).slice(0, 200) })
    } finally {
      try { await writer.close() } catch { /* ignore */ }
    }
  })()

  return new Response(ka.readable, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
    },
  })
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}
