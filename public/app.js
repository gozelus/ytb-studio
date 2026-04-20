/**
 * [WHAT]  Front-end state machine for ytb-studio.
 * [WHY]   Entry ES module — no build step, served as static assets.
 *         Orchestrates the full user flow: hero → inspect → generate (SSE) → article.
 * [INVARIANT] Meta alone never opens the article view; reveal starts only when the
 *             first renderable article event arrives.
 *             state.cancelled is set to true before abort() and cleared only at the
 *             entry of a new run (start/retry/regenerate), never inside resetRun().
 */

import { $, hideAllViews, setStatus, showView } from './dom.js'
import { createArticleRenderer } from './article-renderer.js'
import { createArticleTailController } from './article-tail.js'
import { errorMsg } from './error-copy.js'
import { createGeminiWaitUi } from './gemini-wait.js'

const SHARECODE_STORAGE_KEY = 'ytb-sharecode'

// ---------- State ----------
const state = {
  reqId: null,
  aborter: null,
  revealTimer: null,     // setTimeout handle for the reveal→article transition
  articleEnded: false,
  cancelled: false,
  revealDone: false,     // true once reveal animation hands off to articleView
  renderQueue: [],       // body events buffered during reveal
  renderTickHandle: null, // setInterval handle for throttled paragraph rendering
}

const {
  clearPrepHeartbeat,
  setTipToWarm,
  startGeminiWait,
  stopGeminiWait,
  updatePrepHeartbeat,
} = createGeminiWaitUi({ $ })

const articleTail = createArticleTailController({ $ })

const {
  renderEventNow,
  removeCaret,
  resetArticleRenderer,
} = createArticleRenderer({ $, state, registerRailHeading: () => {}, clearStallIndicator })

// ---------- Sharecode gate ----------
let sharecode = ''

initSharecodeGate()

function initSharecodeGate() {
  const fromQuery = takeBootstrappedSharecode() || readSharecodeFromQuery()
  if (fromQuery) {
    sharecode = fromQuery
    writeStoredSharecode(fromQuery)
  } else {
    sharecode = readStoredSharecode()
  }

  $('shareForm').addEventListener('submit', (e) => {
    e.preventDefault()
    const next = $('shareInput').value.trim()
    if (!next) {
      showSharecodeGate('请输入 sharecode')
      return
    }
    sharecode = next
    writeStoredSharecode(next)
    hideSharecodeGate()
  })

  if (sharecode) hideSharecodeGate()
  else showSharecodeGate()
}

function takeBootstrappedSharecode() {
  const value = typeof window.__ytbSharecode === 'string' ? window.__ytbSharecode.trim() : ''
  delete window.__ytbSharecode
  return value
}

function readSharecodeFromQuery() {
  const url = new URL(window.location.href)
  const value = url.searchParams.get('sharecode')?.trim()
  return value || ''
}

function readStoredSharecode() {
  try {
    return (localStorage.getItem(SHARECODE_STORAGE_KEY) ?? '').trim()
  } catch {
    return ''
  }
}

function writeStoredSharecode(value) {
  try {
    localStorage.setItem(SHARECODE_STORAGE_KEY, value)
  } catch {}
}

function clearStoredSharecode() {
  sharecode = ''
  try {
    localStorage.removeItem(SHARECODE_STORAGE_KEY)
  } catch {}
}

function showSharecodeGate(message = '') {
  const gate = $('shareGate')
  gate.hidden = false
  document.body.classList.add('share-locked')
  $('shareError').textContent = message
  $('shareInput').value = ''
  requestAnimationFrame(() => $('shareInput').focus())
}

function hideSharecodeGate() {
  $('shareGate').hidden = true
  document.body.classList.remove('share-locked')
}

function requireSharecode() {
  sharecode = sharecode || readStoredSharecode()
  if (sharecode) return true
  showSharecodeGate()
  return false
}

function apiHeaders() {
  return {
    'content-type': 'application/json',
    'x-sharecode': sharecode,
  }
}

function handleInvalidSharecode(message = '无效的 sharecode') {
  clearStoredSharecode()
  state.cancelled = true
  if (state.aborter) state.aborter.abort()
  $('topbar').classList.remove('in')
  hideAllViews()
  $('hero').classList.remove('out')
  $('url').disabled = false
  $('go').disabled = false
  resetRun()
  showSharecodeGate(message)
}

// ---------- Theme ----------
const savedTheme = localStorage.getItem('ytb-theme')
if (savedTheme === 'light') {
  document.documentElement.classList.add('light')
  $('themeBtn').textContent = '☀'
}
$('themeBtn').addEventListener('click', () => {
  const isLight = document.documentElement.classList.toggle('light')
  $('themeBtn').textContent = isLight ? '☀' : '☾'
  localStorage.setItem('ytb-theme', isLight ? 'light' : 'dark')
})

// ---------- URL validation ----------
function validateUrl(raw) {
  try {
    const u = new URL(raw.trim())
    const host = u.hostname.replace(/^www\.|^m\./, '')
    if (host === 'youtu.be') return /^\/[a-zA-Z0-9_-]{11}$/.test(u.pathname)
    if (host === 'youtube.com') {
      if (u.pathname === '/watch' && u.searchParams.get('v')) return true
      return /^\/(embed|shorts)\/[a-zA-Z0-9_-]{11}(?:[?/]|$)/.test(u.pathname)
    }
    return false
  } catch { return false }
}

// ---------- Submit ----------
$('go').addEventListener('click', () => start())
$('url').addEventListener('keydown', (e) => { if (e.key === 'Enter') start() })

async function start() {
  if (!requireSharecode()) return
  state.cancelled = false
  const url = $('url').value
  const hintErr = $('hintErr')
  if (!validateUrl(url)) { hintErr.textContent = '这不像是 YouTube 链接'; return }
  hintErr.textContent = ''
  resetRun()
  state.cancelled = false
  $('url').disabled = true
  $('go').disabled = true

  $('hero').classList.add('out')
  $('topbar').classList.add('in')
  $('topUrl').textContent = url

  try {
    await runInspect(url)
  } catch (err) {
    showInlineError(err)
  }
}

// ---------- Inspect ----------
async function runInspect(url) {
  showView('prepView')
  setStatus('连接视频')
  const res = await fetch('/api/inspect', {
    method: 'POST',
    headers: apiHeaders(),
    body: JSON.stringify({ url }),
  })
  const data = await res.json()
  state.reqId = data.reqId ?? null
  if (!res.ok) throw { code: data.error ?? 'INTERNAL', message: data.message }

  setStatus('生成中')
  showView('prepView')
  try {
    await runGenerate()
  } catch (err) {
    showInlineError(err)
  }
}

// ---------- Generate ----------
async function runGenerate() {
  state.aborter = new AbortController()
  let res
  try {
    res = await fetch('/api/generate', {
      method: 'POST',
      headers: apiHeaders(),
      body: JSON.stringify({ url: $('url').value }),
      signal: state.aborter.signal,
    })
  } catch (err) {
    if (err.name === 'AbortError' || state.cancelled) return
    throw err
  }
  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => ({ error: 'INTERNAL' }))
    throw { code: data.error ?? 'INTERNAL', message: data.message }
  }
  const streamReqId = res.headers.get('x-req-id')
  if (streamReqId) {
    state.reqId = streamReqId
  }
  setStatus('唤醒 Gemini')
  startGeminiWait()

  await consumeSse(res.body)
}

// ---------- SSE consumer ----------
async function consumeSse(body) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let gotMeta = false
  let enteredArticle = false
  let streamEnded = false
  let metaEv = null

  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let i
      // SSE frames are delimited by double newlines
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, i); buf = buf.slice(i + 2)
        const payload = frame.replace(/^data:\s*/, '')
        if (!payload || payload.startsWith(':')) continue  // skip keepalive lines
        let ev; try { ev = JSON.parse(payload) } catch { continue }
        if (ev.type === 'meta') {
          gotMeta = true
          metaEv = ev
          setStatus('生成正文')
          continue
        }
        if (!enteredArticle && ev.type === 'heartbeat') {
          articleTail.handleHeartbeat(ev)
          updatePrepHeartbeat(ev.idleSeconds ?? 0, ev.stage, ev)
          continue
        }
        if (!enteredArticle && (ev.type === 'h2' || ev.type === 'h3' || ev.type === 'p')) {
          enteredArticle = true
          stopGeminiWait()
          clearPrepHeartbeat()
          setStatus('生成中')
          enterArticle(metaEv ?? fallbackMeta())
          renderEvent(ev)
          continue
        }
        if (!enteredArticle && ev.type === 'error') {
          state.articleEnded = true  // prevent GEMINI_STREAM_DROP throw at loop exit
          showInlineError({ code: ev.code ?? 'INTERNAL', message: ev.message })
          return
        }
        if (!enteredArticle && ev.type === 'end') {
          state.articleEnded = true
          showInlineError({ code: 'EMPTY_ARTICLE' })
          return
        }
        if (ev.type === 'end') streamEnded = true
        renderEvent(ev)
      }
    }
  } catch (err) {
    if (state.cancelled) return
    if (!enteredArticle) throw err
    showInterrupt('GEMINI_STREAM_DROP')
    return
  }

  if (state.cancelled) return
  if (!enteredArticle) throw { code: gotMeta ? 'EMPTY_ARTICLE' : 'GEMINI_STREAM_DROP' }
  if (!streamEnded && !state.articleEnded) showInterrupt('GEMINI_STREAM_DROP')
}

// ---------- Article ----------
function enterArticle(metaEv) {
  const title = metaEv.title || '(未命名)'
  const metaParts = [metaEv.subtitle, fmtDur(metaEv.durationSec)].filter(Boolean)
  $('revealH1').textContent = title
  $('revealSub').textContent = metaEv.subtitle ?? ''
  $('articleH1').textContent = title
  $('articleMeta').textContent = metaParts.join(' · ')
  document.title = title
  articleTail.start()
  hideAllViews()
  const rv = $('revealView')
  // Reset animation state so replay works (CSS keyframes won't restart if .play already present)
  rv.classList.remove('play')
  void rv.offsetWidth
  rv.classList.remove('out')
  requestAnimationFrame(() => rv.classList.add('play'))
  state.revealTimer = setTimeout(() => {
    state.revealTimer = null
    rv.classList.add('out')
    $('articleView').classList.remove('out')
    $('articleView').classList.add('show')
    state.revealDone = true
    startRenderTick()
  }, 3200)
}

function fallbackMeta() {
  return { title: '正在生成文章', subtitle: '', durationSec: null }
}

function renderEvent(ev) {
  if (ev.type === 'heartbeat') {
    articleTail.handleHeartbeat(ev)
    updateStallIndicator(ev.idleSeconds ?? 0)
    if ((ev.idleSeconds ?? 0) >= 20) setTipToWarm()
    return
  }
  if (state.articleEnded && ev.type !== 'end') return
  if (ev.type === 'error') { showInterrupt(ev.code ?? 'INTERNAL', ev.message); return }
  if (ev.type === 'end') {
    if (state.articleEnded) return
    state.articleEnded = true
    const finalize = () => {
      removeCaret(); clearStallIndicator(); setStatus('完成')
      articleTail.complete()
      stopRenderTick(); finishRun()
    }
    if (state.renderQueue.length === 0 && state.revealDone) finalize()
    else state.renderQueue.push({ type: '__end', finalize })
    return
  }
  // h2/h3/p: buffer during reveal, drain via tick once revealDone
  articleTail.markContentEvent(ev)
  state.renderQueue.push(ev)
  if (state.revealDone) startRenderTick()
}

function startRenderTick() {
  if (state.renderTickHandle) return
  state.renderTickHandle = setInterval(() => {
    if (state.renderQueue.length === 0) return
    renderEventNow(state.renderQueue.shift())
  }, 350)
}

function stopRenderTick() {
  if (state.renderTickHandle) { clearInterval(state.renderTickHandle); state.renderTickHandle = null }
}

// ---------- Stall indicator ----------
function clearStallIndicator() {
  const el = $('stallIndicator')
  el.hidden = true
  el.className = 'stall-indicator'
  el.textContent = ''
}

function updateStallIndicator(s) {
  const el = $('stallIndicator')
  if (s < 20) { el.hidden = true; return }
  el.hidden = false
  el.textContent = ''
  const pulse = document.createElement('span'); pulse.className = 'stall-pulse'
  if (s >= 90) {
    el.className = 'stall-indicator stall-warm stall-critical'
    const row = document.createElement('div')
    row.className = 'stall-row'
    const txt = document.createElement('span')
    txt.textContent = `⚠ Gemini 已静默 ${s}s，可能生成堵塞`
    row.append(pulse, txt)
    const actions = document.createElement('div'); actions.className = 'stall-actions'
    const keepBtn = document.createElement('button')
    keepBtn.className = 'btn btn-ghost'; keepBtn.textContent = '继续等待'
    keepBtn.addEventListener('click', clearStallIndicator)
    const abortBtn = document.createElement('button')
    abortBtn.className = 'btn btn-primary'; abortBtn.textContent = '中止并保留片段'
    abortBtn.addEventListener('click', () => {
      state.cancelled = true
      if (state.aborter) state.aborter.abort()
      clearStallIndicator()
      setStatus('⚠ 已中断', true)
      articleTail.interrupt()
      removeCaret()
      finishRun()
    })
    actions.append(keepBtn, abortBtn)
    el.append(row, actions)
  } else {
    el.className = 'stall-indicator' + (s >= 45 ? ' stall-warm' : '')
    const txt = document.createElement('span')
    txt.textContent = s >= 45
      ? `Gemini 仍在处理（视频较长，请再等等） · ${s}s`
      : `Gemini 正在思考 · ${s}s`
    el.append(pulse, txt)
  }
}

// ---------- Reset ----------
function resetRun() {
  // Cancel any in-flight reveal→article transition timer
  if (state.revealTimer) { clearTimeout(state.revealTimer); state.revealTimer = null }
  state.reqId = null
  state.articleEnded = false
  state.revealDone = false
  state.renderQueue = []
  resetArticleRenderer()
  stopRenderTick()
  state.aborter = null
  $('hintErr').textContent = ''
  $('articleBody').innerHTML = ''
  articleTail.reset()
  $('prepView').querySelectorAll('.interrupt').forEach(n => n.remove())
  clearStallIndicator()
  stopGeminiWait()
  $('newRunBtn').hidden = true
  // Reset reveal/article classes so replay works cleanly
  $('revealView').classList.remove('play')
  $('articleView').classList.remove('show')
  $('statusPill').classList.remove('err')
  setStatus('idle')
}

// ---------- Interrupt block builder ----------
function ensureInlineActions(container, buttons) {
  container.querySelectorAll('.interrupt').forEach(n => n.remove())
  const box = document.createElement('div')
  box.className = 'interrupt'
  const label = document.createElement('div'); label.className = 'label-err'; label.textContent = '—— 中断'
  const msg = document.createElement('div'); msg.className = 'msg'; msg.textContent = buttons.msg
  const actions = document.createElement('div'); actions.className = 'actions'
  for (const b of buttons.list) {
    const btn = document.createElement('button')
    btn.className = 'btn ' + (b.primary ? 'btn-primary' : 'btn-ghost')
    btn.textContent = b.text
    btn.addEventListener('click', b.onClick)
    actions.appendChild(btn)
  }
  box.append(label, msg, actions)
  if (state.reqId) {
    const reqLine = document.createElement('div')
    reqLine.className = 'interrupt-req'
    reqLine.textContent = `req · ${state.reqId}`
    reqLine.title = '点击复制'
    reqLine.style.cursor = 'pointer'
    reqLine.addEventListener('click', () => copyReqId(reqLine))
    box.appendChild(reqLine)
  }
  container.appendChild(box)
  return box
}

async function copyReqId(el) {
  if (!state.reqId) return
  const original = el.textContent
  try {
    await navigator.clipboard.writeText(state.reqId)
    el.textContent = '已复制'
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

// ---------- Prep-phase error ----------
function showInlineError(err) {
  if (err.code === 'INVALID_SHARECODE') {
    handleInvalidSharecode(err.message || '无效的 sharecode')
    return
  }
  stopGeminiWait()
  setStatus('⚠ 已中断', true)
  const msg = err.message ? `${errorMsg(err.code)} · ${err.message}` : errorMsg(err.code)
  const host = $('prepView').querySelector('.prep-col')
  if (!host) return
  const actionList = [
    { text: '换视频', onClick: backToHero },
    { text: '重试', primary: true, onClick: retry },
  ]
  ensureInlineActions(host, { msg, list: actionList })
}

// ---------- Stream-phase interrupt ----------
function showInterrupt(code, message) {
  if (state.cancelled) return
  state.articleEnded = true
  setStatus('⚠ 已中断', true)
  removeCaret()
  articleTail.interrupt()
  finishRun()
  const body = $('articleBody')
  const estimatedPct = estimateProgress()
  ensureInlineActions(body, {
    msg: `${errorMsg(code)}（已生成约 ${estimatedPct}%）${message ? ' · ' + message : ''}`,
    list: [
      { text: '保留此片段', onClick: dismissInterrupt },
      { text: '重新生成完整版', primary: true, onClick: regenerate },
    ],
  })
}

function estimateProgress() {
  const paras = $('articleBody').querySelectorAll('p,h2,h3').length
  return Math.min(85, 10 + paras * 3)
}

// ---------- Run completion ----------
function finishRun() {
  $('url').disabled = false
  $('go').disabled = false
  $('newRunBtn').hidden = false
}

$('newRunBtn').addEventListener('click', () => {
  $('url').value = ''
  backToHero()
})

// ---------- Error action handlers ----------
function backToHero() {
  // Set cancelled before abort() so any async catch in-flight sees it immediately
  state.cancelled = true
  if (state.aborter) state.aborter.abort()
  $('topbar').classList.remove('in')
  hideAllViews()
  $('hero').classList.remove('out')
  $('url').disabled = false; $('go').disabled = false
  resetRun()  // does NOT touch cancelled — flag stays true until next start()/retry()/regenerate()
}

function retry() {
  state.cancelled = false
  resetRun()
  runInspect($('url').value).catch(showInlineError)
}

function regenerate() {
  state.cancelled = false
  resetRun()
  $('articleView').classList.add('out')
  showView('prepView')
  runInspect($('url').value).catch(showInlineError)
}

function dismissInterrupt() {
  $('articleBody').querySelectorAll('.interrupt').forEach(n => n.remove())
  setStatus('已保留片段')
}

// ---------- Utils ----------
function fmtDur(sec) {
  if (!sec) return ''
  const m = Math.floor(sec / 60), s = sec % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}
