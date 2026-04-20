import { buildPromptForVideoSegment } from './prompt'
import { log } from './log'
import { LlmError } from './llm'
import { streamVideoNdjson, videoPart } from './video-ndjson'
import type { Env } from './env'
import type { LlmConfig } from './llm'
import type { Mode, StreamEvent } from './types'

const SEGMENT_FIRST_BYTE_TIMEOUT_MS = 90_000
const MIN_SEGMENT_SECONDS = 300

export async function streamLongVideoSegments(opts: {
  cfg: LlmConfig
  env: Env
  reqId: string
  request: Request
  fileUri: string
  videoId: string
  mode: Mode
  writeEvent: (e: StreamEvent) => Promise<void>
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

function clampNumber(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.floor(value)))
}
