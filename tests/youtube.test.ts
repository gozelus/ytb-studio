import { describe, it, expect } from 'vitest'
import { parseVideoId, extractPlayerResponse, parseCaptionTracks } from '../src/youtube'
// @ts-ignore — Vite raw import, bundled at test build time
import FIXTURE from './fixtures/watch-xRh2sVcNXQ8.html?raw'

describe('parseVideoId', () => {
  const valid: [string, string][] = [
    ['https://www.youtube.com/watch?v=xRh2sVcNXQ8', 'xRh2sVcNXQ8'],
    ['https://youtube.com/watch?v=xRh2sVcNXQ8', 'xRh2sVcNXQ8'],
    ['https://youtu.be/xRh2sVcNXQ8', 'xRh2sVcNXQ8'],
    ['https://youtu.be/xRh2sVcNXQ8?t=120', 'xRh2sVcNXQ8'],
    ['https://www.youtube.com/watch?v=xRh2sVcNXQ8&t=90s', 'xRh2sVcNXQ8'],
    ['https://www.youtube.com/embed/xRh2sVcNXQ8', 'xRh2sVcNXQ8'],
    ['https://www.youtube.com/shorts/xRh2sVcNXQ8', 'xRh2sVcNXQ8'],
    ['https://m.youtube.com/watch?v=xRh2sVcNXQ8', 'xRh2sVcNXQ8'],
  ]
  for (const [url, id] of valid) {
    it(`accepts ${url}`, () => expect(parseVideoId(url)).toBe(id))
  }

  const invalid = [
    '',
    'not a url',
    'https://example.com/watch?v=xRh2sVcNXQ8',
    'https://www.youtube.com/watch',
    'https://www.youtube.com/watch?v=short',
    'https://vimeo.com/123',
  ]
  for (const url of invalid) {
    it(`rejects ${JSON.stringify(url)}`, () => expect(parseVideoId(url)).toBeNull())
  }
})

describe('watch page parsing', () => {
  it('extracts ytInitialPlayerResponse JSON', () => {
    const pr = extractPlayerResponse(FIXTURE)
    expect(pr).not.toBeNull()
    expect(pr!.videoDetails?.videoId).toBe('xRh2sVcNXQ8')
  })

  it('parses captionTracks from playerResponse', () => {
    const pr = extractPlayerResponse(FIXTURE)!
    const tracks = parseCaptionTracks(pr)
    expect(tracks.length).toBeGreaterThan(0)
    const first = tracks[0]!
    expect(first.id).toMatch(/^(a|asr)\./)
    expect(first.lang).toBeTruthy()
    expect(first.baseUrl).toMatch(/^https?:\/\//)
  })

  it('returns empty array when no captions', () => {
    expect(parseCaptionTracks({ videoDetails: {} } as any)).toEqual([])
  })
})
