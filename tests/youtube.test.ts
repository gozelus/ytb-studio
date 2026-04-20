import { describe, it, expect } from 'vitest'
import { normalizeVideoUrl, parseVideoId } from '../src/youtube'

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

describe('normalizeVideoUrl', () => {
  it('trims the URL that will be passed to Gemini fileData', () => {
    expect(normalizeVideoUrl('  https://youtu.be/xRh2sVcNXQ8?t=120  '))
      .toBe('https://youtu.be/xRh2sVcNXQ8?t=120')
  })
})
