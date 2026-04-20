/**
 * [WHAT] YouTube data layer: video-ID parsing, watch-page scraping, InnerTube fallback,
 *        caption track listing, and timed-text XML → plain-text conversion.
 * [WHY]  All YouTube I/O is isolated here so the rest of the worker never touches raw HTML or XML.
 * [INVARIANT] fetchVideoInfo cascades through three tracks: watch page → Android InnerTube →
 *             TV-Embedded InnerTube. Each track falls through only on YOUTUBE_BLOCKED (429/403/5xx).
 *             VIDEO_NOT_FOUND is always re-thrown immediately — a missing video won't succeed on any track.
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
 * Fetches video metadata and caption track list, cascading through three tracks on blocking errors.
 * Track 1: watch page; Track 2: Android InnerTube; Track 3: TV-Embedded InnerTube.
 */
export async function fetchVideoInfo(videoId: string, signal?: AbortSignal) {
  // Track 1: watch page
  try {
    const html = await fetchWatchPage(videoId, signal)
    const info = extractVideoInfo(html)
    if (info) return info
    // 200 but no playerResponse (consent gate, etc.) — fall through
  } catch (err) {
    // Re-throw only VIDEO_NOT_FOUND — the video is genuinely absent, no fallback will help.
    // Swallow YOUTUBE_BLOCKED (429/403/5xx) so the next track can attempt an unblocked path.
    if (err instanceof YoutubeError && err.code === 'VIDEO_NOT_FOUND') throw err
  }

  // Track 2: Android InnerTube
  console.log(JSON.stringify({ phase: 'innertube.android.used', videoId }))
  try {
    const pr = await fetchPlayerResponseViaInnertube(videoId, signal)
    if (pr?.videoDetails?.videoId) return playerResponseToInfo(pr)
    throw new YoutubeError('VIDEO_NOT_FOUND')
  } catch (err) {
    if (err instanceof YoutubeError && err.code === 'VIDEO_NOT_FOUND') throw err
    // YOUTUBE_BLOCKED — fall through to TV Embedded
  }

  // Track 3: TV-Embedded InnerTube (uses a different quota bucket, less likely to be blocked)
  console.log(JSON.stringify({ phase: 'innertube.tv.used', videoId }))
  const pr = await fetchPlayerResponseViaInnertubeTV(videoId, signal)
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
  console.log(JSON.stringify({ phase: 'youtube.innertube.status', videoId, status: res.status }))
  if (!res.ok) throw new YoutubeError(res.status === 404 ? 'VIDEO_NOT_FOUND' : 'YOUTUBE_BLOCKED')
  return await res.json() as PlayerResponse
}

/**
 * Fetches the player response via the InnerTube TV-Embedded client.
 * TVHTML5_SIMPLY_EMBEDDED_PLAYER has a looser rate-limit quota than the Android client,
 * and the embedUrl context signals an embedded (non-direct) request, which YouTube treats differently.
 */
export async function fetchPlayerResponseViaInnertubeTV(videoId: string, signal?: AbortSignal): Promise<PlayerResponse | null> {
  const res = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': 'Mozilla/5.0 (SMART-TV; LINUX; Tizen 6.0) AppleWebKit/538.1 (KHTML, like Gecko) Version/6.0 TV Safari/538.1',
      'x-youtube-client-name': '85',
      'x-youtube-client-version': '2.0',
    },
    body: JSON.stringify({
      videoId,
      context: {
        client: {
          clientName: 'TVHTML5_SIMPLY_EMBEDDED_PLAYER',
          clientVersion: '2.0',
          hl: 'en',
          gl: 'US',
        },
        thirdParty: { embedUrl: 'https://www.youtube.com' },
      },
    }),
    signal,
  })
  console.log(JSON.stringify({ phase: 'youtube.innertube.tv.status', videoId, status: res.status }))
  if (!res.ok) throw new YoutubeError(res.status === 404 ? 'VIDEO_NOT_FOUND' : 'YOUTUBE_BLOCKED')
  // temporary debug — remove after root-cause known
  const json = await res.json() as Record<string, unknown> & { videoDetails?: unknown; captions?: unknown; playabilityStatus?: { reason?: string } }
  console.log(JSON.stringify({
    phase: 'tv.keys',
    videoId,
    topKeys: Object.keys(json),
    hasVideoDetails: !!json.videoDetails,
    hasCaptions: !!json.captions,
    hasPlayabilityStatus: !!json.playabilityStatus,
    playabilityReason: json.playabilityStatus?.reason,
  }))
  return json as PlayerResponse
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
