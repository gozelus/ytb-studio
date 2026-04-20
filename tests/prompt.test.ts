import { describe, it, expect } from 'vitest'
import { buildPromptForVideo, PROMPT_VERSION } from '../src/prompt'

describe('buildPromptForVideo', () => {
  it('contains contract and mode rules but no [VIDEO META] or [TRANSCRIPT]', () => {
    const p = buildPromptForVideo('rewrite')
    expect(p).toContain('ndjson')
    expect(p).toContain('rewrite')
    expect(p).toContain('[VIDEO]')
    expect(p).not.toContain('[VIDEO META]')
    expect(p).not.toContain('[TRANSCRIPT]')
  })

  it('switches rules when mode=faithful', () => {
    const p = buildPromptForVideo('faithful')
    expect(p).toContain('只翻译不改写')
    expect(p).not.toContain('5–10 个大章节')
  })

  it('exposes PROMPT_VERSION', () => {
    expect(PROMPT_VERSION).toMatch(/^v\d+$/)
  })
})
