import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createArticleTailController } from '../public/article-tail.js'

function createHarness() {
  const nodes = {
    articleTail: { hidden: true, className: 'article-tail' },
    articleTailTitle: { textContent: '' },
    articleTailMeta: { textContent: '' },
    articleTailBar: { style: { width: '0%' } },
  }

  return {
    nodes,
    tail: createArticleTailController({
      $: id => {
        if (!nodes[id]) throw new Error(`unexpected id: ${id}`)
        return nodes[id]
      },
    }),
  }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('article tail status', () => {
  it('carries long-video segment state from prep into article generation', () => {
    const { nodes, tail } = createHarness()

    tail.handleHeartbeat({
      type: 'heartbeat',
      idleSeconds: 0,
      stage: 'long_video_segment_start',
      segmentIndex: 0,
      maxSegments: 4,
    })
    tail.start()
    tail.markContentEvent({ type: 'p', speaker: 'Guest', text: 'Body.' })

    expect(nodes.articleTail.hidden).toBe(false)
    expect(nodes.articleTail.className).toContain('is-thinking')
    expect(nodes.articleTailTitle.textContent).toContain('第 1/4 个视频片段')
    expect(nodes.articleTailMeta.textContent).toContain('已接收 1 段')
    expect(nodes.articleTailMeta.textContent).toContain('还有 4 段待完成')
  })

  it('marks completion after the article stream ends', () => {
    const { nodes, tail } = createHarness()

    tail.start()
    tail.markContentEvent({ type: 'h2', text: 'Section' })
    vi.advanceTimersByTime(62_000)
    tail.complete()

    expect(nodes.articleTail.className).toBe('article-tail is-done')
    expect(nodes.articleTailTitle.textContent).toBe('生成完成')
    expect(nodes.articleTailMeta.textContent).toContain('共接收 1 段内容')
    expect(nodes.articleTailBar.style.width).toBe('100%')
  })
})
