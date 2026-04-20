import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { loadLlmConfig, countPromptTokens, streamChat, keepaliveTransform, LlmError } from '../src/llm'
import type { LlmConfig } from '../src/llm'

function mockFetch(impl: (req: Request) => Promise<Response> | Response) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input as string, init)
    return impl(req)
  }))
}

// ── loadLlmConfig ─────────────────────────────────────────────────────────────

describe('loadLlmConfig', () => {
  it('reads LLM_* vars', () => {
    const cfg = loadLlmConfig({ LLM_PROVIDER: 'openai', LLM_API_KEY: 'sk-x', LLM_MODEL: 'gpt-4' })
    expect(cfg).toMatchObject({ provider: 'openai', apiKey: 'sk-x', model: 'gpt-4' })
  })

  it('falls back to default model when LLM_MODEL omitted', () => {
    const cfg = loadLlmConfig({ LLM_PROVIDER: 'anthropic', LLM_API_KEY: 'sk-x' })
    expect(cfg.model).toBe('claude-sonnet-4-5')
  })

  it('falls back to GEMINI_API_KEY for backward compat', () => {
    const cfg = loadLlmConfig({ GEMINI_API_KEY: 'gk' })
    expect(cfg).toMatchObject({ provider: 'google', apiKey: 'gk' })
  })

  it('throws LLM_AUTH when no key configured', () => {
    expect(() => loadLlmConfig({})).toThrow(LlmError)
    expect(() => loadLlmConfig({})).toThrow(expect.objectContaining({ code: 'LLM_AUTH' }))
  })

  it('throws LLM_AUTH for unknown provider', () => {
    expect(() => loadLlmConfig({ LLM_PROVIDER: 'unknown', LLM_API_KEY: 'x' }))
      .toThrow(expect.objectContaining({ code: 'LLM_AUTH' }))
  })
})

// ── countPromptTokens ─────────────────────────────────────────────────────────

describe('countPromptTokens', () => {
  const googleCfg: LlmConfig = { provider: 'google', model: 'gemini-2.5-flash', apiKey: 'fake' }

  beforeEach(() => vi.unstubAllGlobals())
  afterEach(() => vi.unstubAllGlobals())

  it('POSTs to :countTokens for google and returns token count', async () => {
    mockFetch(async req => {
      expect(req.url).toContain(':countTokens')
      expect(req.url).not.toContain('key=')
      expect(req.headers.get('x-goog-api-key')).toBe('fake')
      return new Response(JSON.stringify({ totalTokens: 42 }), { status: 200 })
    })
    expect(await countPromptTokens(googleCfg, 'hello')).toBe(42)
  })

  it('returns 0 for non-google providers without calling fetch', async () => {
    const noFetch = vi.fn()
    vi.stubGlobal('fetch', noFetch)
    const openaiCfg: LlmConfig = { provider: 'openai', model: 'gpt-4o', apiKey: 'sk' }
    expect(await countPromptTokens(openaiCfg, 'hello')).toBe(0)
    expect(noFetch).not.toHaveBeenCalled()
  })

  it('throws LLM_AUTH on 401', async () => {
    mockFetch(() => new Response('nope', { status: 401 }))
    await expect(countPromptTokens(googleCfg, 'x')).rejects.toMatchObject({ code: 'LLM_AUTH' })
  })

  it('retries once on 429 then succeeds (fast sleep)', async () => {
    let attempt = 0
    mockFetch(() => {
      attempt++
      if (attempt === 1) return new Response('rate limit', { status: 429 })
      return new Response(JSON.stringify({ totalTokens: 7 }), { status: 200 })
    })
    expect(await countPromptTokens(googleCfg, 'x', undefined, { sleepFn: async () => {} })).toBe(7)
    expect(attempt).toBe(2)
  })

  it('throws LLM_RATE_LIMIT after exhausting 429 retries', async () => {
    let attempt = 0
    mockFetch(() => { attempt++; return new Response('', { status: 429 }) })
    await expect(countPromptTokens(googleCfg, 'x', undefined, { sleepFn: async () => {} }))
      .rejects.toMatchObject({ code: 'LLM_RATE_LIMIT' })
    expect(attempt).toBe(3)
  })

  it('throws GEMINI_QUOTA immediately on 429 RESOURCE_EXHAUSTED (no retry)', async () => {
    let attempt = 0
    mockFetch(() => {
      attempt++
      return new Response('{"error":{"code":429,"status":"RESOURCE_EXHAUSTED"}}', { status: 429 })
    })
    await expect(countPromptTokens(googleCfg, 'x', undefined, { sleepFn: async () => {} }))
      .rejects.toMatchObject({ code: 'GEMINI_QUOTA' })
    expect(attempt).toBe(1)  // no retry on quota exhaustion
  })
})

// ── Gemini-specific error classification ─────────────────────────────────────

describe('streamChat (google) — Gemini error codes', () => {
  const cfg: LlmConfig = { provider: 'google', model: 'gemini-2.5-flash', apiKey: 'fake' }

  beforeEach(() => vi.unstubAllGlobals())
  afterEach(() => vi.unstubAllGlobals())

  it('throws GEMINI_SAFETY on 400 with SAFETY in body', async () => {
    mockFetch(() => new Response(
      '{"error":{"code":400,"status":"INVALID_ARGUMENT","message":"The model response was blocked due to SAFETY"}}',
      { status: 400 }
    ))
    const gen = streamChat(cfg, 'p')
    await expect(gen.next()).rejects.toMatchObject({ code: 'GEMINI_SAFETY' })
  })

  it('throws GEMINI_VIDEO_UNSUPPORTED on 400 without SAFETY (e.g. private video)', async () => {
    mockFetch(() => new Response(
      '{"error":{"code":400,"status":"INVALID_ARGUMENT","message":"File does not exist"}}',
      { status: 400 }
    ))
    const gen = streamChat(cfg, 'p')
    await expect(gen.next()).rejects.toMatchObject({ code: 'GEMINI_VIDEO_UNSUPPORTED' })
  })

  it('does NOT classify 400 as Gemini-specific for openai provider', async () => {
    const openaiCfg: LlmConfig = { provider: 'openai', model: 'gpt-4o', apiKey: 'sk' }
    mockFetch(() => new Response('{"error":"bad request"}', { status: 400 }))
    const gen = streamChat(openaiCfg, 'p')
    await expect(gen.next()).rejects.toMatchObject({ code: 'LLM_TIMEOUT' })
  })
})

// ── streamChat: google ────────────────────────────────────────────────────────

describe('streamChat (google)', () => {
  const cfg: LlmConfig = { provider: 'google', model: 'gemini-2.5-flash', apiKey: 'fake' }

  beforeEach(() => vi.unstubAllGlobals())
  afterEach(() => vi.unstubAllGlobals())

  it('yields concatenated text parts from SSE body', async () => {
    const sse = [
      'data: {"candidates":[{"content":{"parts":[{"text":"{\\"type\\":"}]}}]}',
      '',
      'data: {"candidates":[{"content":{"parts":[{"text":"\\"h2\\",\\"text\\":\\"A\\"}\\n"}]}}]}',
      '',
    ].join('\n')
    mockFetch(() => new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } }))
    const chunks: string[] = []
    for await (const chunk of streamChat(cfg, 'prompt')) chunks.push(chunk)
    expect(chunks.join('')).toBe('{"type":"h2","text":"A"}\n')
  })

  it('handles SSE frames split across reader.read() boundaries', async () => {
    const enc = new TextEncoder()
    const body = new ReadableStream<Uint8Array>({
      start(ctrl) {
        ctrl.enqueue(enc.encode('data: {"candidates":[{"content":{"parts":[{"text":"'))
        ctrl.enqueue(enc.encode('hello"}]}}]}\n\n'))
        ctrl.close()
      },
    })
    mockFetch(() => new Response(body, { status: 200 }))
    const chunks: string[] = []
    for await (const c of streamChat(cfg, 'p')) chunks.push(c)
    expect(chunks.join('')).toBe('hello')
  })

  it('refuses to start when signal already aborted', async () => {
    const ctrl = new AbortController()
    ctrl.abort()
    mockFetch(() => new Response('', { status: 200 }))
    const gen = streamChat(cfg, 'p', ctrl.signal)
    await expect(gen.next()).rejects.toMatchObject({ code: 'LLM_STREAM_DROP' })
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })
})

// ── streamChat: openai ────────────────────────────────────────────────────────

describe('streamChat (openai)', () => {
  const cfg: LlmConfig = { provider: 'openai', model: 'gpt-4o', apiKey: 'sk-fake' }

  beforeEach(() => vi.unstubAllGlobals())
  afterEach(() => vi.unstubAllGlobals())

  it('POSTs to /chat/completions with Bearer auth and yields text', async () => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"hello "}}]}',
      '',
      'data: {"choices":[{"delta":{"content":"world"}}]}',
      '',
      'data: [DONE]',
      '',
    ].join('\n')
    mockFetch(async req => {
      expect(req.url).toContain('/chat/completions')
      expect(req.headers.get('Authorization')).toBe('Bearer sk-fake')
      return new Response(sse, { status: 200 })
    })
    const chunks: string[] = []
    for await (const c of streamChat(cfg, 'p')) chunks.push(c)
    expect(chunks.join('')).toBe('hello world')
  })
})

// ── streamChat: openrouter ───────────────────────────────────────────────────

describe('streamChat (openrouter)', () => {
  const cfg: LlmConfig = { provider: 'openrouter', model: 'google/gemini-2.5-flash', apiKey: 'or-fake' }

  beforeEach(() => vi.unstubAllGlobals())
  afterEach(() => vi.unstubAllGlobals())

  it('includes HTTP-Referer and X-Title headers', async () => {
    mockFetch(async req => {
      expect(req.headers.get('HTTP-Referer')).toBe('https://ytb.studio')
      expect(req.headers.get('X-Title')).toBe('ytb-studio')
      return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n', { status: 200 })
    })
    const chunks: string[] = []
    for await (const c of streamChat(cfg, 'p')) chunks.push(c)
    expect(chunks.join('')).toBe('ok')
  })
})

// ── streamChat: anthropic ─────────────────────────────────────────────────────

describe('streamChat (anthropic)', () => {
  const cfg: LlmConfig = { provider: 'anthropic', model: 'claude-sonnet-4-5', apiKey: 'ant-fake' }

  beforeEach(() => vi.unstubAllGlobals())
  afterEach(() => vi.unstubAllGlobals())

  it('POSTs to /messages with x-api-key and yields text_delta content', async () => {
    const sse = [
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi "}}',
      '',
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"there"}}',
      '',
      'data: {"type":"message_stop"}',
      '',
    ].join('\n')
    mockFetch(async req => {
      expect(req.url).toContain('/messages')
      expect(req.headers.get('x-api-key')).toBe('ant-fake')
      expect(req.headers.get('anthropic-version')).toBe('2023-06-01')
      return new Response(sse, { status: 200 })
    })
    const chunks: string[] = []
    for await (const c of streamChat(cfg, 'p')) chunks.push(c)
    expect(chunks.join('')).toBe('hi there')
  })

  it('ignores non-text_delta events', async () => {
    const sse = [
      'data: {"type":"message_start","message":{}}',
      '',
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}',
      '',
    ].join('\n')
    mockFetch(() => new Response(sse, { status: 200 }))
    const chunks: string[] = []
    for await (const c of streamChat(cfg, 'p')) chunks.push(c)
    expect(chunks.join('')).toBe('ok')
  })
})

// ── keepaliveTransform ────────────────────────────────────────────────────────

describe('keepaliveTransform', () => {
  it('inserts keepalive comment after idle (real timers)', async () => {
    const ts = keepaliveTransform(40)
    const writer = ts.writable.getWriter()
    const reader = ts.readable.getReader()
    const dec = new TextDecoder()
    const chunks: string[] = []

    const drain = (async () => {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        chunks.push(dec.decode(value))
      }
    })()

    await writer.write(new TextEncoder().encode('data: x\n\n'))
    await new Promise(r => setTimeout(r, 120))
    await writer.close()
    await drain

    const all = chunks.join('')
    expect(all).toContain('data: x\n\n')
    expect(all).toMatch(/: keepalive\n\n/)
    expect((all.match(/: keepalive\n\n/g) ?? []).length).toBeGreaterThanOrEqual(1)
  })
})
