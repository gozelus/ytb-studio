import { buildPromptForVideoSegment } from './prompt'
import { log } from './log'
import { LlmError } from './llm'
import { streamVideoNdjson, videoPart } from './video-ndjson'
import type { Env } from './env'
import type { LlmConfig } from './llm'
import type { Mode, StreamEvent } from './types'

const SEGMENT_FIRST_BYTE_TIMEOUT_MS = 90_000
const MIN_SEGMENT_SECONDS = 60

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
    60,
    segmentSeconds,
    Math.min(180, segmentSeconds),
  )
  const maxSegments = clampNumber(Number(opts.env.LONG_VIDEO_MAX_SEGMENTS), 1, 24, 16)
  let totalEvents = 0
  let metaSent = false
  let emittedAny = false
  const seenHeadings = new Set<string>()

  const streamRange = async (segmentIndex: number, startSec: number, endSec: number, depth = 0): Promise<number> => {
    const progress = { firstChunk: false, events: 0 }
    log({ reqId: opts.reqId, route: '/api/generate', phase: 'long_video.segment.start', videoId: opts.videoId, segmentIndex, startSec, endSec, depth })
    await opts.writeEvent({
      type: 'heartbeat',
      idleSeconds: 0,
      stage: 'long_video_segment_start',
      segmentIndex,
      maxSegments,
      startSec,
      endSec,
    })
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
          if (e.type === 'h2' || e.type === 'h3') {
            const key = normalizeHeading(e)
            if (seenHeadings.has(key)) return false
            seenHeadings.add(key)
          }
          emittedAny = true
          opts.writeEvent(e)
          return true
        },
        onHeartbeat: idleSeconds => opts.writeEvent({
          type: 'heartbeat',
          idleSeconds,
          stage: `long_video_segment_${segmentIndex + 1}`,
          segmentIndex,
          maxSegments,
          startSec,
          endSec,
        }),
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
      await opts.writeEvent({
        type: 'heartbeat',
        idleSeconds: 0,
        stage: 'long_video_segment_done',
        segmentIndex,
        maxSegments,
        startSec,
        endSec,
        events: progress.events,
      })
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
      if (err instanceof LlmError && err.code === 'GEMINI_STALL' && progress.events === 0) {
        log({ reqId: opts.reqId, route: '/api/generate', phase: 'long_video.segment.skip_empty_stall', videoId: opts.videoId, segmentIndex, startSec, endSec, depth })
        return 0
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

function normalizeHeading(e: Extract<StreamEvent, { type: 'h2' | 'h3' }>): string {
  return `${e.type}:${e.text.trim().replace(/\s+/g, '')}`
}
