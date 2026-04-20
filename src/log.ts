/**
 * [WHAT] Thin structured-logging helpers: JSON lines with ISO timestamp.
 * [WHY]  Centralises log format so every module emits consistent, grep-friendly output.
 * [INVARIANT] logError uses console.log (not console.error) — Workers logplex routes all
 *             console output to the same stream regardless of level.
 */

/** Returns a 6-char hex request ID for correlating log lines within a single request. */
export function newReqId(): string {
  const bytes = new Uint8Array(4)
  crypto.getRandomValues(bytes)
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 6)
}

/** Emits a structured JSON log line to stdout with an ISO timestamp. */
export function log(fields: Record<string, unknown>) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...fields }))
}

/** Same as log() but injects level:'error' for alerting filters. */
export function logError(fields: Record<string, unknown>) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level: 'error', ...fields }))
}
