/**
 * [WHAT] Streaming ndjson parser: turns incremental Gemini text chunks into typed StreamEvents.
 * [WHY]  Gemini yields raw text bytes; line buffering and type validation belong here, not in the route.
 * [INVARIANT] Invalid lines (non-object, bad JSON, unknown type) are silently dropped with a capped
 *             warning (max 5, then suppressed). Callers must not assume every input byte becomes an event.
 */

import type { StreamEvent } from './types'

export interface NdjsonParser {
  feed(chunk: string): void
  end(): void
}

const VALID_TYPES = new Set(['meta', 'h2', 'h3', 'p', 'end', 'error'])

/**
 * Creates a stateful parser. Call feed() with each incoming text chunk; call end() when the
 * stream closes to flush any unterminated final line. onWarn defaults to console.warn.
 */
export function createNdjsonParser(
  onEvent: (e: StreamEvent) => void,
  onWarn: (msg: string, line: string) => void = (m, l) => console.warn(m, l),
): NdjsonParser {
  let buf = ''
  let warnCount = 0

  function processLine(line: string) {
    const trimmed = line.trim()
    if (!trimmed) return
    if (!trimmed.startsWith('{')) return warn('parser.skip.not_object', trimmed)
    let obj: any
    try { obj = JSON.parse(trimmed) } catch { return warn('parser.skip.invalid_json', trimmed) }
    if (typeof obj?.type !== 'string' || !VALID_TYPES.has(obj.type)) {
      return warn('parser.skip.unknown_type', trimmed)
    }
    onEvent(obj as StreamEvent)
  }

  function warn(msg: string, line: string) {
    warnCount++
    if (warnCount <= 5) onWarn(msg, line)
    else if (warnCount === 6) onWarn('parser.warn.suppressed_further', '')
  }

  return {
    feed(chunk: string) {
      buf += chunk
      let idx: number
      while ((idx = buf.indexOf('\n')) >= 0) {
        processLine(buf.slice(0, idx))
        buf = buf.slice(idx + 1)
      }
    },
    end() {
      if (buf) { processLine(buf); buf = '' }
    },
  }
}
