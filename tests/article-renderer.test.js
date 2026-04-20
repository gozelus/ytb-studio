import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createArticleRenderer } from '../public/article-renderer.js'

class FakeText {
  constructor(text) {
    this.text = String(text ?? '')
    this.parentNode = null
    this.isConnected = false
  }

  get textContent() {
    return this.text
  }

  setConnected(isConnected) {
    this.isConnected = isConnected
  }
}

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName.toLowerCase()
    this.childNodes = []
    this.parentNode = null
    this.isConnected = false
    this.className = ''
    this.id = ''
    this.classList = {
      add: (...names) => {
        const set = new Set(this.className.split(/\s+/).filter(Boolean))
        names.forEach(name => set.add(name))
        this.className = [...set].join(' ')
      },
      contains: name => this.className.split(/\s+/).includes(name),
    }
  }

  get children() {
    return this.childNodes.filter(node => node instanceof FakeElement)
  }

  get textContent() {
    return this.childNodes.map(node => node.textContent).join('')
  }

  set textContent(value) {
    this.childNodes.forEach(node => {
      node.parentNode = null
      node.setConnected(false)
    })
    const text = new FakeText(value)
    text.parentNode = this
    text.setConnected(this.isConnected)
    this.childNodes = [text]
  }

  appendChild(node) {
    node.parentNode = this
    node.setConnected(this.isConnected)
    this.childNodes.push(node)
    return node
  }

  append(...nodes) {
    nodes.forEach(node => this.appendChild(node))
  }

  remove() {
    if (!this.parentNode) return
    const siblings = this.parentNode.childNodes
    const index = siblings.indexOf(this)
    if (index >= 0) siblings.splice(index, 1)
    this.parentNode = null
    this.setConnected(false)
  }

  setConnected(isConnected) {
    this.isConnected = isConnected
    this.childNodes.forEach(node => node.setConnected(isConnected))
  }

  findById(id) {
    if (this.id === id) return this
    for (const child of this.childNodes) {
      if (child instanceof FakeElement) {
        const found = child.findById(id)
        if (found) return found
      }
    }
    return null
  }
}

function createFakeDocument(root) {
  return {
    createElement: tagName => new FakeElement(tagName),
    createTextNode: text => new FakeText(text),
    getElementById: id => root.findById(id),
  }
}

function createRendererHarness() {
  const body = new FakeElement('article')
  body.setConnected(true)

  globalThis.document = createFakeDocument(body)

  const registerRailHeading = vi.fn()
  const clearStallIndicator = vi.fn()
  const renderer = createArticleRenderer({
    $: id => {
      if (id !== 'articleBody') throw new Error(`unexpected element id: ${id}`)
      return body
    },
    state: {},
    registerRailHeading,
    clearStallIndicator,
  })

  return { body, renderer, registerRailHeading, clearStallIndicator }
}

let previousDocument

beforeEach(() => {
  previousDocument = globalThis.document
})

afterEach(() => {
  if (previousDocument === undefined) {
    delete globalThis.document
  } else {
    globalThis.document = previousDocument
  }
})

describe('article renderer speaker turns', () => {
  it('groups consecutive paragraphs from the same emitted speaker', () => {
    const { body, renderer } = createRendererHarness()

    renderer.renderEventNow({ type: 'p', speaker: 'Speaker A', text: 'First answer.' })
    renderer.renderEventNow({ type: 'p', speaker: 'Speaker A', text: 'Second answer.' })

    expect(body.children).toHaveLength(1)
    const turn = body.children[0]
    expect(turn.className).toContain('speaker-turn')
    expect(turn.children[0].textContent).toBe('Speaker A')
    expect(turn.children[1].children).toHaveLength(2)
    expect(turn.children[1].children[0].textContent).toBe('First answer.')
    expect(turn.children[1].children[1].textContent).toBe('Second answer.')
  })

  it('starts a new turn after a heading and renders null speakers as body copy', () => {
    const { body, renderer, registerRailHeading } = createRendererHarness()

    renderer.renderEventNow({ type: 'p', speaker: 'Speaker A', text: 'Before heading.' })
    renderer.renderEventNow({ type: 'h3', text: 'A section' })
    renderer.renderEventNow({ type: 'p', speaker: 'Speaker A', text: 'After heading.' })
    renderer.renderEventNow({ type: 'p', speaker: 'null', text: 'Plain paragraph.' })

    expect(body.children).toHaveLength(4)
    expect(body.children[0].className).toContain('speaker-turn')
    expect(body.children[1].tagName).toBe('h3')
    expect(body.children[2].className).toContain('speaker-turn')
    expect(body.children[3].tagName).toBe('p')
    expect(body.children[3].className).toContain('body-para')
    expect(registerRailHeading).toHaveBeenCalledOnce()
  })

  it('trims trailing punctuation from emitted speaker labels', () => {
    const { body, renderer } = createRendererHarness()

    renderer.renderEventNow({ type: 'p', speaker: 'Speaker B:', text: 'What changed?' })

    expect(body.children[0].children[0].textContent).toBe('Speaker B')
  })
})
