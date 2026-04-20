import { createNdjsonParser } from './parser'
import { LlmError, streamChat } from './llm'
import type { ErrorCode, StreamEvent } from './types'
import type { LlmConfig, Part } from './llm'

export async function streamVideoNdjson(opts: {
  cfg: LlmConfig
  parts: Part[]
  signal?: AbortSignal
  progress: { firstChunk: boolean; events: number }
  initialResponseTimeoutMs?: number
  idleTimeoutMs?: number
  textIdleTimeoutMs?: number
  firstTextTimeoutMs?: number
  noFallbackCodes?: ErrorCode[]
  onEvent: (e: StreamEvent) => boolean | void
  onHeartbeat: (idleSeconds: number) => void
  onModelFallback?: (from: string, to: string, reason: ErrorCode) => void
}): Promise<void> {
  let parser: ReturnType<typeof createNdjsonParser> | null = null
  const controller = new AbortController()
  const abortFromParent = () => controller.abort()
  if (opts.signal?.aborted) controller.abort()
  opts.signal?.addEventListener('abort', abortFromParent, { once: true })
  try {
    parser = createNdjsonParser(e => {
      if (opts.onEvent(e)) opts.progress.events++
    })
    const stream = streamChat(opts.cfg, opts.parts, controller.signal, {
      initialResponseTimeoutMs: opts.initialResponseTimeoutMs,
      _idleTimeoutMs: opts.idleTimeoutMs,
      _textIdleTimeoutMs: opts.textIdleTimeoutMs,
      mediaResolution: 'MEDIA_RESOLUTION_LOW',
      noFallbackCodes: opts.noFallbackCodes,
      onHeartbeat: opts.onHeartbeat,
      onModelFallback: opts.onModelFallback,
    })
    const iter = stream[Symbol.asyncIterator]()
    const deadlineAt = opts.firstTextTimeoutMs ? Date.now() + opts.firstTextTimeoutMs : 0
    while (true) {
      const next = opts.progress.firstChunk || !deadlineAt
        ? await iter.next()
        : await nextWithDeadline(iter, controller, Math.max(0, deadlineAt - Date.now()), opts.firstTextTimeoutMs!)
      if (next.done) break
      const chunk = next.value
      if (!opts.progress.firstChunk) {
        opts.progress.firstChunk = true
      }
      parser.feed(chunk)
    }
    parser.end()
  } catch (err) {
    try { parser?.end() } catch { /* flush any partial last line from buf */ }
    throw err
  } finally {
    opts.signal?.removeEventListener('abort', abortFromParent)
  }
}

async function nextWithDeadline(
  iter: AsyncIterator<string>,
  controller: AbortController,
  timeoutMs: number,
  configuredTimeoutMs: number,
): Promise<IteratorResult<string>> {
  if (timeoutMs <= 0) {
    controller.abort()
    throw new LlmError('GEMINI_STALL', `No Gemini text in ${Math.round(configuredTimeoutMs / 1000)}s`)
  }
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      iter.next(),
      new Promise<IteratorResult<string>>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort()
          void iter.return?.()
          reject(new LlmError('GEMINI_STALL', `No Gemini text in ${Math.round(configuredTimeoutMs / 1000)}s`))
        }, timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export function videoPart(fileUri: string, opts: { startSec?: number; endSec?: number; fps?: number } = {}): Part {
  const part: Part = { fileData: { fileUri, mimeType: 'video/*' } }
  const videoMetadata: { startOffset?: string; endOffset?: string; fps?: number } = {}
  if (opts.startSec !== undefined) videoMetadata.startOffset = `${opts.startSec}s`
  if (opts.endSec !== undefined) videoMetadata.endOffset = `${opts.endSec}s`
  if (opts.fps !== undefined) videoMetadata.fps = opts.fps
  if (Object.keys(videoMetadata).length > 0 && 'fileData' in part) part.videoMetadata = videoMetadata
  return part
}
