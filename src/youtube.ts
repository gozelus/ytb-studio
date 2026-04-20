/**
 * [WHAT] YouTube 视频元信息与字幕抓取（URL 解析 / 字幕下载 / XML→纯文本）
 *
 * [WHY / CF Edge IP Blocking]
 * Cloudflare Workers 的边缘 IP 被 YouTube 反爬系统主动拦截：
 *   - `www.youtube.com/watch?v=<id>` → 429 Too Many Requests
 *   - InnerTube `youtubei/v1/player` (ANDROID / TVHTML5_SIMPLY_EMBEDDED_PLAYER)
 *     → 400 或 200 但仅返回 `playabilityStatus`，缺 `videoDetails` 与 captions
 *     （真实数据受 po_token gating 保护，无浏览器 BotGuard 环境无法获得）
 *
 * 因此采用两轨方案：
 *   Track 1 · watch page：少数 CF IP 与时窗仍可通；成本极低，先试
 *   Track 2 · Gemini fileData：watch 失败时返回合成 track `gemini.direct`，
 *            /api/generate 直接把 YouTube URL 作为 fileData 喂给 Gemini，
 *            由 Google 自家 IP 拉取视频与字幕，彻底绕开 CF→YouTube 限制
 *
 * [INVARIANT] YoutubeError 的 code ∈ {INVALID_URL, VIDEO_NOT_FOUND,
 *             NO_CAPTIONS, YOUTUBE_BLOCKED}。YOUTUBE_BLOCKED 触发 Gemini
 *             fileData 兜底；VIDEO_NOT_FOUND 不兜底（视频真的不存在）。
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
 * Fetches video metadata and caption track list via the watch page (Track 1).
 * Throws YOUTUBE_BLOCKED if blocked or if the page returns no playerResponse,
 * which the caller (/api/inspect) converts into the gemini.direct fallback track.
 */
export async function fetchVideoInfo(videoId: string, signal?: AbortSignal) {
  const html = await fetchWatchPage(videoId, signal)
  const info = extractVideoInfo(html)
  // Anti-scrape pages occasionally match PR_REGEX but yield an empty PlayerResponse
  // with no videoDetails.videoId; treat both null and empty-id as blocked.
  if (!info || !info.videoId) throw new YoutubeError('YOUTUBE_BLOCKED')
  return info
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
  console.log(JSON.stringify({ phase: 'youtube.watch.status', videoId, status: res.status }))
  if (!res.ok) throw new YoutubeError(res.status === 404 ? 'VIDEO_NOT_FOUND' : 'YOUTUBE_BLOCKED')
  return await res.text()
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
