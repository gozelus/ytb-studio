import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { loadLlmConfig, streamChat, keepaliveTransform, LlmError } from '../src/llm'
import type { LlmConfig } from '../src/llm'

function mockFetch(impl: (req: Request) => Promise<Response> | Response) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input as string, init)
    return impl(req)
  }))
}

// ── loadLlmConfig ─────────────────────────────────────────────────────────────

describe('loadLlmConfig', () => {
  it('reads GEMINI_API_KEY with single GEMINI_MODEL', () => {
    const cfg = loadLlmConfig({ GEMINI_API_KEY: 'gk', GEMINI_MODEL: 'gemini-2.5-pro' })
    expect(cfg).toMatchObject({ models: ['gemini-2.5-pro'], apiKey: 'gk' })
  })

  it('reads GEMINI_MODELS as comma-separated list (takes precedence over GEMINI_MODEL)', () => {
    const cfg = loadLlmConfig({ GEMINI_API_KEY: 'gk', GEMINI_MODELS: 'gemini-2.5-flash,gemini-2.5-pro' })
    expect(cfg.models).toEqual(['gemini-2.5-flash', 'gemini-2.5-pro'])
  })

  it('falls back to default 3-model list when neither GEMINI_MODELS nor GEMINI_MODEL set', () => {
    const cfg = loadLlmConfig({ GEMINI_API_KEY: 'gk' })
    expect(cfg.models[0]).toBe('gemini-2.5-flash')
    expect(cfg.models.length).toBeGreaterThan(1)
  })

  it('throws GEMINI_AUTH when no key configured', () => {
    expect(() => loadLlmConfig({})).toThrow(LlmError)
    expect(() => loadLlmConfig({})).toThrow(expect.objectContaining({ code: 'GEMINI_AUTH' }))
  })
})

// ── streamChat: Gemini error codes ───────────────────────────────────────────

describe('streamChat — Gemini error codes', () => {
  const cfg: LlmConfig = { models: ['gemini-2.5-flash'], apiKey: 'fake' }

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

  it('throws GEMINI_OVERLOADED when SSE stream body contains 503 UNAVAILABLE error (reqId a3708c repro)', async () => {
    // HTTP 200 but stream body carries an error event — retryingFetch 503 branch never fires
    const sse = 'data: {"error":{"code":503,"status":"UNAVAILABLE","message":"The model is overloaded. Please try again later."}}\n\n'
    mockFetch(() => new Response(sse, { status: 200 }))
    const gen = streamChat(cfg, 'p')
    await expect(gen.next()).rejects.toMatchObject({ code: 'GEMINI_OVERLOADED' })
  })

  it('throws GEMINI_OVERLOADED when SSE stream body contains "high demand" message', async () => {
    const sse = 'data: {"error":{"code":503,"status":"UNAVAILABLE","message":"This model is currently experiencing high demand."}}\n\n'
    mockFetch(() => new Response(sse, { status: 200 }))
    const gen = streamChat(cfg, 'p')
    await expect(gen.next()).rejects.toMatchObject({ code: 'GEMINI_OVERLOADED' })
  })

  it('throws GEMINI_SAFETY when finishReason=SAFETY (silent data loss fix)', async () => {
    const sse = 'data: {"candidates":[{"finishReason":"SAFETY","content":{"parts":[]}}]}\n\n'
    mockFetch(() => new Response(sse, { status: 200 }))
    const gen = streamChat(cfg, 'p')
    await expect(gen.next()).rejects.toMatchObject({ code: 'GEMINI_SAFETY' })
  })

  it('throws GEMINI_TIMEOUT when finishReason=MAX_TOKENS (output truncation)', async () => {
    const sse = 'data: {"candidates":[{"finishReason":"MAX_TOKENS","content":{"parts":[{"text":"...end"}]}}]}\n\n'
    mockFetch(() => new Response(sse, { status: 200 }))
    const gen = streamChat(cfg, 'p')
    await expect(gen.next()).rejects.toMatchObject({ code: 'GEMINI_TIMEOUT' })
  })

  it('throws GEMINI_SAFETY when promptFeedback.blockReason set (prompt fully blocked)', async () => {
    const sse = 'data: {"promptFeedback":{"blockReason":"SAFETY"},"candidates":[]}\n\n'
    mockFetch(() => new Response(sse, { status: 200 }))
    const gen = streamChat(cfg, 'p')
    await expect(gen.next()).rejects.toMatchObject({ code: 'GEMINI_SAFETY' })
  })
})

// ── streamChat: SSE streaming ─────────────────────────────────────────────────

describe('streamChat', () => {
  const cfg: LlmConfig = { models: ['gemini-2.5-flash'], apiKey: 'fake' }

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

  it('throws GEMINI_STALL when SSE frames arrive but contain no text', async () => {
    const enc = new TextEncoder()
    let timer: ReturnType<typeof setInterval> | null = null
    const body = new ReadableStream<Uint8Array>({
      start(ctrl) {
        timer = setInterval(() => {
          ctrl.enqueue(enc.encode('data: {"candidates":[{"content":{"parts":[]}}]}\n\n'))
        }, 10)
      },
      cancel() {
        if (timer) clearInterval(timer)
      },
    })
    mockFetch(() => new Response(body, { status: 200 }))

    const gen = streamChat(cfg, 'p', undefined, {
      _idleTimeoutMs: 200,
      _heartbeatIntervalMs: 20,
      _textIdleTimeoutMs: 50,
    })
    await expect(gen.next()).rejects.toMatchObject({ code: 'GEMINI_STALL' })
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

  it('sends fileData part when called with Part[] containing fileUri', async () => {
    let capturedBody: unknown
    mockFetch(async req => {
      capturedBody = await req.json()
      return new Response(
        'data: {"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}\n\n',
        { status: 200 },
      )
    })
    const chunks: string[] = []
    for await (const c of streamChat(cfg, [
      { fileData: { fileUri: 'https://youtu.be/abc123' } },
      { text: 'describe this video' },
    ])) chunks.push(c)

    expect(chunks.join('')).toBe('ok')
    const parts = (capturedBody as { contents: Array<{ parts: unknown[] }> }).contents[0]!.parts
    expect(parts[0]).toMatchObject({ fileData: { fileUri: 'https://youtu.be/abc123' } })
    expect(parts[1]).toMatchObject({ text: 'describe this video' })
  })

  it('sends text-only part when called with a plain string', async () => {
    let capturedBody: unknown
    mockFetch(async req => {
      capturedBody = await req.json()
      return new Response(
        'data: {"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}\n\n',
        { status: 200 },
      )
    })
    for await (const _ of streamChat(cfg, 'hello gemini')) { /* drain */ }
    const parts = (capturedBody as { contents: Array<{ parts: unknown[] }> }).contents[0]!.parts
    expect(parts).toHaveLength(1)
    expect(parts[0]).toMatchObject({ text: 'hello gemini' })
    expect(parts[0]).not.toHaveProperty('fileData')
  })
})

// ── streamChat: model fallback ────────────────────────────────────────────────

describe('streamChat — model fallback', () => {
  beforeEach(() => vi.unstubAllGlobals())
  afterEach(() => vi.unstubAllGlobals())

  it('falls back to second model when first throws GEMINI_OVERLOADED', async () => {
    const models: string[] = []
    // Use SSE-body error (HTTP 200) to avoid retryingFetch's real sleep delays
    mockFetch(req => {
      const model = new URL(req.url).pathname.split('/models/')[1]?.split(':')[0] ?? ''
      models.push(model)
      if (model === 'gemini-2.5-flash')
        return new Response(
          'data: {"error":{"code":503,"status":"UNAVAILABLE","message":"overloaded"}}\n\n',
          { status: 200 },
        )
      return new Response(
        'data: {"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}\n\n',
        { status: 200 },
      )
    })
    const cfg: LlmConfig = { models: ['gemini-2.5-flash', 'gemini-2.5-flash-lite'], apiKey: 'fake' }
    const chunks: string[] = []
    for await (const c of streamChat(cfg, 'p')) chunks.push(c)
    expect(chunks.join('')).toBe('ok')
    expect(models[0]).toBe('gemini-2.5-flash')
    expect(models[1]).toBe('gemini-2.5-flash-lite')
  })

  it('does NOT fall back when first model throws GEMINI_AUTH (non-retryable)', async () => {
    let attempts = 0
    mockFetch(() => {
      attempts++
      return new Response(
        '{"error":{"code":400,"status":"API_KEY_INVALID","message":"API key not valid."}}',
        { status: 400 },
      )
    })
    const cfg: LlmConfig = { models: ['gemini-2.5-flash', 'gemini-2.5-flash-lite'], apiKey: 'fake' }
    const gen = streamChat(cfg, 'p')
    await expect(gen.next()).rejects.toMatchObject({ code: 'GEMINI_AUTH' })
    expect(attempts).toBe(1)
  })

  it('throws last model error when all models are exhausted', async () => {
    let attempt = 0
    // Use SSE-body error (HTTP 200) to avoid retryingFetch's real sleep delays
    mockFetch(() => {
      attempt++
      return new Response(
        'data: {"error":{"code":503,"status":"UNAVAILABLE","message":"overloaded"}}\n\n',
        { status: 200 },
      )
    })
    const cfg: LlmConfig = { models: ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-pro'], apiKey: 'fake' }
    const gen = streamChat(cfg, 'p')
    await expect(gen.next()).rejects.toMatchObject({ code: 'GEMINI_OVERLOADED' })
    expect(attempt).toBe(3) // one fetch per model, each fails immediately
  })

  it('falls back to second model when first throws GEMINI_TIMEOUT (reqId c01ea9 repro)', async () => {
    const models: string[] = []
    // Use SSE-body error (HTTP 200) to avoid retryingFetch's 5xx retry delays
    mockFetch(req => {
      const model = new URL(req.url).pathname.split('/models/')[1]?.split(':')[0] ?? ''
      models.push(model)
      if (model === 'gemini-2.5-flash')
        return new Response(
          'data: {"error":{"code":500,"message":"internal server error"}}\n\n',
          { status: 200 },
        )
      return new Response(
        'data: {"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}\n\n',
        { status: 200 },
      )
    })
    const cfg: LlmConfig = { models: ['gemini-2.5-flash', 'gemini-2.5-flash-lite'], apiKey: 'fake' }
    const chunks: string[] = []
    for await (const c of streamChat(cfg, 'p')) chunks.push(c)
    expect(chunks.join('')).toBe('ok')
    expect(models[0]).toBe('gemini-2.5-flash')
    expect(models[1]).toBe('gemini-2.5-flash-lite')
  })

  it('falls back when first model throws GEMINI_STREAM_DROP before first token', async () => {
    const models: string[] = []
    mockFetch(req => {
      const model = new URL(req.url).pathname.split('/models/')[1]?.split(':')[0] ?? ''
      models.push(model)
      if (model === 'gemini-2.5-flash') {
        // HTTP 200 but no body → reader.read() returns done immediately → GEMINI_STREAM_DROP
        return new Response(null, { status: 200 })
      }
      return new Response(
        'data: {"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}\n\n',
        { status: 200 },
      )
    })
    const cfg: LlmConfig = { models: ['gemini-2.5-flash', 'gemini-2.5-flash-lite'], apiKey: 'fake' }
    const chunks: string[] = []
    for await (const c of streamChat(cfg, 'p')) chunks.push(c)
    expect(chunks.join('')).toBe('ok')
    expect(models[1]).toBe('gemini-2.5-flash-lite')
  })

  it('falls back when first model throws GEMINI_STALL before first token', async () => {
    const enc = new TextEncoder()
    let callCount = 0
    mockFetch(req => {
      const model = new URL(req.url).pathname.split('/models/')[1]?.split(':')[0] ?? ''
      callCount++
      if (model === 'gemini-2.5-flash') {
        // Silent stream — heartbeat fires then zombie watchdog throws GEMINI_STALL
        const body = new ReadableStream<Uint8Array>({ start() {} })
        return new Response(body, { status: 200 })
      }
      const body = new ReadableStream<Uint8Array>({
        start(ctrl) {
          ctrl.enqueue(enc.encode('data: {"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}\n\n'))
          ctrl.close()
        },
      })
      return new Response(body, { status: 200 })
    })
    const cfg: LlmConfig = { models: ['gemini-2.5-flash', 'gemini-2.5-flash-lite'], apiKey: 'fake' }
    const chunks: string[] = []
    for await (const c of streamChat(cfg, 'p', undefined, {
      _idleTimeoutMs: 60,
      _heartbeatIntervalMs: 20,
    })) chunks.push(c)
    expect(chunks.join('')).toBe('ok')
    expect(callCount).toBeGreaterThanOrEqual(2)
  })

  it('does NOT fall back mid-stream after first token received', async () => {
    let callCount = 0
    mockFetch(() => {
      callCount++
      // First call: yields a token then sends a 503 error frame in the stream
      const enc = new TextEncoder()
      const body = new ReadableStream<Uint8Array>({
        start(ctrl) {
          ctrl.enqueue(enc.encode('data: {"candidates":[{"content":{"parts":[{"text":"hello"}]}}]}\n\n'))
          ctrl.enqueue(enc.encode('data: {"error":{"code":503,"status":"UNAVAILABLE","message":"overloaded"}}\n\n'))
          ctrl.close()
        },
      })
      return new Response(body, { status: 200 })
    })
    const cfg: LlmConfig = { models: ['gemini-2.5-flash', 'gemini-2.5-flash-lite'], apiKey: 'fake' }
    const gen = streamChat(cfg, 'p')
    expect((await gen.next()).value).toBe('hello')
    await expect(gen.next()).rejects.toMatchObject({ code: 'GEMINI_OVERLOADED' })
    // Only one fetch call — no fallback after first token
    expect(callCount).toBe(1)
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
