/**
 * [WHAT] Cloudflare Worker entry point: routes /api/inspect and /api/generate;
 *        serves static assets via the ASSETS binding for everything else.
 * [WHY]  Single Worker file keeps deployment simple (no separate Pages Functions project).
 * [INVARIANT] /api/generate always responds HTTP 200 immediately, then streams SSE events.
 *             Errors mid-stream are delivered as {"type":"error"} events, not HTTP status codes.
 */

import { parseVideoId, fetchVideoInfo, fetchTimedText, timedTextToTranscript, YoutubeError } from './youtube'
import { countPromptTokens, streamChat, keepaliveTransform, LlmError, loadLlmConfig } from './llm'
import { loadProxyConfig } from './proxy'
import { buildPrompt, buildPromptForVideo, PROMPT_VERSION } from './prompt'
import { createNdjsonParser } from './parser'
import { log, logError, newReqId } from './log'
import type { ErrorCode, Mode, StreamEvent } from './types'

export interface Env {
  LLM_PROVIDER?: string
  LLM_MODEL?: string
  LLM_API_KEY?: string
  LLM_BASE_URL?: string
  GEMINI_API_KEY?: string
  GEMINI_MODEL?: string
  PROXY_URLS?: string
  PROXY_URL?: string
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

  const proxy = loadProxyConfig(env)
  const cfg = loadLlmConfig(env)
  log({ reqId, route: '/api/inspect', phase: 'start', videoId, viaProxy: !!proxy })
  try {
    const info = await fetchVideoInfo(videoId, request.signal, proxy ?? undefined)
    log({ reqId, route: '/api/inspect', phase: 'youtube.fetch', durMs: Date.now() - started })
    if (info.tracks.length === 0) return json(404, { reqId, error: 'NO_CAPTIONS' })

    const tracks = await Promise.all(info.tracks.map(async t => {
      try {
        const xml = await fetchTimedText(t.baseUrl, request.signal, proxy ?? undefined)
        const transcript = timedTextToTranscript(xml)
        const tokens = await countPromptTokens(cfg, transcript, request.signal)
        return { id: t.id, lang: t.lang, label: t.label, kind: t.kind, tokens }
      } catch (err) {
        // Auth failures are fatal for all tracks — re-throw so the outer catch returns 502.
        // All other errors degrade gracefully: return tokens:0 so the track is still listed.
        if (err instanceof LlmError && err.code === 'LLM_AUTH') throw err
        const code = err instanceof LlmError ? err.code : 'INTERNAL'
        logError({ reqId, route: '/api/inspect', phase: 'inspect.track.error', trackId: t.id, code, err: String(err) })
        return { id: t.id, lang: t.lang, label: t.label, kind: t.kind, tokens: 0 }
      }
    }))

    log({ reqId, route: '/api/inspect', phase: 'done', durMs: Date.now() - started, trackCount: tracks.length })
    return json(200, { reqId, videoId: info.videoId, title: info.title, channel: info.channel, durationSec: info.durationSec, tracks })
  } catch (err) {
    // YOUTUBE_BLOCKED routing depends on the LLM provider:
    // - google: fall back to gemini.direct (Gemini fetches the video directly via Google's IPs)
    // - others: hard error PROXY_REQUIRED — the deployer must configure PROXY_URLS
    if (err instanceof YoutubeError && err.code === 'YOUTUBE_BLOCKED') {
      const provider = cfg.provider
      if (provider === 'google') {
        log({ reqId, route: '/api/inspect', phase: 'gemini.fallback', videoId, durMs: Date.now() - started })
        return json(200, {
          reqId, videoId,
          title: `YouTube · ${videoId}`,
          channel: null,
          durationSec: null,
          tracks: [{ id: 'gemini.direct', lang: 'auto', label: 'AI 直读（未获取原始字幕）', kind: 'auto', tokens: 0 }],
          gemini_fallback_reason: 'youtube_blocked_no_proxy',
        })
      }
      logError({ reqId, phase: 'inspect.proxy_required', provider, durMs: Date.now() - started, err: String(err) })
      return json(502, { reqId, error: 'PROXY_REQUIRED' as ErrorCode })
    }
    const code: ErrorCode = err instanceof YoutubeError ? err.code
      : err instanceof LlmError ? err.code
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

  const proxy = loadProxyConfig(env)
  const cfg = loadLlmConfig(env)
  log({ reqId, route: '/api/generate', phase: 'start', videoId, mode, trackId: body.trackId, promptVer: PROMPT_VERSION })

  // gemini.direct: Gemini fetches the video itself via fileData (only valid for google provider)
  if (body.trackId === 'gemini.direct') {
    return generateViaGeminiDirect(request, cfg, reqId, videoId, mode, started)
  }

  let title: string, channel: string, durationSec: number, transcript: string
  try {
    const info = await fetchVideoInfo(videoId, request.signal, proxy ?? undefined)
    if (!info.videoId) return json(404, { reqId, error: 'VIDEO_NOT_FOUND' })
    if (info.tracks.length === 0) return json(404, { reqId, error: 'NO_CAPTIONS' })
    const track = info.tracks.find(t => t.id === body.trackId)
    if (!track) return json(404, { reqId, error: 'NO_CAPTIONS' })
    title = info.title; channel = info.channel; durationSec = info.durationSec
    log({ reqId, phase: 'youtube.fetch', durMs: Date.now() - started })
    const captionXml = await fetchTimedText(track.baseUrl, request.signal, proxy ?? undefined)
    transcript = timedTextToTranscript(captionXml)
    log({ reqId, phase: 'caption.download', bytes: captionXml.length, chars: transcript.length })
  } catch (err) {
    const code: ErrorCode = err instanceof YoutubeError ? err.code : 'INTERNAL'
    logError({ reqId, phase: 'pre.error', code, err: String(err) })
    return json(code === 'VIDEO_NOT_FOUND' ? 404 : 502, { reqId, error: code })
  }
  const prompt = buildPrompt(mode, { videoId, title, channel, durationSec }, transcript)

  // 15 s keepalive interval is half of CF's 30 s idle stream timeout.
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
      // LLM ndjson output includes its own meta and end events; suppress them here and
      // emit our own so the client sees exactly one meta (first, with reqId) and one end (last).
      const parser = createNdjsonParser(e => {
        if (e.type === 'meta') return
        if (e.type === 'end') return
        writeEvent(e)
        events++
      })
      for await (const chunk of streamChat(cfg, prompt, request.signal)) {
        if (firstChunk) { log({ reqId, phase: 'llm.first', durMs: Date.now() - started }); firstChunk = false }
        parser.feed(chunk)
      }
      parser.end()
      await writeEvent({ type: 'end' })
      log({ reqId, phase: 'done', durMs: Date.now() - started, events })
    } catch (err) {
      const code: ErrorCode = err instanceof LlmError ? err.code : 'LLM_STREAM_DROP'
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

/**
 * gemini.direct path: passes the YouTube URL as a Gemini fileData part so Google's
 * servers fetch the video. Only valid when LLM_PROVIDER=google (Gemini API).
 */
async function generateViaGeminiDirect(
  request: Request,
  cfg: ReturnType<typeof loadLlmConfig>,
  reqId: string,
  videoId: string,
  mode: Mode,
  started: number,
): Promise<Response> {
  const prompt = buildPromptForVideo(mode)
  log({ reqId, route: '/api/generate', phase: 'gemini.direct.start', videoId, mode })

  const ka = keepaliveTransform(15_000)
  const writer = ka.writable.getWriter()
  const enc = new TextEncoder()
  const writeEvent = (e: StreamEvent) =>
    writer.write(enc.encode(`data: ${JSON.stringify(e)}\n\n`)).catch(() => {})

  ;(async () => {
    let firstChunk = true
    let events = 0
    try {
      const parser = createNdjsonParser(e => {
        if (e.type === 'end') return
        // Gemini output won't include reqId in its meta; inject it here.
        writeEvent(e.type === 'meta' ? { ...e, reqId } : e)
        events++
      })
      // Gemini-specific: embed the YouTube URL directly in the prompt for fileData inference
      const fileDataPrompt = `https://www.youtube.com/watch?v=${videoId}\n\n${prompt}`
      for await (const chunk of streamChat(cfg, fileDataPrompt, request.signal)) {
        if (firstChunk) {
          log({ reqId, phase: 'llm.first', durMs: Date.now() - started })
          firstChunk = false
        }
        parser.feed(chunk)
      }
      parser.end()
      await writeEvent({ type: 'end' })
      log({ reqId, phase: 'done', durMs: Date.now() - started, events })
    } catch (err) {
      const code: ErrorCode = err instanceof LlmError ? err.code : 'LLM_STREAM_DROP'
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
