/**
 * Unit tests for src/proxy.ts.
 * All tests are offline — no real network connections.
 * The SOCKS5 byte-assembly tests inject a fake TCP socket via opts._connect.
 */

import { describe, it, expect, vi } from 'vitest'
import { loadProxyConfig, fetchViaSocks5 } from '../src/proxy'
import type { ConnectFn } from '../src/proxy'

// ── loadProxyConfig ───────────────────────────────────────────────────────────

describe('loadProxyConfig', () => {
  it('returns null when no proxy vars are set', () => {
    expect(loadProxyConfig({})).toBeNull()
  })

  it('parses PROXY_URLS (newline-separated)', () => {
    const cfg = loadProxyConfig({
      PROXY_URLS: 'socks5h://u:p@host1:1234\nsocks5h://u:p@host2:1234',
    })
    expect(cfg?.urls).toHaveLength(2)
    expect(cfg?.urls[0]).toBe('socks5h://u:p@host1:1234')
    expect(cfg?.urls[1]).toBe('socks5h://u:p@host2:1234')
  })

  it('parses PROXY_URL (single endpoint)', () => {
    const cfg = loadProxyConfig({ PROXY_URL: 'socks5h://u:p@host:1234' })
    expect(cfg?.urls).toHaveLength(1)
  })

  it('PROXY_URLS takes precedence over PROXY_URL', () => {
    const cfg = loadProxyConfig({
      PROXY_URLS: 'socks5h://u:p@h1:1\nsocks5h://u:p@h2:2',
      PROXY_URL: 'socks5h://u:p@other:3',
    })
    expect(cfg?.urls).toHaveLength(2)
    expect(cfg?.urls[0]).toContain('h1')
  })

  it('filters out non-socks5 URLs', () => {
    const cfg = loadProxyConfig({
      PROXY_URLS: 'http://host:1234\nsocks5h://u:p@host2:1234',
    })
    expect(cfg?.urls).toHaveLength(1)
    expect(cfg?.urls[0]).toContain('socks5h')
  })

  it('returns null when all URLs are filtered out', () => {
    expect(loadProxyConfig({ PROXY_URLS: 'http://host:1234' })).toBeNull()
  })

  it('trims whitespace from individual URLs', () => {
    const cfg = loadProxyConfig({ PROXY_URLS: '  socks5h://u:p@host:1234  ' })
    expect(cfg?.urls[0]).toBe('socks5h://u:p@host:1234')
  })
})

// ── SOCKS5 handshake byte-assembly ────────────────────────────────────────────
//
// Each test injects a fake TCP socket via opts._connect. The socket's readable
// provides scripted server responses one chunk at a time; the writable captures
// every byte the client sends. We then assert on the captured bytes.
//
// The carry-over buffer tests below additionally verify that coalesced chunks
// and 1-byte chunks are handled correctly without data loss.

/** Server responses for a successful IPv4-bound CONNECT handshake. */
function socks5ServerChunks(): Uint8Array[] {
  return [
    new Uint8Array([0x05, 0x02]),              // greeting: choose USERNAME/PASSWORD (0x02)
    new Uint8Array([0x01, 0x00]),              // auth: success (0x00)
    new Uint8Array([0x05, 0x00, 0x00, 0x01]), // CONNECT: success, atyp=IPv4
    new Uint8Array([127, 0, 0, 1, 0, 80]),     // bound addr (IPv4 = 4 bytes + port = 2 bytes)
  ]
}

function makeChunkedReadable(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0
  return new ReadableStream<Uint8Array>({
    pull(ctrl) {
      if (i < chunks.length) ctrl.enqueue(chunks[i++])
    },
  })
}

interface MockSocketResult {
  connectFn: ConnectFn
  /** Bytes written to the SOCKS5 TCP socket (pre-TLS) */
  written: Uint8Array[]
  /** Bytes written to the TLS socket (HTTP request) */
  tlsWritten: Uint8Array[]
}

function makeMockSocket(
  serverChunks: Uint8Array[],
  httpResponse = 'HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok',
): MockSocketResult {
  const written: Uint8Array[] = []
  const tlsWritten: Uint8Array[] = []

  const tlsSocket = {
    get readable() {
      const enc = new TextEncoder()
      return new ReadableStream<Uint8Array>({
        start(ctrl) { ctrl.enqueue(enc.encode(httpResponse)); ctrl.close() },
      })
    },
    get writable() {
      return new WritableStream<Uint8Array>({ write(c) { tlsWritten.push(new Uint8Array(c)) } })
    },
    startTls: () => { throw new Error('nested TLS') },
    close: vi.fn().mockResolvedValue(undefined),
  }

  const socket = {
    get readable() { return makeChunkedReadable(serverChunks) },
    get writable() {
      return new WritableStream<Uint8Array>({ write(c) { written.push(new Uint8Array(c)) } })
    },
    startTls: vi.fn().mockReturnValue(tlsSocket),
    close: vi.fn().mockResolvedValue(undefined),
    get closed() { return Promise.resolve() },
    get opened() { return Promise.resolve({ remoteAddress: '', localAddress: '' }) },
    get upgraded() { return false as const },
    get secureTransport() { return 'off' as const },
  }

  const connectFn: ConnectFn = vi.fn().mockReturnValue(socket) as unknown as ConnectFn

  return { connectFn, written, tlsWritten }
}

describe('SOCKS5 handshake byte assembly', () => {
  const config = { urls: ['socks5h://alice:s3cr3t@proxy.test:1080'] }

  it('sends correct SOCKS5 greeting (05 02 00 02)', async () => {
    const { connectFn, written } = makeMockSocket(socks5ServerChunks())
    await fetchViaSocks5('https://www.youtube.com/watch?v=abc', config, {}, { _connect: connectFn })

    // First write must be the 4-byte greeting
    const greeting = written[0]
    expect(greeting).toBeDefined()
    expect(Array.from(greeting!)).toEqual([0x05, 0x02, 0x00, 0x02])
  })

  it('sends correct USERNAME/PASSWORD auth (RFC 1929)', async () => {
    const { connectFn, written } = makeMockSocket(socks5ServerChunks())
    await fetchViaSocks5('https://www.youtube.com/watch?v=abc', config, {}, { _connect: connectFn })

    // Second write is the auth message
    const auth = written[1]
    expect(auth).toBeDefined()
    const enc = new TextEncoder()
    const user = enc.encode('alice')
    const pass = enc.encode('s3cr3t')
    const expected = new Uint8Array([0x01, user.length, ...user, pass.length, ...pass])
    expect(Array.from(auth!)).toEqual(Array.from(expected))
  })

  it('sends correct CONNECT request with DOMAINNAME (03) address type', async () => {
    const { connectFn, written } = makeMockSocket(socks5ServerChunks())
    await fetchViaSocks5('https://www.youtube.com/watch?v=abc', config, {}, { _connect: connectFn })

    // Third write is the CONNECT request
    const connectMsg = written[2]
    expect(connectMsg).toBeDefined()
    expect(connectMsg![0]).toBe(0x05) // SOCKS version 5
    expect(connectMsg![1]).toBe(0x01) // CMD = CONNECT
    expect(connectMsg![2]).toBe(0x00) // RSV
    expect(connectMsg![3]).toBe(0x03) // ATYP = DOMAINNAME (socks5h: proxy resolves DNS)

    const domainLen = connectMsg![4]
    const domain = new TextDecoder().decode(connectMsg!.slice(5, 5 + domainLen!))
    expect(domain).toBe('www.youtube.com')

    // Port 443 for https
    const portHi = connectMsg![5 + domainLen!]
    const portLo = connectMsg![5 + domainLen! + 1]
    expect((portHi! << 8) | portLo!).toBe(443)
  })

  it('passes expectedServerHostname to startTls', async () => {
    const { connectFn, written: _ } = makeMockSocket(socks5ServerChunks())
    const sock = (connectFn as ReturnType<typeof vi.fn>).mock.results[0]

    await fetchViaSocks5('https://www.youtube.com/watch?v=abc', config, {}, { _connect: connectFn })

    const mockSocket = (connectFn as ReturnType<typeof vi.fn>).mock.results[0]?.value
    expect(mockSocket?.startTls).toHaveBeenCalledWith({ expectedServerHostname: 'www.youtube.com' })
  })

  it('sends GET request over TLS after handshake', async () => {
    const { connectFn, tlsWritten } = makeMockSocket(socks5ServerChunks())
    await fetchViaSocks5(
      'https://www.youtube.com/watch?v=abc',
      config,
      { headers: { 'user-agent': 'test-ua' } },
      { _connect: connectFn },
    )

    const httpReq = new TextDecoder().decode(
      tlsWritten.reduce((a, b) => { const r = new Uint8Array(a.length + b.length); r.set(a); r.set(b, a.length); return r }, new Uint8Array(0))
    )
    expect(httpReq).toContain('GET /watch?v=abc HTTP/1.1')
    expect(httpReq).toContain('Host: www.youtube.com')
    expect(httpReq).toContain('user-agent: test-ua')
    // accept-encoding must be stripped (proxy path uses plain-text response)
    expect(httpReq).not.toContain('accept-encoding')
  })

  it('returns parsed HTTP response status', async () => {
    const { connectFn } = makeMockSocket(
      socks5ServerChunks(),
      'HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n',
    )
    const res = await fetchViaSocks5('https://example.com/', config, {}, { _connect: connectFn })
    expect(res.status).toBe(404)
  })
})

describe('fetchViaSocks5 error handling', () => {
  const config = { urls: ['socks5h://u:p@proxy1:1080', 'socks5h://u:p@proxy2:1080'] }

  it('falls back to next endpoint when first socket throws', async () => {
    let calls = 0
    const connectFn: ConnectFn = vi.fn().mockImplementation((() => {
      calls++
      if (calls === 1) throw new Error('connection refused')
      // Second endpoint succeeds
      return makeMockSocket(socks5ServerChunks()).connectFn()
    }) as unknown as ConnectFn)

    // connectFn for second call comes from a new mock
    const { connectFn: goodConnect } = makeMockSocket(socks5ServerChunks())
    let callCount = 0
    const combinedConnect: ConnectFn = vi.fn().mockImplementation(((...args) => {
      callCount++
      if (callCount === 1) throw new Error('connection refused')
      return (goodConnect as ReturnType<typeof vi.fn>)(...args)
    }) as unknown as ConnectFn)

    const res = await fetchViaSocks5('https://example.com/', config, {}, { _connect: combinedConnect })
    expect(res.status).toBe(200)
    expect(callCount).toBe(2)
  })

  it('throws after all endpoints fail', async () => {
    const connectFn: ConnectFn = vi.fn().mockImplementation(() => {
      throw new Error('all down')
    }) as unknown as ConnectFn

    await expect(
      fetchViaSocks5('https://example.com/', config, {}, { _connect: connectFn })
    ).rejects.toThrow('all down')
  })

  it('rejects on SOCKS5 auth failure', async () => {
    // Server rejects auth (status byte != 0x00)
    const badAuthChunks = [
      new Uint8Array([0x05, 0x02]),  // greeting ok
      new Uint8Array([0x01, 0xff]),  // auth rejected
    ]
    const { connectFn } = makeMockSocket(badAuthChunks)
    await expect(
      fetchViaSocks5('https://example.com/', config, {}, { _connect: connectFn })
    ).rejects.toThrow(/auth rejected/)
  })

  it('rejects on SOCKS5 CONNECT failure (rep != 0x00)', async () => {
    const blockedChunks = [
      new Uint8Array([0x05, 0x02]),              // greeting ok
      new Uint8Array([0x01, 0x00]),              // auth ok
      new Uint8Array([0x05, 0x05, 0x00, 0x01]), // CONNECT refused (rep=0x05 = Connection refused)
      new Uint8Array([0, 0, 0, 0, 0, 0]),        // bound addr (consumed for IPv4 even on failure)
    ]
    const { connectFn } = makeMockSocket(blockedChunks)
    await expect(
      fetchViaSocks5('https://example.com/', config, {}, { _connect: connectFn })
    ).rejects.toThrow(/CONNECT refused/)
  })
})

// ── carry-over buffer (coalesced server chunks) ───────────────────────────────
//
// Real proxies may coalesce responses: e.g. greeting + auth in a single TCP segment.
// readExact must save excess bytes and replay them on the next call, not drop them.

describe('SOCKS5 carry-over buffer', () => {
  const config = { urls: ['socks5h://alice:s3cr3t@proxy.test:1080'] }

  it('handles greeting + auth response coalesced into one chunk', async () => {
    // Server sends [05 02] greeting and [01 00] auth in a single read() chunk
    const coalescedChunks = [
      new Uint8Array([0x05, 0x02, 0x01, 0x00]), // greeting(2) + auth(2) merged
      new Uint8Array([0x05, 0x00, 0x00, 0x01]), // CONNECT: success, atyp=IPv4
      new Uint8Array([127, 0, 0, 1, 0, 80]),    // bound addr
    ]
    const { connectFn } = makeMockSocket(coalescedChunks)
    const res = await fetchViaSocks5(
      'https://www.youtube.com/watch?v=abc', config, {}, { _connect: connectFn },
    )
    expect(res.status).toBe(200)
  })

  it('handles all SOCKS5 responses coalesced into one giant chunk', async () => {
    // Everything: greeting(2) + auth(2) + connect_hdr(4) + bound_ipv4(6) = 14 bytes
    const all = new Uint8Array([
      0x05, 0x02,             // greeting
      0x01, 0x00,             // auth ok
      0x05, 0x00, 0x00, 0x01, // CONNECT ok, atyp=IPv4
      127, 0, 0, 1, 0, 80,    // bound addr
    ])
    const { connectFn } = makeMockSocket([all])
    const res = await fetchViaSocks5(
      'https://www.youtube.com/watch?v=abc', config, {}, { _connect: connectFn },
    )
    expect(res.status).toBe(200)
  })

  it('handles server responses arriving 1 byte at a time', async () => {
    // Worst case: each byte is a separate chunk
    const bytes = [0x05, 0x02, 0x01, 0x00, 0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 80]
    const oneByteChunks = bytes.map(b => new Uint8Array([b]))
    const { connectFn } = makeMockSocket(oneByteChunks)
    const res = await fetchViaSocks5(
      'https://www.youtube.com/watch?v=abc', config, {}, { _connect: connectFn },
    )
    expect(res.status).toBe(200)
  })
})
