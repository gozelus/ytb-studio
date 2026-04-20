/**
 * [WHAT] YouTube URL parsing helpers.
 * [WHY]  The worker never fetches YouTube directly; validated URLs are passed to
 *        Gemini as fileData so Gemini reads the video itself.
 */

const ID_PATTERN = /^[a-zA-Z0-9_-]{11}$/

/**
 * Extracts the 11-char video ID from any supported YouTube URL form
 * (watch, youtu.be, embed, shorts, m.youtube). Returns null for non-YouTube or malformed input.
 */
export function parseVideoId(raw: string): string | null {
  if (!raw || typeof raw !== 'string') return null
  let u: URL
  try { u = new URL(raw.trim()) } catch { return null }

  const host = u.hostname.replace(/^www\.|^m\./, '')

  if (host === 'youtu.be') {
    const id = u.pathname.slice(1)
    return ID_PATTERN.test(id) ? id : null
  }
  if (host !== 'youtube.com') return null

  if (u.pathname === '/watch') {
    const id = u.searchParams.get('v') ?? ''
    return ID_PATTERN.test(id) ? id : null
  }
  const m = u.pathname.match(/^\/(embed|shorts)\/([^/?]+)/)
  if (m && ID_PATTERN.test(m[2]!)) return m[2]!
  return null
}

export function normalizeVideoUrl(raw: string): string {
  return raw.trim()
}
