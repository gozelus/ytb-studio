import { describe, it, expect } from 'vitest'
import { buildPrompt, buildPromptForVideo, PROMPT_VERSION } from '../src/prompt'

const META = { videoId: 'x', title: 'T', channel: 'C', durationSec: 60 }

describe('buildPrompt', () => {
  it('contains contract + mode rules + few-shot + transcript', () => {
    const p = buildPrompt('rewrite', META, 'hello transcript')
    expect(p).toContain('ndjson')
    expect(p).toContain('rewrite')
    expect(p).toContain('hello transcript')
    expect(p).toContain('title: T')
  })

  it('switches rules when mode=faithful', () => {
    const p = buildPrompt('faithful', META, '')
    expect(p).toContain('faithful')
    expect(p).toContain('只翻译不改写')
    expect(p).not.toContain('5–10 个大章节')
  })

  it('exposes PROMPT_VERSION', () => {
    expect(PROMPT_VERSION).toMatch(/^v\d+$/)
  })
})

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
})

