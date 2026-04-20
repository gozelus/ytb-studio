export function createArticleRenderer({ $, state, registerRailHeading, clearStallIndicator }) {
  let currentTurn = null

  function renderEventNow(ev) {
    if (ev.type === '__end') { resetTurn(); ev.finalize(); return }
    const body = $('articleBody')
    removeCaret()

    if (ev.type === 'h2' || ev.type === 'h3') {
      resetTurn()
      clearStallIndicator()
      const node = document.createElement(ev.type)
      node.textContent = ev.text
      node.classList.add('fade-node')
      body.appendChild(node)
      registerRailHeading(node, ev)
      return
    }

    if (ev.type === 'p') {
      clearStallIndicator()
      renderParagraph(body, ev)
    }
  }

  function renderParagraph(body, ev) {
    const speaker = normalizeSpeaker(ev.speaker)
    if (!speaker) {
      resetTurn()
      body.appendChild(createParagraph(ev.text, { className: 'body-para fade-node' }))
      return
    }

    if (!currentTurn || currentTurn.key !== speaker.key || !currentTurn.node.isConnected) {
      currentTurn = createTurn(speaker)
      body.appendChild(currentTurn.node)
      currentTurn.body.appendChild(createParagraph(ev.text, { className: 'turn-paragraph' }))
      return
    }

    currentTurn.body.appendChild(createParagraph(ev.text, { className: 'turn-paragraph fade-node' }))
  }

  function createTurn(speaker) {
    const node = document.createElement('section')
    node.className = 'speaker-turn fade-node'

    const label = document.createElement('div')
    label.className = 'turn-speaker'
    label.textContent = speaker.display

    const body = document.createElement('div')
    body.className = 'turn-body'

    node.append(label, body)
    return { key: speaker.key, node, body }
  }

  function createParagraph(text, { className }) {
    const p = document.createElement('p')
    p.className = className
    p.appendChild(document.createTextNode(text ?? ''))
    const caret = document.createElement('span')
    caret.className = 'caret'
    caret.id = 'liveCaret'
    p.appendChild(caret)
    return p
  }

  function normalizeSpeaker(raw) {
    if (raw === null || raw === undefined) return null
    const display = String(raw).trim().replace(/[：:]+$/u, '')
    if (!display || /^(null|undefined|none|n\/a)$/i.test(display)) return null
    const lower = display.toLowerCase().replace(/\s+/g, ' ')
    return {
      display,
      key: lower,
    }
  }

  function removeCaret() {
    const c = document.getElementById('liveCaret')
    if (c) c.remove()
  }

  function resetTurn() {
    currentTurn = null
  }

  function resetArticleRenderer() {
    resetTurn()
    removeCaret()
  }

  return { renderEventNow, removeCaret, resetArticleRenderer }
}
