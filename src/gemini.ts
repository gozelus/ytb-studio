/**
 * [WHAT] Gemini API client: token counting, SSE content streaming, and SSE keepalive transform.
 * [WHY]  All Gemini I/O isolated here so retry/backoff logic and SSE parsing can be unit-tested
 *        without a live Worker context.
 * [INVARIANT] API key is sent via x-goog-api-key header (never in the URL query string) to prevent
 *             key leakage in error messages, access logs, or String(err) stack traces.
 */

import type { ErrorCode } from './types'

/** A single content part passed to Gemini: plain text or a fileData URI (e.g. a YouTube URL). */
export type Part = { text: string } | { fileData: { fileUri: string; mimeType: string } }

const API = 'https://generativelanguage.googleapis.com/v1beta'

export class GeminiError extends Error {
  constructor(public code: ErrorCode, message?: string) { super(message ?? code) }
}

interface Env {
  GEMINI_API_KEY: string
  GEMINI_MODEL?: string
}

function model(env: Env) { return env.GEMINI_MODEL ?? 'gemini-2.5-flash' }

function geminiHeaders(env: Env): Record<string, string> {
  return {
    'content-type': 'application/json',
    'x-goog-api-key': env.GEMINI_API_KEY,
  }
}

async function retryingFetch(
  url: string,
  init: RequestInit,
  opts: { retries429?: number; retries5xx?: number; sleepFn?: (ms: number) => Promise<void>; signal?: AbortSignal } = {},
): Promise<Response> {
  const { retries429 = 2, retries5xx = 1, sleepFn = sleep, signal } = opts
  let attempt429 = 0
  let attempt5xx = 0
  let delay = 1000
  while (true) {
    const res = await fetch(url, init)
    if (res.ok) return res
    if (res.status === 401 || res.status === 403) throw new GeminiError('GEMINI_AUTH')
    if (res.status === 429 && attempt429 < retries429) {
      await sleepFn(delay)
      if (signal?.aborted) throw new GeminiError('GEMINI_STREAM_DROP', 'aborted during retry')
      // 1 s → 3 s → give up: two retries stay well under CF Workers' 30 s CPU limit.
      delay *= 3; attempt429++; continue
    }
    if (res.status >= 500 && attempt5xx < retries5xx) {
      await sleepFn(1000)
      if (signal?.aborted) throw new GeminiError('GEMINI_STREAM_DROP', 'aborted during retry')
      attempt5xx++; continue
    }
    if (res.status === 429) throw new GeminiError('GEMINI_RATE_LIMIT')
    throw new GeminiError('GEMINI_TIMEOUT', `status ${res.status}`)
  }
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

/** Returns Gemini's token count for the given text; used to label caption tracks in /api/inspect. */
export async function countTokens(
  env: Env,
  text: string,
  signal?: AbortSignal,
  opts: { sleepFn?: (ms: number) => Promise<void> } = {},
): Promise<number> {
  const url = `${API}/models/${model(env)}:countTokens`
  const res = await retryingFetch(url, {
    method: 'POST',
    headers: geminiHeaders(env),
    body: JSON.stringify({ contents: [{ parts: [{ text }] }] }),
    signal,
  }, { sleepFn: opts.sleepFn, signal })
  const data = await res.json() as { totalTokens?: number }
  return data.totalTokens ?? 0
}

/**
 * Streams Gemini's response as raw text chunks extracted from SSE frames.
 * Each yielded string is the concatenated text from one SSE event's candidates.
 * parts can be text-only ([{text}]) or mixed ([{fileData}, {text}]) for video input.
 */
export async function* streamGenerate(
  env: Env,
  parts: Part[],
  signal?: AbortSignal,
): AsyncGenerator<string> {
  // Check before the fetch so a pre-cancelled signal never starts a billable request.
  if (signal?.aborted) throw new GeminiError('GEMINI_STREAM_DROP', 'aborted before start')
  const url = `${API}/models/${model(env)}:streamGenerateContent?alt=sse`
  const res = await retryingFetch(url, {
    method: 'POST',
    headers: geminiHeaders(env),
    body: JSON.stringify({
      contents: [{ parts }],
      generationConfig: { temperature: 0.7, maxOutputTokens: 32768 },
    }),
    signal,
  }, { retries429: 2, retries5xx: 1, signal })

  if (!res.body) throw new GeminiError('GEMINI_STREAM_DROP', 'no body')
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''

  try {
    while (true) {
      if (signal?.aborted) throw new GeminiError('GEMINI_STREAM_DROP', 'aborted')
      const { value, done } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let idx: number
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, idx); buf = buf.slice(idx + 2)
        const text = extractText(frame)
        if (text) yield text
      }
    }
    // Flush remaining buffer after stream ends (last frame may lack trailing \n\n)
    if (buf.trim()) {
      const text = extractText(buf)
      if (text) yield text
    }
  } finally {
    try { reader.cancel() } catch { /* ignore */ }
  }
}

function extractText(frame: string): string {
  const out: string[] = []
  for (const line of frame.split('\n')) {
    if (!line.startsWith('data:')) continue
    const payload = line.slice(5).trim()
    if (!payload || payload === '[DONE]') continue
    try {
      const obj = JSON.parse(payload) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }
      for (const c of obj.candidates ?? []) {
        for (const p of c.content?.parts ?? []) {
          if (p.text) out.push(p.text)
        }
      }
    } catch { /* skip malformed frame */ }
  }
  return out.join('')
}

/**
 * TransformStream that injects an SSE keepalive comment (`: keepalive\n\n`) whenever no data
 * has flowed for intervalMs. Default 15 s is half of Cloudflare's 30 s idle stream timeout.
 */
export function keepaliveTransform(intervalMs = 15_000) {
  const enc = new TextEncoder()
  const keepalive = enc.encode(': keepalive\n\n')
  let timer: ReturnType<typeof setTimeout> | null = null
  // Needed because the scheduled timer callback fires asynchronously after flush() returns,
  // so we must guard against enqueueing into an already-closed controller.
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
    start(controller) {
      ctrlRef = controller
      schedule()
    },
    transform(chunk, controller) {
      if (timer) { clearTimeout(timer); timer = null }
      controller.enqueue(chunk)
      schedule()
    },
    flush() {
      closed = true
      if (timer) clearTimeout(timer)
    },
  })
}
