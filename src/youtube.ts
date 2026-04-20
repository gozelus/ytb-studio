import type { CaptionTrack } from './types'

const ID_PATTERN = /^[a-zA-Z0-9_-]{11}$/

interface PlayerResponse {
  videoDetails?: {
    videoId?: string
    title?: string
    author?: string
    lengthSeconds?: string
  }
  captions?: {
    playerCaptionsTracklistRenderer?: {
      captionTracks?: Array<{
        baseUrl: string
        languageCode: string
        name?: { simpleText?: string; runs?: Array<{ text: string }> }
        kind?: string
        vssId?: string
      }>
    }
  }
}

const PR_REGEX = /var ytInitialPlayerResponse\s*=\s*(\{.+?\})\s*;\s*(?:var|<\/script>)/s

export function extractPlayerResponse(html: string): PlayerResponse | null {
  const m = html.match(PR_REGEX)
  if (!m) return null
  try { return JSON.parse(m[1]!) as PlayerResponse } catch { return null }
}

export function parseCaptionTracks(pr: PlayerResponse): CaptionTrack[] {
  const raw = pr.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? []
  return raw.map((t): CaptionTrack => {
    const isAuto = t.kind === 'asr'
    const label = t.name?.simpleText
      ?? t.name?.runs?.map(r => r.text).join('')
      ?? t.languageCode
    return {
      id: `${isAuto ? 'asr' : 'a'}.${t.languageCode}`,
      lang: t.languageCode,
      label,
      kind: isAuto ? 'auto' : 'manual',
      baseUrl: t.baseUrl,
    }
  })
}

export function extractVideoInfo(html: string) {
  const pr = extractPlayerResponse(html)
  if (!pr) return null
  const vd = pr.videoDetails ?? {}
  const tracks = parseCaptionTracks(pr)
  return {
    videoId: vd.videoId ?? '',
    title: vd.title ?? '',
    channel: vd.author ?? '',
    durationSec: Number(vd.lengthSeconds ?? 0),
    tracks,
  }
}

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
