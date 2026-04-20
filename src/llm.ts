/**
 * [WHAT] Gemini API client facade: config loading and model fallback.
 * [WHY]  Public imports stay stable while provider transport, SSE keepalive, and request types
 *        live in focused modules.
 * [INVARIANT] streamChat yields raw text increments. API key is always in a request
 *             header (never in the URL) to prevent leakage.
 */

import type { ErrorCode } from './types'
import { log } from './log'
import { streamGoogle } from './gemini'
import { LlmError, type LlmConfig, type Part, type StreamChatOptions } from './llm-types'

export { LlmError } from './llm-types'
export type { LlmConfig, Part, StreamChatOptions } from './llm-types'
export { keepaliveTransform } from './sse'

interface Env {
  GEMINI_API_KEY?: string
  GEMINI_MODELS?: string
  GEMINI_MODEL?: string
}

// 2026-04 Gemini 可用列表经 ListModels 核对：3.1 暂无 full-flash（只有 flash-lite），
// 3.0 flash-preview 仍活着。级联：3.0-flash（质量/速度平衡）→ 3.1-flash-lite（更快兜底）
// → 3.1-pro（最强兜底）。
const DEFAULT_MODELS = 'gemini-3-flash-preview,gemini-3.1-flash-lite-preview,gemini-3.1-pro-preview'

export function loadLlmConfig(env: Env): LlmConfig {
  if (!env.GEMINI_API_KEY) {
    throw new LlmError('GEMINI_AUTH', 'No Gemini API key configured (set GEMINI_API_KEY)')
  }
  const modelsStr = env.GEMINI_MODELS ?? env.GEMINI_MODEL ?? DEFAULT_MODELS
  const models = modelsStr.split(',').map(s => s.trim()).filter(Boolean)
  return { models, apiKey: env.GEMINI_API_KEY }
}

/** Streams the Gemini response as raw text increments, with cascading model fallback. */
export async function* streamChat(
  cfg: LlmConfig,
  partsOrPrompt: Part[] | string,
  signal?: AbortSignal,
  opts: StreamChatOptions = {},
): AsyncGenerator<string> {
  if (signal?.aborted) throw new LlmError('GEMINI_STREAM_DROP', 'aborted before start')
  const parts: Part[] = typeof partsOrPrompt === 'string' ? [{ text: partsOrPrompt }] : partsOrPrompt
  const fallbackTriggers = new Set<ErrorCode>([
    'GEMINI_OVERLOADED',  // 503 overloaded
    'GEMINI_RATE_LIMIT',  // 429 rate limit
    'GEMINI_QUOTA',       // 429 quota exhausted (per-model on free tier)
    'GEMINI_TIMEOUT',     // catch-all transient upstream errors (500/504/unknown 4xx)
    'GEMINI_STREAM_DROP', // network/stream severed before first token
    'GEMINI_STALL',       // 120s no tokens before first token — next model may respond
  ])
  const noFallbackCodes = new Set(opts.noFallbackCodes ?? [])

  for (let i = 0; i < cfg.models.length; i++) {
    const model = cfg.models[i]!
    log({ phase: 'llm.try_model', model, attempt: i + 1 })
    let firstTokenSeen = false
    try {
      for await (const chunk of streamGoogle({ model, apiKey: cfg.apiKey }, parts, signal, opts)) {
        if (!firstTokenSeen) {
          firstTokenSeen = true
          log({ phase: 'llm.accepted', model, attempt: i + 1 })
        }
        yield chunk
      }
      return
    } catch (err) {
      if (!firstTokenSeen && err instanceof LlmError && noFallbackCodes.has(err.code)) throw err
      if (!firstTokenSeen && err instanceof LlmError && fallbackTriggers.has(err.code) && i < cfg.models.length - 1) {
        log({ phase: 'llm.fallback', from: model, to: cfg.models[i + 1], reason: err.code })
        opts.onModelFallback?.(model, cfg.models[i + 1]!, err.code)
        continue
      }
      throw err
    }
  }
}
