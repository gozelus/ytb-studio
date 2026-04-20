import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { countTokens, GeminiError } from '../src/gemini'

function mockFetch(impl: (req: Request) => Promise<Response> | Response) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const req = input instanceof Request ? input : new Request(input as any)
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
      expect(req.url).toContain('key=fake')
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
