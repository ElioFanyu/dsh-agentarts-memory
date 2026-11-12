/**
 * The loopback HTTP channel the settings page talks to.
 *
 * The page needs three things the model tool never touches:
 *
 *   GET  /status   effective endpoint/space/credential source, safe to render
 *   POST /probe    one live call against AgentArts, so "did I paste the right
 *                  key" is answered here instead of by a failed agent turn
 *   POST /save     persist the form
 *
 * Two rules shape this module:
 *
 *   - The API key travels INTO this process and is stored in the credential
 *     store, never in the profile patch. Reading it back is not offered at all:
 *     the page shows whether a key exists, never what it is.
 *   - Every mutating route is loopback-only. The page itself is served by the
 *     same web server that may be reachable from another machine, so an
 *     unauthenticated POST here would let that machine rewrite the config.
 *
 * @module @local/dsh-agentarts-memory/routes
 */

/** Route prefix owned by this plugin; must match the Client half. */
export const ROUTE_PREFIX = '/dsh-agentarts-memory'

/** Reject requests that did not originate on this machine. */
export function isLoopback(address) {
  if (typeof address !== 'string') return false
  const value = address.replace(/^::ffff:/, '')
  return value === '127.0.0.1' || value === '::1' || value === 'localhost'
}

/** Send one JSON body with no caching. */
export function sendJson(res, status, body) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(body))
}

/** Read and parse a bounded JSON request body. */
export async function readJsonBody(req, maxBytes = 262144) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.byteLength
    if (size > maxBytes) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  const text = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8')
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('请求体不是合法 JSON')
  }
}

/** A never-empty description of a thrown value. */
export function errorText(error) {
  const message = error instanceof Error ? error.message : String(error)
  return message.trim() === '' ? '未知错误' : message
}
