/**
 * [WHAT] YouTube data layer: video-ID parsing, watch-page scraping, InnerTube fallback,
 *        caption track listing, and timed-text XML → plain-text conversion.
 * [WHY]  All YouTube I/O is isolated here so the rest of the worker never touches raw HTML or XML.
 * [INVARIANT] fetchVideoInfo tries the watch page first, then falls back to InnerTube.
 *             The fallback fires on any transport/blocking error (429/403/5xx), but VIDEO_NOT_FOUND
 *             is always re-thrown — a missing video should never silently fall through to InnerTube.
 */

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

/** Pulls ytInitialPlayerResponse JSON out of a raw watch-page HTML string; returns null if absent. */
export function extractPlayerResponse(html: string): PlayerResponse | null {
  const m = html.match(PR_REGEX)
  if (!m) return null
  try { return JSON.parse(m[1]!) as PlayerResponse } catch { return null }
}

/** Maps raw caption track entries from a PlayerResponse to typed CaptionTrack objects. */
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

function playerResponseToInfo(pr: PlayerResponse) {
  const vd = pr.videoDetails ?? {}
  return {
    videoId: vd.videoId ?? '',
    title: vd.title ?? '',
    channel: vd.author ?? '',
    durationSec: Number(vd.lengthSeconds ?? 0),
    tracks: parseCaptionTracks(pr),
  }
}

/** Convenience: extractPlayerResponse + playerResponseToInfo in one call; returns null if no PR found. */
export function extractVideoInfo(html: string) {
  const pr = extractPlayerResponse(html)
  if (!pr) return null
  return playerResponseToInfo(pr)
}

/**
 * Fetches video metadata and caption track list.
 * Tries the watch page first; falls back to InnerTube if the watch page is blocked.
 */
export async function fetchVideoInfo(videoId: string, signal?: AbortSignal) {
  // Track 1: watch page
  try {
    const html = await fetchWatchPage(videoId, signal)
    const info = extractVideoInfo(html)
    if (info) return info
    // 200 but no playerResponse (consent gate, etc.) — fall through to InnerTube
  } catch (err) {
    // Re-throw only VIDEO_NOT_FOUND — the video is genuinely absent, InnerTube will agree.
    // Swallow YOUTUBE_BLOCKED (429/403/5xx) so Track 2 can attempt an unblocked path.
    if (err instanceof YoutubeError && err.code === 'VIDEO_NOT_FOUND') throw err
  }

  // Track 2: InnerTube Android endpoint (not IP-blocked on CF edges)
  console.log(JSON.stringify({ phase: 'innertube.used', videoId }))
  const pr = await fetchPlayerResponseViaInnertube(videoId, signal)
  if (!pr?.videoDetails?.videoId) throw new YoutubeError('VIDEO_NOT_FOUND')
  return playerResponseToInfo(pr)
}

const TEXT_RE = /<text[^>]*>([\s\S]*?)<\/text>/g

function decodeEntities(s: string): string {
  return s
    // YouTube timed-text double-encodes numeric refs (e.g. &amp;#39; instead of &#39;) — handle both.
    .replace(/&amp;#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

/**
 * Converts YouTube timed-text XML to plain text.
 * Lines are merged into paragraph-sized chunks: a new paragraph starts after any line
 * that ends with a sentence-boundary character (.!?;。！？).
 */
export function timedTextToTranscript(xml: string): string {
  if (!xml.includes('<text')) return ''
  const lines: string[] = []
  for (const m of xml.matchAll(TEXT_RE)) {
    const raw = m[1] ?? ''
    const text = decodeEntities(raw).trim().replace(/\s+/g, ' ')
    if (text) lines.push(text)
  }
  const merged: string[] = []
  let cur = ''
  for (const line of lines) {
    cur = cur ? `${cur} ${line}` : line
    if (/[.!?;。！？]$/.test(line)) {
      merged.push(cur)
      cur = ''
    }
  }
  if (cur) merged.push(cur)
  return merged.join('\n')
}

export class YoutubeError extends Error {
  constructor(public code: 'INVALID_URL' | 'VIDEO_NOT_FOUND' | 'NO_CAPTIONS' | 'YOUTUBE_BLOCKED') {
    super(code)
  }
}

/**
 * Fetches the YouTube watch page with a full Chrome 131 browser fingerprint.
 * The realistic UA and sec-ch-ua headers reduce (but don't eliminate) 429 rate-limiting on CF edge IPs.
 */
export async function fetchWatchPage(videoId: string, signal?: AbortSignal): Promise<string> {
  const res = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
    headers: {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9',
      'accept-encoding': 'gzip, deflate, br',
      'sec-ch-ua': '"Not A(Brand";v="8", "Chromium";v="131", "Google Chrome";v="131"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'sec-fetch-dest': 'document',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-site': 'none',
      'sec-fetch-user': '?1',
      'upgrade-insecure-requests': '1',
      'cookie': 'CONSENT=YES+cb.20220627-19-p0.en+FX+012',
    },
    signal,
  })
  // log status for diagnosing CF-edge blocking (temporary)
  console.log(JSON.stringify({ phase: 'youtube.watch.status', videoId, status: res.status }))
  if (!res.ok) throw new YoutubeError(res.status === 404 ? 'VIDEO_NOT_FOUND' : 'YOUTUBE_BLOCKED')
  return await res.text()
}

/**
 * Fetches the player response via the InnerTube Android API.
 * Cloudflare edge IPs are far less likely to be rate-limited by this endpoint than by the watch page,
 * because the Android client fingerprint is treated differently from browser traffic by YouTube's edge.
 */
export async function fetchPlayerResponseViaInnertube(videoId: string, signal?: AbortSignal): Promise<PlayerResponse | null> {
  const res = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': 'com.google.android.youtube/19.09.37 (Linux; U; Android 14) gzip',
      'x-youtube-client-name': '3',
      'x-youtube-client-version': '19.09.37',
    },
    body: JSON.stringify({
      videoId,
      context: {
        client: {
          clientName: 'ANDROID',
          clientVersion: '19.09.37',
          hl: 'en',
          gl: 'US',
          androidSdkVersion: 34,
        },
      },
    }),
    signal,
  })
  if (!res.ok) throw new YoutubeError(res.status === 404 ? 'VIDEO_NOT_FOUND' : 'YOUTUBE_BLOCKED')
  return await res.json() as PlayerResponse
}

/** Fetches raw timed-text XML from a caption track's baseUrl. */
export async function fetchTimedText(baseUrl: string, signal?: AbortSignal): Promise<string> {
  const res = await fetch(baseUrl, { signal })
  if (!res.ok) throw new YoutubeError('YOUTUBE_BLOCKED')
  return await res.text()
}

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
