export interface Env {
  GEMINI_API_KEY: string
  ASSETS: Fetcher
  GEMINI_MODEL?: string
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname.startsWith('/api/')) {
      return new Response(JSON.stringify({ error: 'NOT_IMPLEMENTED' }), {
        status: 501,
        headers: { 'content-type': 'application/json' },
      })
    }
    return env.ASSETS.fetch(request)
  },
} satisfies ExportedHandler<Env>
