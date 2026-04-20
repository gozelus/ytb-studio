/**
 * [WHAT] Shared TypeScript types for the entire worker: modes, stream events, error codes.
 * [WHY]  Single source of truth imported by all modules; keeps circular-dependency risk at zero.
 * [INVARIANT] The StreamEvent union is exhaustive — adding a new event type here requires updating
 *             the parser's VALID_TYPES set and the frontend renderer simultaneously.
 */

export type Mode = 'rewrite' | 'faithful'

export type StreamEvent =
  | { type: 'meta';      reqId?: string; title: string; subtitle?: string; durationSec?: number | null }
  | { type: 'h2';        text: string }
  | { type: 'h3';        text: string }
  | { type: 'p';         speaker: string | null; text: string }
  | { type: 'end' }
  | {
      type: 'heartbeat'
      idleSeconds: number
      stage: string
      from?: string
      to?: string
      reason?: string
      segmentIndex?: number
      maxSegments?: number
      startSec?: number
      endSec?: number
      events?: number
    }
  | { type: 'error';     code: string; message: string }

export type ErrorCode =
  | 'INVALID_URL'
  | 'GEMINI_AUTH'
  | 'GEMINI_OVERLOADED'
  | 'GEMINI_STALL'
  | 'GEMINI_RATE_LIMIT'
  | 'GEMINI_QUOTA'
  | 'GEMINI_CONTEXT_LIMIT'
  | 'GEMINI_LONG_VIDEO_LIMIT'
  | 'GEMINI_TIMEOUT'
  | 'GEMINI_STREAM_DROP'
  | 'GEMINI_SAFETY'
  | 'GEMINI_VIDEO_UNSUPPORTED'
  | 'INTERNAL'
