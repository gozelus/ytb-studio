/**
 * TransformStream that injects an SSE keepalive comment (`: keepalive\n\n`) whenever no data
 * has flowed for intervalMs. Default 15 s is half of Cloudflare's 30 s idle stream timeout.
 */
export function keepaliveTransform(intervalMs = 15_000) {
  const enc = new TextEncoder()
  const keepalive = enc.encode(': keepalive\n\n')
  let timer: ReturnType<typeof setTimeout> | null = null
  let closed = false
  let ctrlRef: TransformStreamDefaultController<Uint8Array> | null = null

  const schedule = () => {
    if (closed) return
    timer = setTimeout(() => {
      if (closed || !ctrlRef) return
      ctrlRef.enqueue(keepalive)
      schedule()
    }, intervalMs)
  }

  return new TransformStream<Uint8Array, Uint8Array>({
    start(controller) { ctrlRef = controller; schedule() },
    transform(chunk, controller) {
      if (timer) { clearTimeout(timer); timer = null }
      controller.enqueue(chunk)
      schedule()
    },
    flush() { closed = true; if (timer) clearTimeout(timer) },
  })
}
