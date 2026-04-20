import type { Env } from './env'

export const INVALID_SHARECODE_MESSAGE = '无效的 sharecode'

export function hasValidSharecode(request: Request, env: Env): boolean {
  const expected = normalizeSharecode(env.SHARECODE)
  const actual = readSharecode(request)
  if (!expected || !actual) return false
  return constantTimeEqual(actual, expected)
}

function readSharecode(request: Request): string {
  const direct = normalizeSharecode(request.headers.get('x-sharecode'))
  if (direct) return direct

  const authorization = request.headers.get('authorization') ?? ''
  const match = authorization.match(/^Bearer\s+(.+)$/i)
  return normalizeSharecode(match?.[1])
}

function normalizeSharecode(value?: string | null): string {
  return (value ?? '').trim()
}

function constantTimeEqual(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a)
  const right = new TextEncoder().encode(b)
  let diff = left.length ^ right.length
  const len = Math.max(left.length, right.length)
  for (let i = 0; i < len; i += 1) {
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0)
  }
  return diff === 0
}
