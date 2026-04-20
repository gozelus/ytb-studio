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
    expect(p).not.toContain('章节顺序、标题和主要提问者')
  })

  it('keeps speaker extraction generic instead of pinning demo people in code', () => {
    const p = buildPromptForVideo('rewrite')
    expect(p).toContain('保留 Q&A 骨架')
    expect(p).toContain('speaker 来自视频内容')
    expect(p).toContain('若视频标题或描述能看出姓名，使用姓名')
    expect(p).not.toContain('speaker 只能使用')
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
    expect(p).toContain('直接拼接到同一篇文章')
  })
})
