export function newReqId(): string {
  const bytes = new Uint8Array(4)
  crypto.getRandomValues(bytes)
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 6)
}

export function log(fields: Record<string, unknown>) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...fields }))
}

export function logError(fields: Record<string, unknown>) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level: 'error', ...fields }))
}
