import { describe, it, expect, vi, afterEach } from 'vitest'
import worker from '../src/index'

const env = {
  GEMINI_API_KEY: 'fake',
  ASSETS: { fetch: async () => new Response('asset') },
} as any

afterEach(() => vi.unstubAllGlobals())

describe('/api/inspect', () => {
  it('validates URL and returns lightweight metadata without fetching', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    const res = await worker.fetch(new Request('https://local.test/api/inspect', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: ' https://youtu.be/xRh2sVcNXQ8?t=120 ' }),
    }), env)

    expect(res.status).toBe(200)
    expect(fetchSpy).not.toHaveBeenCalled()
    const body = await res.json() as any
    expect(body).toMatchObject({
      videoId: 'xRh2sVcNXQ8',
      url: 'https://youtu.be/xRh2sVcNXQ8?t=120',
      title: 'YouTube · xRh2sVcNXQ8',
    })
    expect(body).not.toHaveProperty('tracks')
  })
})

describe('/api/generate', () => {
  it('ignores legacy trackId and sends the URL as Gemini fileData', async () => {
    let capturedBody: any
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input as string, init)
      expect(req.url).toContain('generativelanguage.googleapis.com')
      capturedBody = await req.json()
      return new Response(
        'data: {"candidates":[{"content":{"parts":[{"text":"{\\"type\\":\\"meta\\",\\"title\\":\\"T\\",\\"subtitle\\":\\"S\\"}\\n{\\"type\\":\\"p\\",\\"speaker\\":null,\\"text\\":\\"正文\\"}\\n"}]}}]}\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    }))

    const res = await worker.fetch(new Request('https://local.test/api/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        url: ' https://youtu.be/xRh2sVcNXQ8?t=120 ',
        trackId: 'legacy.track',
        mode: 'rewrite',
      }),
    }), env)

    expect(res.status).toBe(200)
    expect(res.headers.get('x-req-id')).toBeTruthy()
    const text = await res.text()
    expect(text).toContain('"type":"meta"')
    expect(text).toContain('"type":"p"')
    expect(text).toContain('"type":"end"')

    const parts = capturedBody.contents[0].parts
    expect(capturedBody.generationConfig.mediaResolution).toBe('MEDIA_RESOLUTION_LOW')
    expect(parts[0]).toMatchObject({
      fileData: { fileUri: 'https://youtu.be/xRh2sVcNXQ8?t=120', mimeType: 'video/*' },
      videoMetadata: { fps: 0.5 },
    })
    expect(parts[1].text).toContain('[VIDEO]')
  })

  it('falls back to clipped fileData segments when the full video exceeds context', async () => {
    const capturedBodies: any[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input as string, init)
      expect(req.url).toContain('generativelanguage.googleapis.com')
      capturedBodies.push(await req.json())
      if (capturedBodies.length === 1) {
        return new Response(JSON.stringify({
          error: {
            code: 400,
            status: 'INVALID_ARGUMENT',
            message: 'The input token count exceeds the maximum number of tokens allowed 1048576.',
          },
        }), { status: 400, headers: { 'content-type': 'application/json' } })
      }
      return new Response(
        'data: {"candidates":[{"content":{"parts":[{"text":"{\\"type\\":\\"meta\\",\\"title\\":\\"Long\\",\\"subtitle\\":\\"Segmented\\"}\\n{\\"type\\":\\"p\\",\\"speaker\\":null,\\"text\\":\\"分段正文\\"}\\n"}]}}]}\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    }))

    const res = await worker.fetch(new Request('https://local.test/api/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        url: 'https://www.youtube.com/watch?v=xRh2sVcNXQ8',
        mode: 'rewrite',
      }),
    }), { ...env, LONG_VIDEO_MAX_SEGMENTS: '1' })

    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('"stage":"long_video_fallback"')
    expect(text).toContain('"title":"Long"')
    expect(text).toContain('分段正文')
    expect(text).toContain('GEMINI_LONG_VIDEO_LIMIT')

    expect(capturedBodies).toHaveLength(2)
    expect(capturedBodies[0].contents[0].parts[0]).toMatchObject({
      fileData: { fileUri: 'https://www.youtube.com/watch?v=xRh2sVcNXQ8', mimeType: 'video/*' },
      videoMetadata: { fps: 0.5 },
    })
    expect(capturedBodies[0].generationConfig.mediaResolution).toBe('MEDIA_RESOLUTION_LOW')
    expect(capturedBodies[1].contents[0].parts[0]).toMatchObject({
      fileData: { fileUri: 'https://www.youtube.com/watch?v=xRh2sVcNXQ8', mimeType: 'video/*' },
      videoMetadata: { startOffset: '0s', endOffset: '300s', fps: 0.25 },
    })
    expect(capturedBodies[1].contents[0].parts[1].text).toContain('[LONG VIDEO SEGMENT]')
  })
})
