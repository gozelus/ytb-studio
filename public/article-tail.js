const TICK_MS = 2000

export function createArticleTailController({ $ }) {
  const state = {
    startedAt: 0,
    contentEvents: 0,
    paragraphEvents: 0,
    longVideo: false,
    maxSegments: 0,
    currentSegment: 0,
    completedSegments: 0,
    lastStage: '',
    status: 'idle',
    timer: null,
  }

  function reset() {
    if (state.timer) {
      clearInterval(state.timer)
      state.timer = null
    }
    state.startedAt = 0
    state.contentEvents = 0
    state.paragraphEvents = 0
    state.longVideo = false
    state.maxSegments = 0
    state.currentSegment = 0
    state.completedSegments = 0
    state.lastStage = ''
    state.status = 'idle'
    $('articleTail').hidden = true
    $('articleTail').className = 'article-tail'
    $('articleTailBar').style.width = '0%'
  }

  function start() {
    if (state.timer) clearInterval(state.timer)
    state.startedAt = Date.now()
    state.status = 'generating'
    $('articleTail').hidden = false
    $('articleTail').className = 'article-tail is-thinking'
    render()
    state.timer = setInterval(render, TICK_MS)
  }

  function markContentEvent(ev) {
    if (ev.type !== 'h2' && ev.type !== 'h3' && ev.type !== 'p') return
    state.contentEvents++
    if (ev.type === 'p') state.paragraphEvents++
    render()
  }

  function handleHeartbeat(ev) {
    const stage = String(ev.stage || '')
    if (stage === 'long_video_fallback') {
      state.longVideo = true
      state.lastStage = '已进入长视频分段生成'
    } else if (stage === 'model_fallback') {
      state.lastStage = '模型响应不稳，已切换备用模型继续生成'
    } else if (stage === 'long_video_segment_start') {
      state.longVideo = true
      state.currentSegment = Number(ev.segmentIndex ?? state.currentSegment - 1) + 1
      state.maxSegments = Math.max(state.maxSegments, Number(ev.maxSegments ?? 0))
      state.lastStage = `正在处理第 ${state.currentSegment}${state.maxSegments ? `/${state.maxSegments}` : ''} 个视频片段`
    } else if (stage === 'long_video_segment_done') {
      state.longVideo = true
      const done = Number(ev.segmentIndex ?? state.completedSegments - 1) + 1
      state.completedSegments = Math.max(state.completedSegments, done)
      state.maxSegments = Math.max(state.maxSegments, Number(ev.maxSegments ?? 0))
      state.lastStage = `已完成 ${state.completedSegments}${state.maxSegments ? `/${state.maxSegments}` : ''} 个视频片段`
    } else if (/^long_video_segment_\d+$/.test(stage)) {
      state.longVideo = true
      state.currentSegment = Number(stage.replace('long_video_segment_', ''))
      state.lastStage = `第 ${state.currentSegment} 个视频片段仍在生成`
    } else if (stage === 'upstream_thinking') {
      state.lastStage = 'Gemini 正在继续组织后续段落'
    }
    render()
  }

  function complete() {
    state.status = 'done'
    if (state.timer) {
      clearInterval(state.timer)
      state.timer = null
    }
    $('articleTail').hidden = false
    $('articleTail').className = 'article-tail is-done'
    render()
  }

  function interrupt() {
    if (state.status === 'idle') return
    state.status = 'interrupted'
    if (state.timer) {
      clearInterval(state.timer)
      state.timer = null
    }
    $('articleTail').hidden = false
    $('articleTail').className = 'article-tail is-interrupted'
    render()
  }

  function render() {
    if (state.status === 'idle') return
    $('articleTailTitle').textContent = titleText()
    $('articleTailMeta').textContent = metaText()
    $('articleTailBar').style.width = `${progressPct()}%`
  }

  function titleText() {
    if (state.status === 'done') return '生成完成'
    if (state.status === 'interrupted') return '生成已中断'
    return state.lastStage || 'AI 正在继续生成'
  }

  function metaText() {
    const elapsed = elapsedSeconds()
    if (state.status === 'done') {
      return `共接收 ${state.contentEvents} 段内容 · 用时 ${formatDuration(elapsed)}`
    }
    if (state.status === 'interrupted') {
      return `已保留 ${state.contentEvents} 段内容 · 用时 ${formatDuration(elapsed)}`
    }
    if (state.longVideo && state.maxSegments > 0) {
      const remaining = Math.max(0, state.maxSegments - state.completedSegments)
      const current = state.currentSegment || state.completedSegments + 1
      return `已接收 ${state.contentEvents} 段 · 正在处理第 ${current}/${state.maxSegments} 段 · 还有 ${remaining} 段待完成 · 预计 ${formatEta(estimateRemainingSeconds())}`
    }
    return `已接收 ${state.contentEvents} 段 · 后续内容仍在生成 · 预计 ${formatEta(estimateRemainingSeconds())}`
  }

  function progressPct() {
    if (state.status === 'done') return 100
    if (state.status === 'interrupted') return Math.min(92, Math.max(18, state.contentEvents * 4))
    if (state.longVideo && state.maxSegments > 0) {
      const done = Math.max(state.completedSegments, state.currentSegment - 1)
      return Math.min(94, Math.max(8, (done / state.maxSegments) * 100))
    }
    return Math.min(88, 12 + state.contentEvents * 4 + elapsedSeconds() / 10)
  }

  function estimateRemainingSeconds() {
    const elapsed = elapsedSeconds()
    if (state.longVideo && state.maxSegments > 0) {
      const done = Math.max(1, state.completedSegments)
      const remaining = Math.max(0, state.maxSegments - state.completedSegments)
      const avg = state.completedSegments > 0 ? elapsed / done : 75
      return clamp(remaining * avg, 30, 20 * 60)
    }
    if (state.contentEvents < 6) return 90
    if (elapsed < 90) return 60
    return 120
  }

  function elapsedSeconds() {
    return state.startedAt ? Math.max(0, Math.round((Date.now() - state.startedAt) / 1000)) : 0
  }

  return { complete, handleHeartbeat, interrupt, markContentEvent, reset, start }
}

function formatEta(seconds) {
  if (seconds <= 45) return '不到 1 分钟'
  if (seconds < 120) return '约 1 分钟'
  return `约 ${Math.ceil(seconds / 60)} 分钟`
}

function formatDuration(seconds) {
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}
