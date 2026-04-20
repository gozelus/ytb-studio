import { describe, it, expect } from 'vitest'
import { buildPromptForVideo, buildPromptForVideoSegment, PROMPT_VERSION } from '../src/prompt'

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
    expect(p).not.toContain('如果不是该视频，忽略本段')
  })

  it('anchors rewrite mode to the supplied demo video structure when applicable', () => {
    const p = buildPromptForVideo('rewrite')
    expect(p).toContain('对话安德森：AI革命的万亿美金之问')
    expect(p).toContain('地缘博弈：中美竞速下的AI冷战')
    expect(p).toContain('如果不是该视频，忽略本段')
  })

  it('exposes PROMPT_VERSION', () => {
    expect(PROMPT_VERSION).toMatch(/^v\d+$/)
  })

  it('adds segment instructions for long-video fallback', () => {
    const p = buildPromptForVideoSegment('rewrite', {
      segmentIndex: 1,
      startSec: 1800,
      endSec: 3600,
      includeMeta: false,
    })
    expect(p).toContain('[LONG VIDEO SEGMENT]')
    expect(p).toContain('30:00 到 1:00:00')
    expect(p).toContain('禁止输出 meta')
  })
})
