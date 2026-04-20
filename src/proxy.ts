/**
 * [WHAT] SOCKS5 proxy client for Cloudflare Workers, built on workerd TCP sockets.
 * [WHY]  CF edge IPs are blocked by YouTube; routing through a residential static-IP
 *        SOCKS5 proxy (e.g. iproyal) bypasses the 429/empty-playerResponse block.
 * [INVARIANT] fetchViaSocks5 tries each URL in the pool sequentially (no parallel
 *             racing — iproyal charges per connection). DNS resolution happens on the
 *             proxy side (socks5h), so CF never resolves the target hostname.
 */

import { connect } from 'cloudflare:sockets'

export interface ProxyConfig {
  urls: string[]
}

export function loadProxyConfig(env: { PROXY_URLS?: string; PROXY_URL?: string }): ProxyConfig | null {
  const raw = env.PROXY_URLS ?? env.PROXY_URL ?? ''
  const urls = raw.split('\n').map(s => s.trim()).filter(s => s.startsWith('socks5'))
  return urls.length > 0 ? { urls } : null
}

/** Injectable TCP connect function — defaults to cloudflare:sockets connect; override in tests. */
export type ConnectFn = (address: SocketAddress, options?: SocketOptions) => Socket

/**
 * Makes an HTTP GET via SOCKS5 proxy. Tries each endpoint in order; moves to the next
 * on connection/handshake failure. Throws if all endpoints fail.
 * init headers are forwarded (except Accept-Encoding — not requesting compression
 * avoids the need to decompress chunked gzip in the manual HTTP parser).
 * opts._connect is injectable for unit tests; production code uses cloudflare:sockets connect.
 */
export async function fetchViaSocks5(
  targetUrl: string,
  config: ProxyConfig,
  init: { headers?: Record<string, string>; signal?: AbortSignal } = {},
  opts: { logFn?: (msg: string) => void; _connect?: ConnectFn } = {},
): Promise<Response> {
  const connectFn = opts._connect ?? connect
  let lastErr: unknown
  for (const proxyUrl of config.urls) {
    const proxyHost = new URL(proxyUrl).hostname + ':' + (new URL(proxyUrl).port || '1080')
    try {
      opts.logFn?.(`proxy.try host=${proxyHost}`)
      const res = await socks5Fetch(new URL(targetUrl), proxyUrl, init, connectFn)
      opts.logFn?.(`proxy.ok host=${proxyHost} status=${res.status}`)
      return res
    } catch (err) {
      opts.logFn?.(`proxy.fail host=${proxyHost} err=${String(err).slice(0, 100)}`)
      lastErr = err
    }
  }
  throw lastErr ?? new Error('PROXY: all endpoints failed')
}

async function socks5Fetch(
  target: URL,
  proxyUrl: string,
  init: { headers?: Record<string, string>; signal?: AbortSignal },
  connectFn: ConnectFn,
): Promise<Response> {
  const proxy = new URL(proxyUrl)
  const targetPort = target.port ? Number(target.port) : (target.protocol === 'https:' ? 443 : 80)
  const user = decodeURIComponent(proxy.username)
  const pass = decodeURIComponent(proxy.password)

  const socket = connectFn(
    { hostname: proxy.hostname, port: Number(proxy.port) || 1080 },
    { allowHalfOpen: true },
  )

  try {
    await socks5Handshake(socket, target.hostname, targetPort, user, pass)

    // After CONNECT succeeds, upgrade the tunnel to TLS.
    // The proxy forwards TLS ClientHello to the target, so startTls operates end-to-end.
    const tls = socket.startTls({ expectedServerHostname: target.hostname })

    // Build HTTP/1.1 request. Omit Accept-Encoding to get plain-text (not gzip),
    // avoiding decompression in the manual response parser below.
    const path = target.pathname + (target.search ?? '')
    const headers: Record<string, string> = {
      'Host': target.hostname,
      'Connection': 'close',
      'Accept': 'text/html,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    }
    if (init.headers) {
      for (const [k, v] of Object.entries(init.headers)) {
        if (k.toLowerCase() !== 'accept-encoding') headers[k] = v
      }
    }
    const headerLines = Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\r\n')
    const reqBytes = new TextEncoder().encode(`GET ${path} HTTP/1.1\r\n${headerLines}\r\n\r\n`)

    const writer = tls.writable.getWriter()
    await writer.write(reqBytes)
    writer.releaseLock()

    return await readHttpResponse(tls.readable)
  } catch (err) {
    await socket.close().catch(() => {})
    throw err
  }
}

/** RFC 1928 + RFC 1929 SOCKS5 handshake: greeting → username/password auth → CONNECT. */
async function socks5Handshake(
  socket: Socket,
  hostname: string,
  port: number,
  user: string,
  pass: string,
): Promise<void> {
  const writer = socket.writable.getWriter()
  const reader = socket.readable.getReader() as ReadableStreamDefaultReader<Uint8Array>
  const enc = new TextEncoder()

  try {
    // Greeting: SOCKS5, 2 auth methods (NO_AUTH=0x00, USERNAME/PASSWORD=0x02)
    await writer.write(new Uint8Array([0x05, 0x02, 0x00, 0x02]))
    const choice = await readExact(reader, 2)
    if (choice[0] !== 0x05) throw new Error(`SOCKS5: bad version ${choice[0]}`)
    if (choice[1] !== 0x02) throw new Error(`SOCKS5: unsupported auth method ${choice[1]}`)

    // Username/password authentication (RFC 1929)
    const u = enc.encode(user), p = enc.encode(pass)
    const authMsg = new Uint8Array([0x01, u.length, ...u, p.length, ...p])
    await writer.write(authMsg)
    const authResp = await readExact(reader, 2)
    if (authResp[1] !== 0x00) throw new Error(`SOCKS5: auth rejected status=${authResp[1]}`)

    // CONNECT request with DOMAINNAME address type (0x03) — proxy resolves DNS (socks5h)
    const hostBytes = enc.encode(hostname)
    const connectMsg = new Uint8Array([
      0x05, 0x01, 0x00, 0x03,     // SOCKS5 CONNECT DOMAINNAME
      hostBytes.length, ...hostBytes,
      (port >> 8) & 0xff, port & 0xff,
    ])
    await writer.write(connectMsg)

    // Response: ver(1) + rep(1) + rsv(1) + atyp(1) = 4 bytes minimum
    const hdr = await readExact(reader, 4)
    if (hdr[1] !== 0x00) throw new Error(`SOCKS5: CONNECT refused rep=${hdr[1]}`)

    // Consume the bound address (we don't use it, but must read it to clear the buffer)
    const atyp = hdr[3]!
    if (atyp === 0x01) await readExact(reader, 6)         // IPv4 (4) + port (2)
    else if (atyp === 0x03) {
      const lenByte = await readExact(reader, 1)
      await readExact(reader, (lenByte[0] ?? 0) + 2)       // domain + port
    } else if (atyp === 0x04) await readExact(reader, 18)  // IPv6 (16) + port (2)
  } finally {
    reader.releaseLock()
    writer.releaseLock()
  }
}

/**
 * Reads exactly n bytes from a stream reader. Each chunk read from the underlying
 * stream is consumed immediately; no data is buffered past the requested n bytes.
 * In SOCKS5 the proxy sends each response only after its corresponding request,
 * so no pre-fetching of "TLS-layer" bytes occurs here.
 */
async function readExact(reader: ReadableStreamDefaultReader<Uint8Array>, n: number): Promise<Uint8Array> {
  const out = new Uint8Array(n)
  let filled = 0
  while (filled < n) {
    const { value, done } = await reader.read()
    if (done) throw new Error('SOCKS5: stream closed before reading enough bytes')
    const need = n - filled
    const take = Math.min(value.length, need)
    out.set(value.subarray(0, take), filled)
    filled += take
    // If value had extra bytes beyond what we need, they are silently dropped.
    // In SOCKS5 this does not happen: the proxy never pre-sends TLS data.
  }
  return out
}

/** Reads the entire HTTP/1.1 response from a readable stream and returns a Response object. */
async function readHttpResponse(readable: ReadableStream<Uint8Array>): Promise<Response> {
  const reader = (readable as ReadableStream<Uint8Array>).getReader() as ReadableStreamDefaultReader<Uint8Array>
  const chunks: Uint8Array[] = []
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  const total = chunks.reduce((s, c) => s + c.length, 0)
  const raw = new Uint8Array(total)
  let off = 0; for (const c of chunks) { raw.set(c, off); off += c.length }

  const dec = new TextDecoder('utf-8', { fatal: false })

  // Find header/body split (\r\n\r\n)
  let sep = -1
  for (let i = 0; i < raw.length - 3; i++) {
    if (raw[i] === 0x0d && raw[i+1] === 0x0a && raw[i+2] === 0x0d && raw[i+3] === 0x0a) {
      sep = i; break
    }
  }
  if (sep === -1) throw new Error('PROXY: no \\r\\n\\r\\n in HTTP response')

  const headerText = dec.decode(raw.subarray(0, sep))
  const bodyBytes = raw.subarray(sep + 4)

  // Parse status line and headers
  const [statusLine, ...headerLines] = headerText.split('\r\n')
  const statusMatch = (statusLine ?? '').match(/^HTTP\/1\.\d (\d+)/)
  const status = statusMatch ? Number(statusMatch[1]) : 0

  const headers = new Headers()
  for (const line of headerLines) {
    const colon = line.indexOf(':')
    if (colon > 0) headers.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim())
  }

  // Decode body: chunked or raw
  const te = headers.get('transfer-encoding') ?? ''
  const bodyText = te.includes('chunked') ? decodeChunked(bodyBytes) : dec.decode(bodyBytes)

  return new Response(bodyText, { status, headers })
}

/** Decodes HTTP/1.1 chunked transfer encoding from raw bytes. */
function decodeChunked(data: Uint8Array): string {
  const dec = new TextDecoder('utf-8', { fatal: false })
  let result = ''
  let pos = 0

  while (pos < data.length) {
    // Find end of chunk-size line (\r\n)
    let lineEnd = pos
    while (lineEnd < data.length - 1 && !(data[lineEnd] === 0x0d && data[lineEnd + 1] === 0x0a)) lineEnd++
    if (lineEnd >= data.length - 1) break

    const sizeHex = dec.decode(data.subarray(pos, lineEnd)).split(';')[0]?.trim() ?? ''
    const chunkSize = parseInt(sizeHex, 16)
    if (isNaN(chunkSize) || chunkSize === 0) break

    pos = lineEnd + 2
    if (pos + chunkSize > data.length) break
    result += dec.decode(data.subarray(pos, pos + chunkSize))
    pos += chunkSize + 2  // skip trailing \r\n
  }
  return result
}
