/**
 * [WHAT] Cloudflare Worker entry point: routes /api/inspect and /api/generate;
 *        serves static assets via the ASSETS binding for everything else.
 * [WHY]  Single Worker file keeps deployment simple (no separate Pages Functions project).
 * [INVARIANT] /api/generate always responds HTTP 200 immediately, then streams SSE events.
 *             Errors mid-stream are delivered as {"type":"error"} events, not HTTP status codes.
 */

import { normalizeVideoUrl, parseVideoId } from './youtube'
import { streamChat, keepaliveTransform, LlmError, loadLlmConfig } from './llm'
import { buildPromptForVideo, PROMPT_VERSION } from './prompt'
import { createNdjsonParser } from './parser'
import { log, logError, newReqId } from './log'
import type { ErrorCode, Mode, StreamEvent } from './types'

export interface Env {
  GEMINI_API_KEY?: string
  GEMINI_MODELS?: string
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

async function inspect(request: Request, _env: Env): Promise<Response> {
  const reqId = newReqId()
  const started = Date.now()
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

async function generate(request: Request, env: Env): Promise<Response> {
  const reqId = newReqId()
  const started = Date.now()

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
  return generateViaGeminiFileData(request, cfg, reqId, fileUri, videoId, mode, started)
}

/**
 * Gemini fileData path: Gemini fetches the YouTube URL itself.
 */
async function generateViaGeminiFileData(
  request: Request,
  cfg: ReturnType<typeof loadLlmConfig>,
  reqId: string,
  fileUri: string,
  videoId: string,
  mode: Mode,
  started: number,
): Promise<Response> {
  const prompt = buildPromptForVideo(mode)
  log({ reqId, route: '/api/generate', phase: 'gemini.fileData.start', videoId, mode })

  const ka = keepaliveTransform(15_000)
  const writer = ka.writable.getWriter()
  const enc = new TextEncoder()
  const writeEvent = (e: StreamEvent) =>
    writer.write(enc.encode(`data: ${JSON.stringify(e)}\n\n`)).catch(() => {})

  ;(async () => {
    let firstChunk = true
    let events = 0
    let parser: ReturnType<typeof createNdjsonParser> | null = null
    try {
      parser = createNdjsonParser(e => {
        if (e.type === 'end') return
        writeEvent(e.type === 'meta' ? { ...e, reqId } : e)
        events++
      })
      for await (const chunk of streamChat(cfg, [
        { fileData: { fileUri } },
        { text: prompt },
      ], request.signal, {
        onHeartbeat: (idleSeconds) => {
          writeEvent({ type: 'heartbeat', idleSeconds, stage: 'upstream_thinking' })
        },
      })) {
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
      try { parser?.end() } catch { /* flush any partial last line from buf */ }
      const code: ErrorCode = err instanceof LlmError ? err.code : 'GEMINI_STREAM_DROP'
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
      'x-req-id': reqId,
    },
  })
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}
