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
  | 'GEMINI_AUTH'
  | 'GEMINI_RATE_LIMIT'
  | 'GEMINI_QUOTA'
  | 'GEMINI_SAFETY'
  | 'GEMINI_TIMEOUT'
  | 'GEMINI_STREAM_DROP'
  | 'INTERNAL'
