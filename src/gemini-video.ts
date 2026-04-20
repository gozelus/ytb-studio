import { keepaliveTransform, LlmError } from './llm'
import { buildPromptForVideo } from './prompt'
import { log, logError } from './log'
import { streamLongVideoSegments } from './long-video'
import { streamVideoNdjson, videoPart } from './video-ndjson'
import type { Env } from './env'
import type { LlmConfig } from './llm'
import type { ErrorCode, Mode, StreamEvent } from './types'

const FULL_VIDEO_FIRST_BYTE_TIMEOUT_MS = 75_000

/**
 * Gemini fileData path: Gemini fetches the YouTube URL itself.
 */
export async function generateViaGeminiFileData(
  request: Request,
  env: Env,
  cfg: LlmConfig,
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
