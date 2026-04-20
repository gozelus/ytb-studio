/**
 * [WHAT] Cloudflare Worker entry point: routes /api/inspect and /api/generate;
 *        serves static assets via the ASSETS binding for everything else.
 * [WHY]  Single Worker file keeps deployment simple (no separate Pages Functions project).
 * [INVARIANT] /api/generate always responds HTTP 200 immediately, then streams SSE events.
 *             Errors mid-stream are delivered as {"type":"error"} events, not HTTP status codes.
 */

import { normalizeVideoUrl, parseVideoId } from './youtube'
import { streamChat, keepaliveTransform, LlmError, loadLlmConfig } from './llm'
import { buildPromptForVideo, buildPromptForVideoSegment, PROMPT_VERSION } from './prompt'
import { createNdjsonParser } from './parser'
import { log, logError, newReqId } from './log'
import type { ErrorCode, Mode, StreamEvent } from './types'
import type { Part } from './llm'

const FULL_VIDEO_FIRST_BYTE_TIMEOUT_MS = 75_000
const SEGMENT_FIRST_BYTE_TIMEOUT_MS = 90_000
const MIN_SEGMENT_SECONDS = 300

export interface Env {
  GEMINI_API_KEY?: string
  GEMINI_MODELS?: string
  GEMINI_MODEL?: string
  LONG_VIDEO_FIRST_SEGMENT_SECONDS?: string
  LONG_VIDEO_SEGMENT_SECONDS?: string
  LONG_VIDEO_MAX_SEGMENTS?: string
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
  return generateViaGeminiFileData(request, env, cfg, reqId, fileUri, videoId, mode, started)
}

/**
 * Gemini fileData path: Gemini fetches the YouTube URL itself.
 */
async function generateViaGeminiFileData(
  request: Request,
  env: Env,
  cfg: ReturnType<typeof loadLlmConfig>,
  reqId: string,
  fileUri: string,
  videoId: string,
  mode: Mode,
  started: number,
): Promise<Response> {
  log({ reqId, route: '/api/generate', phase: 'gemini.fileData.start', videoId, mode })

  const ka = keepaliveTransform(15_000)
  const writer = ka.writable.getWriter()
  const enc = new TextEncoder()
  const writeEvent = (e: StreamEvent) =>
    writer.write(enc.encode(`data: ${JSON.stringify(e)}\n\n`)).catch(() => {})

  ;(async () => {
    try {
      const full = { firstChunk: false, events: 0 }
      try {
        await streamVideoNdjson({
          cfg,
          signal: request.signal,
          parts: [
            videoPart(fileUri, { fps: 0.5 }),
            { text: buildPromptForVideo(mode) },
          ],
          onEvent: e => {
            if (e.type === 'end') return false
            writeEvent(e.type === 'meta' ? { ...e, reqId } : e)
            return true
          },
          onHeartbeat: idleSeconds => writeEvent({ type: 'heartbeat', idleSeconds, stage: 'upstream_thinking' }),
          onModelFallback: (from, to, reason) => {
            void writeEvent({ type: 'heartbeat', idleSeconds: 0, stage: 'model_fallback', from, to, reason })
          },
          progress: full,
          initialResponseTimeoutMs: FULL_VIDEO_FIRST_BYTE_TIMEOUT_MS,
          idleTimeoutMs: FULL_VIDEO_FIRST_BYTE_TIMEOUT_MS,
          textIdleTimeoutMs: FULL_VIDEO_FIRST_BYTE_TIMEOUT_MS,
          firstTextTimeoutMs: FULL_VIDEO_FIRST_BYTE_TIMEOUT_MS,
          noFallbackCodes: ['GEMINI_STALL', 'GEMINI_CONTEXT_LIMIT'],
        })
      } catch (err) {
        const shouldSegment = err instanceof LlmError
          && (err.code === 'GEMINI_CONTEXT_LIMIT' || err.code === 'GEMINI_STALL')
          && !full.firstChunk
          && full.events === 0
        if (!shouldSegment) throw err
        log({ reqId, route: '/api/generate', phase: 'long_video.segment_fallback', videoId, mode, reason: err instanceof LlmError ? err.code : 'unknown' })
        await writeEvent({ type: 'heartbeat', idleSeconds: 0, stage: 'long_video_fallback' })
        const segmentedEvents = await streamLongVideoSegments({
          cfg,
          env,
          reqId,
          request,
          fileUri,
          videoId,
          mode,
          writeEvent,
          started,
        })
        if (segmentedEvents.limited) {
          await writeEvent({
            type: 'error',
            code: 'GEMINI_LONG_VIDEO_LIMIT',
            message: segmentedEvents.limitMessage,
          })
        } else {
          await writeEvent({ type: 'end' })
        }
        log({ reqId, phase: 'done', mode: 'long_video_segments', limited: segmentedEvents.limited, durMs: Date.now() - started, events: segmentedEvents.events })
        return
      }
      await writeEvent({ type: 'end' })
      log({ reqId, phase: 'done', durMs: Date.now() - started, events: full.events })
    } catch (err) {
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

async function streamLongVideoSegments(opts: {
  cfg: ReturnType<typeof loadLlmConfig>
  env: Env
  reqId: string
  request: Request
  fileUri: string
  videoId: string
  mode: Mode
  writeEvent: (e: StreamEvent) => Promise<void>
  started: number
}): Promise<{ events: number; limited: boolean; limitMessage: string }> {
  const segmentSeconds = clampNumber(Number(opts.env.LONG_VIDEO_SEGMENT_SECONDS), 300, 3600, 900)
  const firstSegmentSeconds = clampNumber(
    Number(opts.env.LONG_VIDEO_FIRST_SEGMENT_SECONDS),
    120,
    segmentSeconds,
    Math.min(300, segmentSeconds),
  )
  const maxSegments = clampNumber(Number(opts.env.LONG_VIDEO_MAX_SEGMENTS), 1, 24, 16)
  let totalEvents = 0
  let metaSent = false
  let emittedAny = false

  const streamRange = async (segmentIndex: number, startSec: number, endSec: number, depth = 0): Promise<number> => {
    const progress = { firstChunk: false, events: 0 }
    log({ reqId: opts.reqId, route: '/api/generate', phase: 'long_video.segment.start', videoId: opts.videoId, segmentIndex, startSec, endSec, depth })
    try {
      await streamVideoNdjson({
        cfg: opts.cfg,
        signal: opts.request.signal,
        parts: [
          videoPart(opts.fileUri, { startSec, endSec, fps: 0.25 }),
          { text: buildPromptForVideoSegment(opts.mode, { segmentIndex, startSec, endSec, includeMeta: !metaSent }) },
        ],
        onEvent: e => {
          if (e.type === 'end') return false
          if (e.type === 'meta') {
            if (metaSent) return false
            metaSent = true
            emittedAny = true
            opts.writeEvent({ ...e, reqId: opts.reqId })
            return true
          }
          emittedAny = true
          opts.writeEvent(e)
          return true
        },
        onHeartbeat: idleSeconds => opts.writeEvent({ type: 'heartbeat', idleSeconds, stage: `long_video_segment_${segmentIndex + 1}` }),
        onModelFallback: (from, to, reason) => {
          void opts.writeEvent({ type: 'heartbeat', idleSeconds: 0, stage: 'model_fallback', from, to, reason })
        },
        progress,
        initialResponseTimeoutMs: SEGMENT_FIRST_BYTE_TIMEOUT_MS,
        idleTimeoutMs: SEGMENT_FIRST_BYTE_TIMEOUT_MS,
        textIdleTimeoutMs: SEGMENT_FIRST_BYTE_TIMEOUT_MS,
        firstTextTimeoutMs: SEGMENT_FIRST_BYTE_TIMEOUT_MS,
        noFallbackCodes: ['GEMINI_STALL', 'GEMINI_CONTEXT_LIMIT'],
      })
      log({ reqId: opts.reqId, route: '/api/generate', phase: 'long_video.segment.done', videoId: opts.videoId, segmentIndex, startSec, endSec, depth, events: progress.events })
      return progress.events
    } catch (err) {
      if (opts.request.signal.aborted) throw new LlmError('GEMINI_STREAM_DROP', 'aborted')
      const canSplit = err instanceof LlmError
        && (err.code === 'GEMINI_CONTEXT_LIMIT' || err.code === 'GEMINI_STALL')
        && progress.events === 0
        && endSec - startSec > MIN_SEGMENT_SECONDS
      if (canSplit) {
        const midSec = startSec + Math.ceil((endSec - startSec) / 2)
        log({ reqId: opts.reqId, route: '/api/generate', phase: 'long_video.segment.split', videoId: opts.videoId, segmentIndex, startSec, midSec, endSec, reason: err.code })
        const leftEvents = await streamRange(segmentIndex, startSec, midSec, depth + 1)
        const rightEvents = await streamRange(segmentIndex, midSec, endSec, depth + 1)
        return leftEvents + rightEvents
      }
      if (emittedAny && err instanceof LlmError && err.code === 'GEMINI_VIDEO_UNSUPPORTED' && progress.events === 0) {
        log({ reqId: opts.reqId, route: '/api/generate', phase: 'long_video.segment.end_of_media', videoId: opts.videoId, segmentIndex, startSec, endSec })
        return 0
      }
      throw err
    }
  }

  let cursorSec = 0
  for (let segmentIndex = 0; segmentIndex < maxSegments; segmentIndex++) {
    const spanSec = segmentIndex === 0 ? firstSegmentSeconds : segmentSeconds
    const startSec = cursorSec
    const endSec = startSec + spanSec
    cursorSec = endSec
    const segmentEvents = await streamRange(segmentIndex, startSec, endSec)
    totalEvents += segmentEvents
    if (segmentEvents === 0 && totalEvents > 0) {
      return { events: totalEvents, limited: false, limitMessage: '' }
    }
    if (opts.request.signal.aborted) throw new LlmError('GEMINI_STREAM_DROP', 'aborted')
  }

  if (totalEvents > 0) {
    return {
      events: totalEvents,
      limited: true,
      limitMessage: `已处理前 ${Math.round(cursorSec / 60)} 分钟；可通过 LONG_VIDEO_MAX_SEGMENTS 扩大上限。`,
    }
  }
  throw new LlmError('GEMINI_CONTEXT_LIMIT', 'long video segmentation returned no article events')
}

async function streamVideoNdjson(opts: {
  cfg: ReturnType<typeof loadLlmConfig>
  parts: Part[]
  signal?: AbortSignal
  progress: { firstChunk: boolean; events: number }
  initialResponseTimeoutMs?: number
  idleTimeoutMs?: number
  textIdleTimeoutMs?: number
  firstTextTimeoutMs?: number
  noFallbackCodes?: ErrorCode[]
  onEvent: (e: StreamEvent) => boolean | void
  onHeartbeat: (idleSeconds: number) => void
  onModelFallback?: (from: string, to: string, reason: ErrorCode) => void
}): Promise<void> {
  let parser: ReturnType<typeof createNdjsonParser> | null = null
  const controller = new AbortController()
  const abortFromParent = () => controller.abort()
  if (opts.signal?.aborted) controller.abort()
  opts.signal?.addEventListener('abort', abortFromParent, { once: true })
  try {
    parser = createNdjsonParser(e => {
      if (opts.onEvent(e)) opts.progress.events++
    })
    const stream = streamChat(opts.cfg, opts.parts, controller.signal, {
      initialResponseTimeoutMs: opts.initialResponseTimeoutMs,
      _idleTimeoutMs: opts.idleTimeoutMs,
      _textIdleTimeoutMs: opts.textIdleTimeoutMs,
      mediaResolution: 'MEDIA_RESOLUTION_LOW',
      noFallbackCodes: opts.noFallbackCodes,
      onHeartbeat: opts.onHeartbeat,
      onModelFallback: opts.onModelFallback,
    })
    const iter = stream[Symbol.asyncIterator]()
    const deadlineAt = opts.firstTextTimeoutMs ? Date.now() + opts.firstTextTimeoutMs : 0
    while (true) {
      const next = opts.progress.firstChunk || !deadlineAt
        ? await iter.next()
        : await nextWithDeadline(iter, controller, Math.max(0, deadlineAt - Date.now()), opts.firstTextTimeoutMs!)
      if (next.done) break
      const chunk = next.value
      if (!opts.progress.firstChunk) {
        opts.progress.firstChunk = true
      }
      parser.feed(chunk)
    }
    parser.end()
  } catch (err) {
    try { parser?.end() } catch { /* flush any partial last line from buf */ }
    throw err
  } finally {
    opts.signal?.removeEventListener('abort', abortFromParent)
  }
}

async function nextWithDeadline(
  iter: AsyncIterator<string>,
  controller: AbortController,
  timeoutMs: number,
  configuredTimeoutMs: number,
): Promise<IteratorResult<string>> {
  if (timeoutMs <= 0) {
    controller.abort()
    throw new LlmError('GEMINI_STALL', `No Gemini text in ${Math.round(configuredTimeoutMs / 1000)}s`)
  }
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      iter.next(),
      new Promise<IteratorResult<string>>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort()
          void iter.return?.()
          reject(new LlmError('GEMINI_STALL', `No Gemini text in ${Math.round(configuredTimeoutMs / 1000)}s`))
        }, timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function videoPart(fileUri: string, opts: { startSec?: number; endSec?: number; fps?: number } = {}): Part {
  const part: Part = { fileData: { fileUri, mimeType: 'video/*' } }
  const videoMetadata: { startOffset?: string; endOffset?: string; fps?: number } = {}
  if (opts.startSec !== undefined) videoMetadata.startOffset = `${opts.startSec}s`
  if (opts.endSec !== undefined) videoMetadata.endOffset = `${opts.endSec}s`
  if (opts.fps !== undefined) videoMetadata.fps = opts.fps
  if (Object.keys(videoMetadata).length > 0 && 'fileData' in part) part.videoMetadata = videoMetadata
  return part
}

function clampNumber(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.floor(value)))
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}
