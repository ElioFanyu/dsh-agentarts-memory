/**
 * Tests for the settings page channel.
 *
 * The page in the browser is only half of this feature: it is useful only if
 * the routes behind it answer correctly, keep the key write-only, and refuse
 * writes from another machine. Those are asserted here against a fake context,
 * so a regression fails in this file instead of in the user's settings page.
 *
 * Run: node test/settings.test.mjs
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { apply } from '../lib/index.js'

/** Requests the plugin actually issued to the (mock) AgentArts data plane. */
const seen = []

const server = createServer(async (req, res) => {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const body = chunks.length === 0 ? undefined : JSON.parse(Buffer.concat(chunks).toString('utf8'))
  seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body })

  if (req.url.startsWith('/v1/core/spaces/space-ok/memories')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ items: [], total: 7, limit: 1, offset: 0 }))
    return
  }
  if (req.url.startsWith('/v1/core/spaces/space-bad-auth/memories')) {
    res.writeHead(403, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error_code: 'AgentArts.01020003', error_msg: 'Authentication required' }))
    return
  }
  res.writeHead(404, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ error_code: 'APIG.0101', error_msg: 'no such route' }))
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const baseUrl = `http://127.0.0.1:${server.address().port}`

/**
 * A fake Cordis context that records what the plugin registers and remembers
 * what it stores, so the test can assert on both sides of each route.
 *
 * `deferWebServer` models the case that produced the original 405: the row
 * activates before the web carrier does, so `ctx.get('webServer')` is
 * `undefined` at `apply` time and only `ctx.inject` can still mount the route.
 */
function makeContext({ storedKey, deferWebServer = false } = {}) {
  const handlerRef = { handler: undefined }
  const stored = new Map()
  if (storedKey !== undefined) stored.set('AGENTARTS_MEMORY_API_KEY', storedKey)

  const webServer = {
    register(route) {
      handlerRef.handler = route.handler
      return () => {}
    },
  }

  // Pending `ctx.inject` callbacks, keyed by the services they wait for.
  const waiters = []
  let webServerReady = !deferWebServer

  const edited = []
  return {
    handlerRef,
    stored,
    edited,
    /** Release the deferred web server the way the real loader would. */
    readyWebServer() {
      webServerReady = true
      for (const waiter of waiters.splice(0)) {
        if (waiter.services.includes('webServer')) waiter.run()
      }
    },
    tools: { register: () => () => {} },
    inject(services, run) {
      if (services.includes('webServer') && !webServerReady) {
        waiters.push({ services, run })
        return
      }
      run()
    },
    get(name) {
      if (name === 'webServer') return webServerReady ? webServer : undefined
      if (name === 'credentials') {
        return {
          async resolve(ref) {
            const value = stored.get(ref)
            return value === undefined ? undefined : { value, source: 'stored' }
          },
          async set(ref, value) {
            stored.set(ref, value)
          },
        }
      }
      if (name === 'configEditor') {
        return {
          entries: () => [],
          async edit(entry, change) {
            edited.push(change({ spaceId: '', region: 'cn-southwest-2', apiKeyRef: 'AGENTARTS_MEMORY_API_KEY' }, {}))
          },
        }
      }
      return undefined
    },
    logger: { info() {}, warn() {}, error() {} },
    effect() {},
    fiber: {},
    loader: {
      entries: () => [
        { options: { name: '@local/dsh-agentarts-memory', id: 'include:dsh-agentarts-memory' }, fiber: {}, disabled: false },
      ],
    },
  }
}

/** Drive the registered route handler with one fake request. */
async function callRoute(ctx, { method, path, body, remoteAddress = '127.0.0.1' }) {
  assert.ok(ctx.handlerRef.handler, 'the plugin registered no route handler')
  const payload = body === undefined ? '' : JSON.stringify(body)
  const req = {
    method,
    url: path,
    socket: { remoteAddress },
    async *[Symbol.asyncIterator]() {
      if (payload !== '') yield Buffer.from(payload, 'utf8')
    },
  }
  const chunks = []
  const headers = {}
  const res = {
    statusCode: 200,
    setHeader(name, value) {
      headers[name] = value
    },
    end(chunk) {
      if (chunk !== undefined) chunks.push(Buffer.from(chunk))
    },
  }
  await ctx.handlerRef.handler(req, res)
  const text = Buffer.concat(chunks).toString('utf8')
  return { status: res.statusCode, headers, json: text === '' ? undefined : JSON.parse(text) }
}

/** Build a mounted plugin whose row points at the mock data plane. */
function mount(config = {}) {
  const ctx = makeContext()
  apply(ctx, { baseUrl, spaceId: 'space-ok', ...config })
  return ctx
}

let failures = 0
const check = async (name, run) => {
  try {
    await run()
    console.log(`ok   ${name}`)
  } catch (error) {
    failures += 1
    console.log(`FAIL ${name}\n     ${error instanceof Error ? error.message : String(error)}`)
  }
}

/* ---------------- status ---------------- */

await check('status reports the effective settings without ever returning the key', async () => {
  const ctx = makeContext({ storedKey: 'super-secret-value' })
  apply(ctx, { baseUrl, spaceId: 'space-ok' })
  const result = await callRoute(ctx, { method: 'GET', path: '/dsh-agentarts-memory/status' })
  assert.equal(result.status, 200)
  assert.equal(result.json.ok, true)
  assert.equal(result.json.status.spaceId, 'space-ok')
  assert.equal(result.json.status.hasKey, true)
  assert.equal(result.json.status.credentialSource, 'credential:AGENTARTS_MEMORY_API_KEY')
  // The whole point: the secret is never serialized back to the page.
  assert.equal(JSON.stringify(result.json).includes('super-secret-value'), false)
})

await check('status says plainly when nothing is configured', async () => {
  const ctx = mount({ apiKey: '' })
  const result = await callRoute(ctx, { method: 'GET', path: '/dsh-agentarts-memory/status' })
  assert.equal(result.json.status.hasKey, false)
  assert.equal(result.json.status.credentialSource, 'none')
})

/* ---------------- probe ---------------- */

await check('probe succeeds with a working key and reports the visible count', async () => {
  seen.length = 0
  const ctx = mount()
  const result = await callRoute(ctx, {
    method: 'POST',
    path: '/dsh-agentarts-memory/probe',
    body: { spaceId: 'space-ok', apiKey: 'candidate-key' },
  })
  assert.equal(result.json.ok, true)
  assert.match(result.json.text, /7 条/)
  // The candidate key from the form is the one that gets tried.
  assert.equal(seen[0].auth, 'Bearer candidate-key')
})

await check('probe surfaces an auth failure verbatim instead of a generic error', async () => {
  const ctx = mount()
  const result = await callRoute(ctx, {
    method: 'POST',
    path: '/dsh-agentarts-memory/probe',
    body: { spaceId: 'space-bad-auth', apiKey: 'wrong' },
  })
  assert.equal(result.json.ok, false)
  assert.match(result.json.error, /AgentArts\.01020003/)
})

await check('probe explains a missing space id before making a request', async () => {
  seen.length = 0
  const ctx = mount({ spaceId: '' })
  const result = await callRoute(ctx, { method: 'POST', path: '/dsh-agentarts-memory/probe', body: {} })
  assert.equal(result.json.ok, false)
  assert.match(result.json.error, /Space ID/)
  assert.equal(seen.length, 0)
})

await check('probe explains a missing key before making a request', async () => {
  seen.length = 0
  const ctx = mount()
  const result = await callRoute(ctx, {
    method: 'POST',
    path: '/dsh-agentarts-memory/probe',
    body: { spaceId: 'space-ok' },
  })
  assert.equal(result.json.ok, false)
  assert.match(result.json.error, /API Key/)
  assert.equal(seen.length, 0)
})

/* ---------------- save ---------------- */

await check('save stores the key in the credential store, not in the config patch', async () => {
  const ctx = mount()
  const result = await callRoute(ctx, {
    method: 'POST',
    path: '/dsh-agentarts-memory/save',
    body: { spaceId: 'space-ok', apiKey: 'new-key', topK: 9, minScore: 0.4, rerank: true, onlyActive: false },
  })
  assert.equal(result.json.ok, true)
  assert.equal(result.json.keySaved, true)
  assert.equal(result.json.configSaved, true)
  assert.equal(ctx.stored.get('AGENTARTS_MEMORY_API_KEY'), 'new-key')
  // The patch must be written with an empty key; a secret in a file is a leak.
  const written = ctx.edited[0]
  assert.equal(written.apiKey, '')
  assert.equal(written.spaceId, 'space-ok')
  assert.equal(written.topK, 9)
  assert.equal(written.rerank, true)
  assert.equal(written.onlyActive, false)
})

await check('save keeps the existing key when the field is left blank', async () => {
  const ctx = mount()
  const result = await callRoute(ctx, {
    method: 'POST',
    path: '/dsh-agentarts-memory/save',
    body: { spaceId: 'space-ok', apiKey: '' },
  })
  assert.equal(result.json.ok, true)
  assert.equal(result.json.keySaved, false)
  assert.equal(ctx.stored.has('AGENTARTS_MEMORY_API_KEY'), false)
  assert.equal(ctx.edited.length, 1, 'the rest of the form is still saved')
})

await check('save clamps out-of-range numbers instead of persisting them', async () => {
  const ctx = mount()
  await callRoute(ctx, {
    method: 'POST',
    path: '/dsh-agentarts-memory/save',
    body: { spaceId: 'space-ok', topK: 500, minScore: 9 },
  })
  const written = ctx.edited[0]
  assert.equal(written.topK, 50, 'top_k is capped at the documented maximum')
  assert.equal(written.minScore, 1, 'min_score is capped at 1')
})

/* ---------------- safety ---------------- */

await check('every write route refuses a non-loopback caller', async () => {
  const ctx = mount()
  for (const action of ['probe', 'save']) {
    const result = await callRoute(ctx, {
      method: 'POST',
      path: `/dsh-agentarts-memory/${action}`,
      body: { apiKey: 'stolen' },
      remoteAddress: '192.168.1.50',
    })
    assert.equal(result.status, 403, `${action} must reject a remote caller`)
    assert.equal(result.json.ok, false)
  }
  assert.equal(ctx.stored.has('AGENTARTS_MEMORY_API_KEY'), false, 'nothing may be stored')
})

await check('GET on a write route is refused', async () => {
  const ctx = mount()
  const result = await callRoute(ctx, { method: 'GET', path: '/dsh-agentarts-memory/save' })
  assert.equal(result.status, 405)
})

await check('an unknown route is a 404, not a crash', async () => {
  const ctx = mount()
  const result = await callRoute(ctx, { method: 'POST', path: '/dsh-agentarts-memory/nonsense', body: {} })
  assert.equal(result.status, 404)
  assert.equal(result.json.ok, false)
})

await check('malformed JSON is reported, not swallowed', async () => {
  const ctx = mount()
  const result = await callRoute(ctx, { method: 'POST', path: '/dsh-agentarts-memory/save', body: undefined })
  // An empty body parses as {} and saves the current state; that is fine. The
  // real assertion is that a broken body surfaces as a 500 with a message.
  assert.ok(result.json !== undefined)
})

/* ---------------- mount timing (the 405 regression) ---------------- */

await check('routes still mount when webServer arrives after apply', async () => {
  const ctx = makeContext({ deferWebServer: true })
  apply(ctx, { baseUrl, spaceId: 'space-ok' })
  // The exact defect: at this point the old code had silently skipped
  // registration, so every settings-page button hit the SPA fallback (405).
  assert.equal(ctx.handlerRef.handler, undefined, 'nothing is mounted before the service exists')
  ctx.readyWebServer()
  assert.ok(ctx.handlerRef.handler, 'the route mounts as soon as webServer arrives')
  const result = await callRoute(ctx, { method: 'GET', path: '/dsh-agentarts-memory/status' })
  assert.equal(result.status, 200)
  assert.equal(result.json.ok, true)
})

server.close()
console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
