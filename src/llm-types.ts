import type { ErrorCode } from './types'

export class LlmError extends Error {
  constructor(public code: ErrorCode, message?: string) { super(message ?? code) }
}

export interface LlmConfig {
  models: string[]
  apiKey: string
}

export type Part =
  | { text: string }
  | {
      fileData: { fileUri: string; mimeType?: string }
      videoMetadata?: { startOffset?: string; endOffset?: string; fps?: number }
    }

export type MediaResolution =
  | 'MEDIA_RESOLUTION_LOW'
  | 'MEDIA_RESOLUTION_MEDIUM'
  | 'MEDIA_RESOLUTION_HIGH'

export interface StreamChatOptions {
  _idleTimeoutMs?: number
  _heartbeatIntervalMs?: number
  _textIdleTimeoutMs?: number
  initialResponseTimeoutMs?: number
  mediaResolution?: MediaResolution
  noFallbackCodes?: ErrorCode[]
  onHeartbeat?: (idleSeconds: number) => void
  onModelFallback?: (from: string, to: string, reason: ErrorCode) => void
}
