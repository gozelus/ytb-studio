/**
 * [WHAT] Shared TypeScript types for the entire worker: modes, caption data, stream events, error codes.
 * [WHY]  Single source of truth imported by all modules; keeps circular-dependency risk at zero.
 * [INVARIANT] The StreamEvent union is exhaustive — adding a new event type here requires updating
 *             the parser's VALID_TYPES set and the frontend renderer simultaneously.
 */

export type Mode = 'rewrite' | 'faithful'

export type CaptionKind = 'manual' | 'auto'

export interface CaptionTrack {
  id: string
  lang: string
  label: string
  kind: CaptionKind
  baseUrl: string
  tokens?: number
}

export interface VideoMeta {
  videoId: string
  title: string
  channel: string
  durationSec: number
}

export type StreamEvent =
  | { type: 'meta';  reqId: string; title: string; subtitle: string; durationSec: number }
  | { type: 'h2';    text: string }
  | { type: 'h3';    text: string }
  | { type: 'p';     speaker: string | null; text: string }
  | { type: 'end' }
  | { type: 'error'; code: string; message: string }

export type ErrorCode =
  | 'INVALID_URL'
  | 'VIDEO_NOT_FOUND'
  | 'NO_CAPTIONS'
  | 'YOUTUBE_BLOCKED'
  | 'PROXY_REQUIRED'
  | 'LLM_AUTH'
  | 'LLM_RATE_LIMIT'
  | 'LLM_QUOTA'
  | 'LLM_TIMEOUT'
  | 'LLM_STREAM_DROP'
  | 'LLM_SAFETY'
  | 'LLM_VIDEO_UNSUPPORTED'
  | 'INTERNAL'
