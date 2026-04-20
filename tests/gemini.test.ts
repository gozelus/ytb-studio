import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { countTokens, streamGenerate, keepaliveTransform, GeminiError } from '../src/gemini'

function mockFetch(impl: (req: Request) => Promise<Response> | Response) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input as string, init)
    return impl(req)
  }))
}

describe('countTokens', () => {
  const env = { GEMINI_API_KEY: 'fake', GEMINI_MODEL: 'gemini-2.5-flash' }

  beforeEach(() => vi.unstubAllGlobals())
  afterEach(() => vi.unstubAllGlobals())

  it('POSTs to :countTokens and returns token count', async () => {
    mockFetch(async req => {
      expect(req.url).toContain(':countTokens')
      expect(req.url).not.toContain('key=')
      expect(req.headers.get('x-goog-api-key')).toBe('fake')
      return new Response(JSON.stringify({ totalTokens: 42 }), { status: 200 })
    })
    const n = await countTokens(env, 'hello world')
    expect(n).toBe(42)
  })

  it('throws GeminiError on 401', async () => {
    mockFetch(() => new Response('nope', { status: 401 }))
    await expect(countTokens(env, 'x')).rejects.toThrow(GeminiError)
    await expect(countTokens(env, 'x')).rejects.toMatchObject({ code: 'GEMINI_AUTH' })
  })

  it('retries once on 429 then succeeds (fast sleep)', async () => {
    let attempt = 0
    mockFetch(() => {
      attempt++
      if (attempt === 1) return new Response('rate limit', { status: 429 })
      return new Response(JSON.stringify({ totalTokens: 7 }), { status: 200 })
    })
    const n = await countTokens(env, 'x', undefined, { sleepFn: async () => {} })
    expect(n).toBe(7)
    expect(attempt).toBe(2)
  })

  it('throws GEMINI_RATE_LIMIT after exhausting 429 retries', async () => {
    let attempt = 0
    mockFetch(() => { attempt++; return new Response('', { status: 429 }) })
    await expect(countTokens(env, 'x', undefined, { sleepFn: async () => {} }))
      .rejects.toMatchObject({ code: 'GEMINI_RATE_LIMIT' })
    expect(attempt).toBe(3)
  })
})

describe('streamGenerate', () => {
  const env = { GEMINI_API_KEY: 'fake', GEMINI_MODEL: 'gemini-2.5-flash' }

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
    for await (const chunk of streamGenerate(env, 'prompt')) chunks.push(chunk)
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
    for await (const c of streamGenerate(env, 'p')) chunks.push(c)
    expect(chunks.join('')).toBe('hello')
  })

  it('refuses to start when signal already aborted', async () => {
    const ctrl = new AbortController()
    ctrl.abort()
    mockFetch(() => new Response('', { status: 200 }))
    const gen = streamGenerate(env, 'p', ctrl.signal)
    await expect(gen.next()).rejects.toMatchObject({ code: 'GEMINI_STREAM_DROP' })
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })
})

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
