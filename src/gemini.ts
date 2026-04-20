import type { ErrorCode } from './types'
import { LlmError, type Part, type StreamChatOptions } from './llm-types'

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

async function retryingFetch(
  url: string,
  init: RequestInit,
  opts: {
    retries429?: number
    retries5xx?: number
    requestTimeoutMs?: number
    sleepFn?: (ms: number) => Promise<void>
    signal?: AbortSignal
  } = {},
): Promise<Response> {
  const { retries429 = 2, retries5xx = 1, requestTimeoutMs, sleepFn = sleep, signal } = opts
  let attempt429 = 0
  let attempt5xx = 0
  let attempt503 = 0
  const retries503 = 3
  let delay = 1000
  while (true) {
    let timedOut = false
    const controller = new AbortController()
    const abortFromParent = () => controller.abort()
    let timer: ReturnType<typeof setTimeout> | null = null
    if (signal?.aborted) throw new LlmError('GEMINI_STREAM_DROP', 'aborted before fetch')
    signal?.addEventListener('abort', abortFromParent, { once: true })
    if (requestTimeoutMs && requestTimeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true
        controller.abort()
      }, requestTimeoutMs)
    }
    let res: Response
    try {
      res = await fetch(url, { ...init, signal: controller.signal })
    } catch (err) {
      if (timedOut) throw new LlmError('GEMINI_STALL', `No Gemini response headers in ${Math.round(requestTimeoutMs! / 1000)}s`)
      if (signal?.aborted) throw new LlmError('GEMINI_STREAM_DROP', 'aborted during fetch')
      throw err
    } finally {
      if (timer) clearTimeout(timer)
      signal?.removeEventListener('abort', abortFromParent)
    }
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
      if (/input token count exceeds|maximum number of tokens allowed|exceeds the maximum.*tokens/i.test(body))
        throw new LlmError('GEMINI_CONTEXT_LIMIT', `status 400: ${body.slice(0, 200)}`)
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
  textIdleTimeoutMs?: number,
): AsyncGenerator<string> {
  if (!res.body) throw new LlmError('GEMINI_STREAM_DROP', 'no body')
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let lastTextAt = Date.now()

  const checkTextIdle = () => {
    if (textIdleTimeoutMs && Date.now() - lastTextAt >= textIdleTimeoutMs) {
      throw new LlmError('GEMINI_STALL', `No text from Gemini in ${Math.round(textIdleTimeoutMs / 1000)}s`)
    }
  }

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
        if (text) {
          lastTextAt = Date.now()
          yield text
        } else {
          checkTextIdle()
        }
      }
      checkTextIdle()
    }
    if (buf.trim()) {
      const text = extractFn(buf)
      if (text) yield text
      else checkTextIdle()
    }
  } finally {
    try { reader.cancel() } catch { /* ignore */ }
  }
}

export async function* streamGoogle(
  cfg: { model: string; apiKey: string },
  parts: Part[],
  signal?: AbortSignal,
  opts: StreamChatOptions = {},
) {
  const base = 'https://generativelanguage.googleapis.com/v1beta'
  const generationConfig: Record<string, unknown> = { temperature: 0.7, maxOutputTokens: 32768 }
  if (opts.mediaResolution) generationConfig.mediaResolution = opts.mediaResolution
  const res = await retryingFetch(`${base}/models/${cfg.model}:streamGenerateContent?alt=sse`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': cfg.apiKey },
    body: JSON.stringify({
      contents: [{ parts }],
      generationConfig,
    }),
    signal,
  }, { retries429: 2, retries5xx: 1, requestTimeoutMs: opts.initialResponseTimeoutMs, signal })
  yield* consumeSSE(
    res,
    extractGoogleText,
    signal,
    opts._idleTimeoutMs,
    opts._heartbeatIntervalMs,
    opts.onHeartbeat,
    opts._textIdleTimeoutMs,
  )
}

function extractGoogleText(frame: string): string {
  const out: string[] = []
  for (const line of frame.split('\n')) {
    if (!line.startsWith('data:')) continue
    const payload = line.slice(5).trim()
    if (!payload || payload === '[DONE]') continue
    try {
      const obj = JSON.parse(payload) as {
        error?: { code?: number; status?: string; message?: string }
        promptFeedback?: { blockReason?: string }
        candidates?: Array<{
          content?: { parts?: Array<{ text?: string }> }
          finishReason?: string
        }>
      }
      if (obj.error) {
        const { code, status = '', message = '' } = obj.error
        if (code === 503 || /UNAVAILABLE|high demand/i.test(status) || /UNAVAILABLE|high demand/i.test(message))
          throw new LlmError('GEMINI_OVERLOADED', message.slice(0, 200))
        if (code === 401 || code === 403 || /API_KEY_INVALID|API key not valid/i.test(message))
          throw new LlmError('GEMINI_AUTH', message.slice(0, 200))
        if (code === 429)
          throw new LlmError(/RESOURCE_EXHAUSTED/i.test(status) ? 'GEMINI_QUOTA' : 'GEMINI_RATE_LIMIT', message.slice(0, 200))
        if (/SAFETY|blocked|blockReason/i.test(message))
          throw new LlmError('GEMINI_SAFETY', message.slice(0, 200))
        if (/input token count exceeds|maximum number of tokens allowed|exceeds the maximum.*tokens/i.test(message))
          throw new LlmError('GEMINI_CONTEXT_LIMIT', message.slice(0, 200))
        if (/INVALID_ARGUMENT.*fileData|fileData.*video|cannot be processed/i.test(message))
          throw new LlmError('GEMINI_VIDEO_UNSUPPORTED', message.slice(0, 200))
        throw new LlmError('GEMINI_TIMEOUT', `stream error ${code}: ${message.slice(0, 200)}`)
      }
      if (obj.promptFeedback?.blockReason)
        throw new LlmError('GEMINI_SAFETY', `promptFeedback.blockReason=${obj.promptFeedback.blockReason}`)
      for (const c of obj.candidates ?? []) {
        const fr = c.finishReason
        if (fr && fr !== 'STOP' && fr !== 'FINISH_REASON_UNSPECIFIED') {
          if (fr === 'SAFETY' || fr === 'RECITATION') throw new LlmError('GEMINI_SAFETY', `finishReason=${fr}`)
          if (fr === 'MAX_TOKENS') throw new LlmError('GEMINI_TIMEOUT', 'output truncated: MAX_TOKENS')
          throw new LlmError('GEMINI_STREAM_DROP', `finishReason=${fr}`)
        }
        for (const p of c.content?.parts ?? []) if (p.text) out.push(p.text)
      }
    } catch (e) {
      if (e instanceof LlmError) throw e
      /* skip truly malformed frames */
    }
  }
  return out.join('')
}
