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
  it('reads GEMINI_API_KEY', () => {
    const cfg = loadLlmConfig({ GEMINI_API_KEY: 'gk', GEMINI_MODEL: 'gemini-2.5-pro' })
    expect(cfg).toMatchObject({ model: 'gemini-2.5-pro', apiKey: 'gk' })
  })

  it('falls back to default model when GEMINI_MODEL omitted', () => {
    const cfg = loadLlmConfig({ GEMINI_API_KEY: 'gk' })
    expect(cfg.model).toBe('gemini-2.5-flash')
  })

  it('throws GEMINI_AUTH when no key configured', () => {
    expect(() => loadLlmConfig({})).toThrow(LlmError)
    expect(() => loadLlmConfig({})).toThrow(expect.objectContaining({ code: 'GEMINI_AUTH' }))
  })
})

// ── countPromptTokens ─────────────────────────────────────────────────────────

describe('countPromptTokens', () => {
  const cfg: LlmConfig = { model: 'gemini-2.5-flash', apiKey: 'fake' }

  beforeEach(() => vi.unstubAllGlobals())
  afterEach(() => vi.unstubAllGlobals())

  it('POSTs to :countTokens and returns token count', async () => {
    mockFetch(async req => {
      expect(req.url).toContain(':countTokens')
      expect(req.headers.get('x-goog-api-key')).toBe('fake')
      return new Response(JSON.stringify({ totalTokens: 42 }), { status: 200 })
    })
    expect(await countPromptTokens(cfg, 'hello')).toBe(42)
  })

  it('throws GEMINI_AUTH on 401', async () => {
    mockFetch(() => new Response('nope', { status: 401 }))
    await expect(countPromptTokens(cfg, 'x')).rejects.toMatchObject({ code: 'GEMINI_AUTH' })
  })

  it('retries once on 429 then succeeds (fast sleep)', async () => {
    let attempt = 0
    mockFetch(() => {
      attempt++
      if (attempt === 1) return new Response('rate limit', { status: 429 })
      return new Response(JSON.stringify({ totalTokens: 7 }), { status: 200 })
    })
    expect(await countPromptTokens(cfg, 'x', undefined, { sleepFn: async () => {} })).toBe(7)
    expect(attempt).toBe(2)
  })

  it('throws GEMINI_RATE_LIMIT after exhausting 429 retries', async () => {
    let attempt = 0
    mockFetch(() => { attempt++; return new Response('', { status: 429 }) })
    await expect(countPromptTokens(cfg, 'x', undefined, { sleepFn: async () => {} }))
      .rejects.toMatchObject({ code: 'GEMINI_RATE_LIMIT' })
    expect(attempt).toBe(3)
  })

  it('retries 503 up to 3 times then throws GEMINI_OVERLOADED', async () => {
    let attempt = 0
    mockFetch(() => {
      attempt++
      return new Response('This model is currently experiencing high demand.', { status: 503 })
    })
    await expect(countPromptTokens(cfg, 'x', undefined, { sleepFn: async () => {} }))
      .rejects.toMatchObject({ code: 'GEMINI_OVERLOADED' })
    expect(attempt).toBe(4) // 1 initial + 3 retries
  })

  it('succeeds if 503 clears before retries exhausted', async () => {
    let attempt = 0
    mockFetch(() => {
      attempt++
      if (attempt <= 2) return new Response('overloaded', { status: 503 })
      return new Response(JSON.stringify({ totalTokens: 5 }), { status: 200 })
    })
    expect(await countPromptTokens(cfg, 'x', undefined, { sleepFn: async () => {} })).toBe(5)
    expect(attempt).toBe(3)
  })

  it('throws GEMINI_QUOTA immediately on 429 RESOURCE_EXHAUSTED (no retry)', async () => {
    let attempt = 0
    mockFetch(() => {
      attempt++
      return new Response('{"error":{"code":429,"status":"RESOURCE_EXHAUSTED"}}', { status: 429 })
    })
    await expect(countPromptTokens(cfg, 'x', undefined, { sleepFn: async () => {} }))
      .rejects.toMatchObject({ code: 'GEMINI_QUOTA' })
    expect(attempt).toBe(1)
  })
})

// ── streamChat: Gemini error codes ───────────────────────────────────────────

describe('streamChat — Gemini error codes', () => {
  const cfg: LlmConfig = { model: 'gemini-2.5-flash', apiKey: 'fake' }

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

  it('throws GEMINI_AUTH on 400 with "API key not valid"', async () => {
    mockFetch(() => new Response(
      '{"error":{"code":400,"status":"INVALID_ARGUMENT","message":"API key not valid. Please pass a valid API key."}}',
      { status: 400 }
    ))
    const gen = streamChat(cfg, 'p')
    await expect(gen.next()).rejects.toMatchObject({ code: 'GEMINI_AUTH' })
  })

  it('throws GEMINI_AUTH on 400 with API_KEY_INVALID status', async () => {
    mockFetch(() => new Response(
      '{"error":{"code":400,"status":"API_KEY_INVALID","message":"API key not valid."}}',
      { status: 400 }
    ))
    const gen = streamChat(cfg, 'p')
    await expect(gen.next()).rejects.toMatchObject({ code: 'GEMINI_AUTH' })
  })

  it('throws GEMINI_VIDEO_UNSUPPORTED on 400 for fileData video errors', async () => {
    mockFetch(() => new Response(
      '{"error":{"code":400,"status":"INVALID_ARGUMENT","message":"INVALID_ARGUMENT: fileData: video cannot be processed"}}',
      { status: 400 }
    ))
    const gen = streamChat(cfg, 'p')
    await expect(gen.next()).rejects.toMatchObject({ code: 'GEMINI_VIDEO_UNSUPPORTED' })
  })

  it('falls through to GEMINI_TIMEOUT for generic 400 (not fileData/safety/auth)', async () => {
    mockFetch(() => new Response(
      '{"error":{"code":400,"status":"INVALID_ARGUMENT","message":"video ID is invalid"}}',
      { status: 400 }
    ))
    const gen = streamChat(cfg, 'p')
    await expect(gen.next()).rejects.toMatchObject({ code: 'GEMINI_TIMEOUT' })
  })
})

// ── streamChat: SSE streaming ─────────────────────────────────────────────────

describe('streamChat', () => {
  const cfg: LlmConfig = { model: 'gemini-2.5-flash', apiKey: 'fake' }

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

  it('throws GEMINI_STALL when stream goes idle past zombie timeout', async () => {
    const enc = new TextEncoder()
    const body = new ReadableStream<Uint8Array>({
      start(ctrl) {
        // Send one frame then go silent — simulates Gemini stalling mid-generation
        ctrl.enqueue(enc.encode('data: {"candidates":[{"content":{"parts":[{"text":"hello"}]}}]}\n\n'))
      },
    })
    mockFetch(() => new Response(body, { status: 200 }))

    // _heartbeatIntervalMs=20 _idleTimeoutMs=50 → fires heartbeat at 20ms/40ms then stalls at 50ms
    const gen = streamChat(cfg, 'p', undefined, {
      _idleTimeoutMs: 50,
      _heartbeatIntervalMs: 20,
    })
    const first = await gen.next()
    expect(first.value).toBe('hello')
    // Second read: stream has no more data → heartbeats fire then zombie watchdog throws
    await expect(gen.next()).rejects.toMatchObject({ code: 'GEMINI_STALL' })
  })

  it('fires onHeartbeat at each interval while stream is idle', async () => {
    const enc = new TextEncoder()
    const body = new ReadableStream<Uint8Array>({
      start(ctrl) {
        ctrl.enqueue(enc.encode('data: {"candidates":[{"content":{"parts":[{"text":"hi"}]}}]}\n\n'))
      },
    })
    mockFetch(() => new Response(body, { status: 200 }))

    const beats: number[] = []
    const gen = streamChat(cfg, 'p', undefined, {
      _idleTimeoutMs: 100,
      _heartbeatIntervalMs: 20,
      onHeartbeat: (s) => beats.push(s),
    })
    await gen.next() // consumes 'hi'
    // Let heartbeats accumulate then catch the GEMINI_STALL
    await expect(gen.next()).rejects.toMatchObject({ code: 'GEMINI_STALL' })
    // Should have fired at 20ms, 40ms, 60ms, 80ms (4 beats before 100ms kill)
    expect(beats.length).toBeGreaterThanOrEqual(2)
    expect(beats[0]).toBeCloseTo(20 / 1000, 1)
  })

  it('does not fire onHeartbeat when tokens arrive before interval', async () => {
    const enc = new TextEncoder()
    const body = new ReadableStream<Uint8Array>({
      start(ctrl) {
        ctrl.enqueue(enc.encode('data: {"candidates":[{"content":{"parts":[{"text":"a"}]}}]}\n\n'))
        ctrl.enqueue(enc.encode('data: {"candidates":[{"content":{"parts":[{"text":"b"}]}}]}\n\n'))
        ctrl.close()
      },
    })
    mockFetch(() => new Response(body, { status: 200 }))

    const beats: number[] = []
    const chunks: string[] = []
    for await (const c of streamChat(cfg, 'p', undefined, {
      _heartbeatIntervalMs: 200,
      onHeartbeat: (s) => beats.push(s),
    })) chunks.push(c)

    expect(chunks).toEqual(['a', 'b'])
    expect(beats).toHaveLength(0)
  })

  it('refuses to start when signal already aborted', async () => {
    const ctrl = new AbortController()
    ctrl.abort()
    mockFetch(() => new Response('', { status: 200 }))
    const gen = streamChat(cfg, 'p', ctrl.signal)
    await expect(gen.next()).rejects.toMatchObject({ code: 'GEMINI_STREAM_DROP' })
    expect(globalThis.fetch).not.toHaveBeenCalled()
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
