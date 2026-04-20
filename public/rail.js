export function createRailController({ state, $ }) {
  function bindRailControls() {
    $('railToggle').addEventListener('click', () => {
      setRailCollapsed(!$('rail').classList.contains('collapsed'))
    })
    $('articleView').addEventListener('scroll', scheduleRailActiveSync)
  }

  function setRailCollapsed(collapsed) {
    $('rail').classList.toggle('collapsed', collapsed)
    $('railToggle').textContent = collapsed ? '›' : '‹'
    $('railToggle').setAttribute('aria-label', collapsed ? '展开侧栏' : '折叠侧栏')
  }

  function resetRailArticle() {
    state.navItems = []
    state.nextHeadingId = 1
    if (state.navSyncFrame) {
      cancelAnimationFrame(state.navSyncFrame)
      state.navSyncFrame = null
    }
    $('railArticle').hidden = true
    $('railArticleTitle').textContent = '—'
    $('railToc').innerHTML = ''
    $('rail').classList.remove('reading')
  }

  function showRailArticle(metaEv) {
    resetRailArticle()
    $('rail').classList.add('reading')
    $('railArticle').hidden = false
    $('railArticleTitle').textContent = metaEv.title || '正在生成文章'
    appendRailNav('articleH1', '文章开头', 'top')
    activateRailNav('articleH1')
  }

  function registerRailHeading(node, ev) {
    if (ev.type !== 'h2' && ev.type !== 'h3') return
    node.id = node.id || `section-${state.nextHeadingId++}`
    appendRailNav(node.id, ev.text || '未命名章节', ev.type)
    scheduleRailActiveSync()
  }

  function appendRailNav(targetId, text, level) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = `toc-item toc-${level}`
    btn.dataset.target = targetId
    btn.textContent = text
    btn.addEventListener('click', () => jumpToRailTarget(targetId))
    $('railToc').appendChild(btn)
    state.navItems.push({ targetId, btn })
  }

  function jumpToRailTarget(targetId) {
    const target = $(targetId)
    const article = $('articleView')
    if (!target || !article) return
    article.scrollTop = Math.max(0, target.offsetTop - 28)
    activateRailNav(targetId)
  }

  function activateRailNav(targetId) {
    for (const item of state.navItems) item.btn.classList.toggle('active', item.targetId === targetId)
  }

  function scheduleRailActiveSync() {
    if (state.navSyncFrame) return
    state.navSyncFrame = requestAnimationFrame(() => {
      state.navSyncFrame = null
      const article = $('articleView')
      let active = state.navItems[0]?.targetId
      for (const item of state.navItems) {
        const node = $(item.targetId)
        if (node && node.offsetTop - 80 <= article.scrollTop) active = item.targetId
      }
      if (active) activateRailNav(active)
    })
  }

  function renderRailReq() {
    const el = $('railReq')
    if (!state.reqId) {
      el.textContent = '—'
      el.onclick = null
      el.style.cursor = ''
      return
    }
    el.textContent = `req · ${state.reqId}`
    el.title = '点击复制 reqId'
    el.style.cursor = 'pointer'
    el.onclick = () => copyReqId(el)
  }

  async function copyReqId(el) {
    if (!state.reqId) return
    const original = el.textContent
    try {
      await navigator.clipboard.writeText(state.reqId)
      el.textContent = '已复制 ✓'
      el.classList.add('copied')
      setTimeout(() => { el.textContent = original; el.classList.remove('copied') }, 1200)
    } catch {
      const range = document.createRange()
      range.selectNodeContents(el)
      const sel = window.getSelection()
      sel.removeAllRanges()
      sel.addRange(range)
    }
  }

  return {
    bindRailControls,
    copyReqId,
    registerRailHeading,
    renderRailReq,
    resetRailArticle,
    setRailCollapsed,
    showRailArticle,
  }
}
