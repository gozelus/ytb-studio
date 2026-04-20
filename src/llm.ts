/**
 * [WHAT] Provider-agnostic LLM client: Google, OpenAI, OpenRouter, and Anthropic.
 * [WHY]  Deployers configure their preferred provider via env vars; the rest of the
 *        worker never sees provider-specific auth headers or request shapes.
 * [INVARIANT] streamChat yields raw text increments; the ndjson parser above is unchanged.
 *             countPromptTokens returns 0 for providers without a token-counting endpoint.
 *             API key is always in a request header (never in the URL) to prevent leakage.
 */

import type { ErrorCode } from './types'

export class LlmError extends Error {
  constructor(public code: ErrorCode, message?: string) { super(message ?? code) }
}

export interface LlmConfig {
  provider: 'google' | 'openai' | 'openrouter' | 'anthropic'
  model: string
  apiKey: string
  baseUrl?: string
}

interface Env {
  LLM_PROVIDER?: string
  LLM_MODEL?: string
  LLM_API_KEY?: string
  LLM_BASE_URL?: string
  GEMINI_API_KEY?: string
  GEMINI_MODEL?: string
}

const VALID_PROVIDERS = new Set(['google', 'openai', 'openrouter', 'anthropic'])

const DEFAULT_MODELS: Record<LlmConfig['provider'], string> = {
  google:     'gemini-2.5-flash',
  openai:     'gpt-4o',
  openrouter: 'google/gemini-2.5-flash',
  anthropic:  'claude-sonnet-4-5',
}

/**
 * Reads LLM config from env. LLM_* vars take precedence;
 * GEMINI_API_KEY / GEMINI_MODEL are accepted for backward compatibility.
 */
export function loadLlmConfig(env: Env): LlmConfig {
  if (env.LLM_PROVIDER && env.LLM_API_KEY) {
    if (!VALID_PROVIDERS.has(env.LLM_PROVIDER)) {
      throw new LlmError('LLM_AUTH', `Unknown LLM_PROVIDER: ${env.LLM_PROVIDER}`)
    }
    const provider = env.LLM_PROVIDER as LlmConfig['provider']
    return {
      provider,
      model: env.LLM_MODEL ?? DEFAULT_MODELS[provider],
      apiKey: env.LLM_API_KEY,
      baseUrl: env.LLM_BASE_URL,
    }
  }
  // Backward compat: GEMINI_* → google provider
  if (env.GEMINI_API_KEY) {
    return {
      provider: 'google',
      model: env.GEMINI_MODEL ?? DEFAULT_MODELS.google,
      apiKey: env.GEMINI_API_KEY,
    }
  }
  throw new LlmError('LLM_AUTH', 'No LLM API key configured (set LLM_API_KEY or GEMINI_API_KEY)')
}

/**
 * Token count for the given text. Only meaningful for google (exact via :countTokens);
 * all other providers return 0 (used as a UI hint, not a hard limit).
 */
export async function countPromptTokens(
  cfg: LlmConfig,
  text: string,
  signal?: AbortSignal,
  opts: { sleepFn?: (ms: number) => Promise<void> } = {},
): Promise<number> {
  if (cfg.provider !== 'google') return 0
  const base = cfg.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta'
  const res = await retryingFetch(`${base}/models/${cfg.model}:countTokens`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': cfg.apiKey },
    body: JSON.stringify({ contents: [{ parts: [{ text }] }] }),
    signal,
  }, { sleepFn: opts.sleepFn, signal, provider: 'google' })
  const data = await res.json() as { totalTokens?: number }
  return data.totalTokens ?? 0
}

/**
 * Streams the LLM response as raw text increments.
 * Dispatches to the appropriate provider adapter based on cfg.provider.
 */
export async function* streamChat(
  cfg: LlmConfig,
  prompt: string,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  // Check before the fetch so a pre-cancelled signal never starts a billable request.
  if (signal?.aborted) throw new LlmError('LLM_STREAM_DROP', 'aborted before start')
  switch (cfg.provider) {
    case 'google':    yield* streamGoogle(cfg, prompt, signal); break
    case 'openai':
    case 'openrouter': yield* streamOpenAI(cfg, prompt, signal); break
    case 'anthropic': yield* streamAnthropic(cfg, prompt, signal); break
  }
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
    provider?: LlmConfig['provider']
  } = {},
): Promise<Response> {
  const { retries429 = 2, retries5xx = 1, sleepFn = sleep, signal, provider } = opts
  let attempt429 = 0
  let attempt5xx = 0
  let delay = 1000
  while (true) {
    const res = await fetch(url, init)
    if (res.ok) return res
    if (res.status === 401 || res.status === 403) throw new LlmError('LLM_AUTH')
    if (res.status === 429) {
      // Read body once to distinguish quota exhaustion from transient rate-limiting.
      // RESOURCE_EXHAUSTED = daily quota gone; no point retrying.
      const body429 = await res.text().catch(() => '')
      if (body429.includes('RESOURCE_EXHAUSTED')) {
        const code = provider === 'google' ? 'GEMINI_QUOTA' : 'LLM_QUOTA'
        throw new LlmError(code, `quota exhausted: ${body429.slice(0, 200)}`)
      }
      if (attempt429 < retries429) {
        await sleepFn(delay)
        if (signal?.aborted) throw new LlmError('LLM_STREAM_DROP', 'aborted during retry')
        // 1 s → 3 s: two retries stay well under CF Workers' 30 s CPU limit.
        delay *= 3; attempt429++; continue
      }
      throw new LlmError('LLM_RATE_LIMIT')
    }
    if (res.status >= 500 && attempt5xx < retries5xx) {
      await sleepFn(1000)
      if (signal?.aborted) throw new LlmError('LLM_STREAM_DROP', 'aborted during retry')
      attempt5xx++; continue
    }
    const body = await res.text().catch(() => '')
    // Google-specific 400 classification: safety filter vs. unsupported video format.
    if (provider === 'google' && res.status === 400) {
      if (body.includes('SAFETY')) throw new LlmError('GEMINI_SAFETY', body.slice(0, 200))
      if (body.includes('API key not valid') || body.includes('API_KEY_INVALID'))
        throw new LlmError('LLM_AUTH', body.slice(0, 200))
      throw new LlmError('GEMINI_VIDEO_UNSUPPORTED', `status 400: ${body.slice(0, 200)}`)
    }
    throw new LlmError('LLM_TIMEOUT', `status ${res.status}: ${body.slice(0, 300)}`)
  }
}

/** Shared SSE stream consumer. Buffers reader output, splits on \n\n, delegates text extraction. */
async function* consumeSSE(
  res: Response,
  extractFn: (frame: string) => string,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  if (!res.body) throw new LlmError('LLM_STREAM_DROP', 'no body')
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  try {
    while (true) {
      if (signal?.aborted) throw new LlmError('LLM_STREAM_DROP', 'aborted')
      const { value, done } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let idx: number
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, idx); buf = buf.slice(idx + 2)
        const text = extractFn(frame)
        if (text) yield text
      }
    }
    // Flush remaining buffer — last frame may lack trailing \n\n.
    if (buf.trim()) { const text = extractFn(buf); if (text) yield text }
  } finally {
    try { reader.cancel() } catch { /* ignore */ }
  }
}

// ── Google ───────────────────────────────────────────────────────────────────

async function* streamGoogle(cfg: LlmConfig, prompt: string, signal?: AbortSignal) {
  const base = cfg.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta'
  const res = await retryingFetch(`${base}/models/${cfg.model}:streamGenerateContent?alt=sse`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': cfg.apiKey },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.7, maxOutputTokens: 32768 },
    }),
    signal,
  }, { retries429: 2, retries5xx: 1, signal, provider: 'google' })
  yield* consumeSSE(res, extractGoogleText, signal)
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

// ── OpenAI / OpenRouter ──────────────────────────────────────────────────────

async function* streamOpenAI(cfg: LlmConfig, prompt: string, signal?: AbortSignal) {
  const base = cfg.baseUrl ?? (cfg.provider === 'openrouter'
    ? 'https://openrouter.ai/api/v1'
    : 'https://api.openai.com/v1')
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'Authorization': `Bearer ${cfg.apiKey}`,
  }
  if (cfg.provider === 'openrouter') {
    // OpenRouter recommends these for rate-limit attribution and dashboard display.
    headers['HTTP-Referer'] = 'https://ytb.studio'
    headers['X-Title'] = 'ytb-studio'
  }
  const res = await retryingFetch(`${base}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: cfg.model,
      messages: [{ role: 'user', content: prompt }],
      stream: true,
      max_tokens: 32768,
      temperature: 0.7,
    }),
    signal,
  }, { retries429: 2, retries5xx: 1, signal })
  yield* consumeSSE(res, extractOpenAIText, signal)
}

function extractOpenAIText(frame: string): string {
  const out: string[] = []
  for (const line of frame.split('\n')) {
    if (!line.startsWith('data:')) continue
    const payload = line.slice(5).trim()
    if (!payload || payload === '[DONE]') continue
    try {
      const obj = JSON.parse(payload) as { choices?: Array<{ delta?: { content?: string } }> }
      for (const c of obj.choices ?? [])
        if (c.delta?.content) out.push(c.delta.content)
    } catch { /* skip malformed frame */ }
  }
  return out.join('')
}

// ── Anthropic ────────────────────────────────────────────────────────────────

async function* streamAnthropic(cfg: LlmConfig, prompt: string, signal?: AbortSignal) {
  const base = cfg.baseUrl ?? 'https://api.anthropic.com/v1'
  const res = await retryingFetch(`${base}/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': cfg.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: cfg.model,
      max_tokens: 32768,
      temperature: 0.7,
      stream: true,
      messages: [{ role: 'user', content: prompt }],
    }),
    signal,
  }, { retries429: 2, retries5xx: 1, signal })
  yield* consumeSSE(res, extractAnthropicText, signal)
}

function extractAnthropicText(frame: string): string {
  const out: string[] = []
  for (const line of frame.split('\n')) {
    if (!line.startsWith('data:')) continue
    const payload = line.slice(5).trim()
    if (!payload) continue
    try {
      const obj = JSON.parse(payload) as { type?: string; delta?: { type?: string; text?: string } }
      if (obj.type === 'content_block_delta' && obj.delta?.type === 'text_delta' && obj.delta.text)
        out.push(obj.delta.text)
    } catch { /* skip malformed frame */ }
  }
  return out.join('')
}
