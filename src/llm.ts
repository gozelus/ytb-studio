/**
 * [WHAT] Gemini API client: token counting, streaming chat, and SSE keepalive.
 * [WHY]  Single-provider (Google Gemini) keeps the codebase minimal; Gemini fileData
 *        lets Google's own servers fetch YouTube videos, bypassing CF edge IP blocks.
 * [INVARIANT] streamChat yields raw text increments. countPromptTokens returns the
 *             exact token count via :countTokens (used as a UI hint for track selection).
 *             API key is always in a request header (never in the URL) to prevent leakage.
 */

import type { ErrorCode } from './types'

export class LlmError extends Error {
  constructor(public code: ErrorCode, message?: string) { super(message ?? code) }
}

export interface LlmConfig {
  model: string
  apiKey: string
}

export type Part = { text: string } | { fileData: { fileUri: string; mimeType?: string } }

interface Env {
  GEMINI_API_KEY?: string
  GEMINI_MODEL?: string
}

const DEFAULT_MODEL = 'gemini-2.5-flash'

export function loadLlmConfig(env: Env): LlmConfig {
  if (!env.GEMINI_API_KEY) {
    throw new LlmError('GEMINI_AUTH', 'No Gemini API key configured (set GEMINI_API_KEY)')
  }
  return {
    model: env.GEMINI_MODEL ?? DEFAULT_MODEL,
    apiKey: env.GEMINI_API_KEY,
  }
}

/**
 * Token count for the given text via Gemini :countTokens endpoint.
 * Used as a UI hint for track selection; not a hard limit.
 */
export async function countPromptTokens(
  cfg: LlmConfig,
  text: string,
  signal?: AbortSignal,
  opts: { sleepFn?: (ms: number) => Promise<void> } = {},
): Promise<number> {
  const base = 'https://generativelanguage.googleapis.com/v1beta'
  const res = await retryingFetch(`${base}/models/${cfg.model}:countTokens`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': cfg.apiKey },
    body: JSON.stringify({ contents: [{ parts: [{ text }] }] }),
    signal,
  }, { sleepFn: opts.sleepFn, signal })
  const data = await res.json() as { totalTokens?: number }
  return data.totalTokens ?? 0
}

/** Streams the Gemini response as raw text increments. */
export async function* streamChat(
  cfg: LlmConfig,
  partsOrPrompt: Part[] | string,
  signal?: AbortSignal,
  opts: {
    _idleTimeoutMs?: number
    _heartbeatIntervalMs?: number
    onHeartbeat?: (idleSeconds: number) => void
  } = {},
): AsyncGenerator<string> {
  if (signal?.aborted) throw new LlmError('GEMINI_STREAM_DROP', 'aborted before start')
  const parts: Part[] = typeof partsOrPrompt === 'string' ? [{ text: partsOrPrompt }] : partsOrPrompt
  yield* streamGoogle(cfg, parts, signal, opts)
}

// ── keepalive ────────────────────────────────────────────────────────────────

/**
 * TransformStream that injects an SSE keepalive comment (`: keepalive\n\n`) whenever no data
 * has flowed for intervalMs. Default 15 s is half of Cloudflare's 30 s idle stream timeout.
 */
export function keepaliveTransform(intervalMs = 15_000) {
  const enc = new TextEncoder()
  const keepalive = enc.encode(': keepalive\n\n')
  let timer: ReturnType<typeof setTimeout> | null = null
  let closed = false
  let ctrlRef: TransformStreamDefaultController<Uint8Array> | null = null

  const schedule = () => {
    if (closed) return
    timer = setTimeout(() => {
      if (closed || !ctrlRef) return
      ctrlRef.enqueue(keepalive)
      schedule()
    }, intervalMs)
  }

  return new TransformStream<Uint8Array, Uint8Array>({
    start(controller) { ctrlRef = controller; schedule() },
    transform(chunk, controller) {
      if (timer) { clearTimeout(timer); timer = null }
      controller.enqueue(chunk)
      schedule()
    },
    flush() { closed = true; if (timer) clearTimeout(timer) },
  })
}

// ── internal helpers ─────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

async function retryingFetch(
  url: string,
  init: RequestInit,
  opts: {
    retries429?: number
    retries5xx?: number
    sleepFn?: (ms: number) => Promise<void>
    signal?: AbortSignal
  } = {},
): Promise<Response> {
  const { retries429 = 2, retries5xx = 1, sleepFn = sleep, signal } = opts
  let attempt429 = 0
  let attempt5xx = 0
  let attempt503 = 0
  const retries503 = 3
  let delay = 1000
  while (true) {
    const res = await fetch(url, init)
    if (res.ok) return res
    if (res.status === 401 || res.status === 403) throw new LlmError('GEMINI_AUTH')
    if (res.status === 429) {
      const body429 = await res.text().catch(() => '')
      if (body429.includes('RESOURCE_EXHAUSTED')) {
        throw new LlmError('GEMINI_QUOTA', `quota exhausted: ${body429.slice(0, 200)}`)
      }
      if (attempt429 < retries429) {
        await sleepFn(delay)
        if (signal?.aborted) throw new LlmError('GEMINI_STREAM_DROP', 'aborted during retry')
        delay *= 3; attempt429++; continue
      }
      throw new LlmError('GEMINI_RATE_LIMIT')
    }
    // 503 UNAVAILABLE: demand spike, typically resolves within 30 s — worth retrying 3×.
    if (res.status === 503) {
      const body503 = await res.text().catch(() => '')
      if (attempt503 < retries503) {
        const backoff = [1000, 3000, 6000][attempt503] ?? 6000
        await sleepFn(backoff)
        if (signal?.aborted) throw new LlmError('GEMINI_STREAM_DROP', 'aborted during retry')
        attempt503++; continue
      }
      throw new LlmError('GEMINI_OVERLOADED', body503.slice(0, 200))
    }
    if (res.status >= 500 && attempt5xx < retries5xx) {
      await sleepFn(1000)
      if (signal?.aborted) throw new LlmError('GEMINI_STREAM_DROP', 'aborted during retry')
      attempt5xx++; continue
    }
    const body = await res.text().catch(() => '')
    if (res.status === 400) {
      if (/API key not valid|API_KEY_INVALID|invalid authentication/i.test(body))
        throw new LlmError('GEMINI_AUTH', body.slice(0, 200))
      if (/SAFETY|blocked|blockReason/i.test(body))
        throw new LlmError('GEMINI_SAFETY', body.slice(0, 200))
      if (/INVALID_ARGUMENT.*fileData|fileData.*video|cannot be processed/i.test(body))
        throw new LlmError('GEMINI_VIDEO_UNSUPPORTED', `status 400: ${body.slice(0, 200)}`)
      throw new LlmError('GEMINI_TIMEOUT', `status 400: ${body.slice(0, 200)}`)
    }
    throw new LlmError('GEMINI_TIMEOUT', `status ${res.status}: ${body.slice(0, 300)}`)
  }
}

const IDLE_TIMEOUT_MS = 120_000
const HEARTBEAT_INTERVAL_MS = 5_000

/**
 * Shared SSE stream consumer with progressive heartbeat watchdog.
 * Each reader.read() Promise is reused across timer cycles — a fresh race every
 * heartbeatIntervalMs fires onHeartbeat; after idleTimeoutMs total idle the
 * generator throws GEMINI_STALL. Reusing the same Promise is critical: calling
 * reader.read() twice on the same reader would cause a concurrent-read error.
 */
async function* consumeSSE(
  res: Response,
  extractFn: (frame: string) => string,
  signal?: AbortSignal,
  idleTimeoutMs = IDLE_TIMEOUT_MS,
  heartbeatIntervalMs = HEARTBEAT_INTERVAL_MS,
  onHeartbeat?: (idleSeconds: number) => void,
): AsyncGenerator<string> {
  if (!res.body) throw new LlmError('GEMINI_STREAM_DROP', 'no body')
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''

  // Race readPromise against a short tick; reuse the same Promise until it resolves.
  const readWithHeartbeat = async (): Promise<ReadableStreamReadResult<Uint8Array>> => {
    const readPromise = reader.read()
    let idleMs = 0
    while (true) {
      const tick = new Promise<'tick'>(r => setTimeout(r, heartbeatIntervalMs, 'tick'))
      const result = await Promise.race([readPromise, tick])
      if (result !== 'tick') return result as ReadableStreamReadResult<Uint8Array>
      idleMs += heartbeatIntervalMs
      if (idleMs >= idleTimeoutMs)
        throw new LlmError('GEMINI_STALL', `No tokens from Gemini in ${idleTimeoutMs / 1000}s`)
      onHeartbeat?.(idleMs / 1000)
    }
  }

  try {
    while (true) {
      if (signal?.aborted) throw new LlmError('GEMINI_STREAM_DROP', 'aborted')
      const { value, done } = await readWithHeartbeat()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let idx: number
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, idx); buf = buf.slice(idx + 2)
        const text = extractFn(frame)
        if (text) yield text
      }
    }
    if (buf.trim()) { const text = extractFn(buf); if (text) yield text }
  } finally {
    try { reader.cancel() } catch { /* ignore */ }
  }
}

// ── Google Gemini ─────────────────────────────────────────────────────────────

async function* streamGoogle(
  cfg: LlmConfig,
  parts: Part[],
  signal?: AbortSignal,
  opts: { _idleTimeoutMs?: number; _heartbeatIntervalMs?: number; onHeartbeat?: (idleSeconds: number) => void } = {},
) {
  const base = 'https://generativelanguage.googleapis.com/v1beta'
  const res = await retryingFetch(`${base}/models/${cfg.model}:streamGenerateContent?alt=sse`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': cfg.apiKey },
    body: JSON.stringify({
      contents: [{ parts }],
      generationConfig: { temperature: 0.7, maxOutputTokens: 32768 },
    }),
    signal,
  }, { retries429: 2, retries5xx: 1, signal })
  yield* consumeSSE(res, extractGoogleText, signal, opts._idleTimeoutMs, opts._heartbeatIntervalMs, opts.onHeartbeat)
}

function extractGoogleText(frame: string): string {
  const out: string[] = []
  for (const line of frame.split('\n')) {
    if (!line.startsWith('data:')) continue
    const payload = line.slice(5).trim()
    if (!payload || payload === '[DONE]') continue
    try {
      const obj = JSON.parse(payload) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }
      for (const c of obj.candidates ?? [])
        for (const p of c.content?.parts ?? [])
          if (p.text) out.push(p.text)
    } catch { /* skip malformed frame */ }
  }
  return out.join('')
}
