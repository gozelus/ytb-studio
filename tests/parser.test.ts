import { describe, it, expect, vi } from 'vitest'
import { createNdjsonParser } from '../src/parser'

describe('ndjson parser', () => {
  it('emits one event per valid JSON line', () => {
    const events: any[] = []
    const p = createNdjsonParser(e => events.push(e))
    p.feed('{"type":"h2","text":"A"}\n{"type":"h3","text":"B"}\n')
    expect(events).toEqual([
      { type: 'h2', text: 'A' },
      { type: 'h3', text: 'B' },
    ])
  })

  it('buffers partial lines across feeds', () => {
    const events: any[] = []
    const p = createNdjsonParser(e => events.push(e))
    p.feed('{"type":"h2",')
    p.feed('"text":"X"}\n')
    expect(events).toEqual([{ type: 'h2', text: 'X' }])
  })

  it('drops invalid JSON lines with warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const events: any[] = []
    const p = createNdjsonParser(e => events.push(e))
    p.feed('not json\n{"type":"h2","text":"ok"}\n{broken\n')
    expect(events).toEqual([{ type: 'h2', text: 'ok' }])
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('ignores empty lines', () => {
    const events: any[] = []
    const p = createNdjsonParser(e => events.push(e))
    p.feed('\n\n{"type":"end"}\n\n')
    expect(events).toEqual([{ type: 'end' }])
  })

  it('flushes remaining buffer on end()', () => {
    const events: any[] = []
    const p = createNdjsonParser(e => events.push(e))
    p.feed('{"type":"h2","text":"no-newline"}')
    p.end()
    expect(events).toEqual([{ type: 'h2', text: 'no-newline' }])
  })
})
