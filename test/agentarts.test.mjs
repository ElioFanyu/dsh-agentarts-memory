/**
 * End-to-end check for the AgentArts memory tool.
 *
 * A local mock stands in for the AgentArts data plane, so this asserts the wire
 * format (path, bearer header, body defaults, optional-field omission) and the
 * rendered text without needing a real key or network.
 *
 * Run: node test/agentarts.test.mjs
 */

import { createServer } from 'node:http'
import assert from 'node:assert/strict'
import { apply } from '../lib/index.js'

/** Collect the requests the plugin made. */
const seen = []

/** One canned memory record, shaped like the documented MemoryRecord. */
const record = (id, content, extra = {}) => ({
  id,
  space_id: 'space-1',
  strategy_id: 'strategy-1',
  strategy_type: 'semantic',
  actor_id: 'actor-1',
  assistant_id: 'assistant-1',
  session_id: 'session-1',
  content,
  memory_type: 'memory',
  isolation_level: 'actor',
  created_at: '2026-01-18T10:00:00.000Z',
  updated_at: '2026-01-18T10:00:00.000Z',
  meta: {},
  ...extra,
})

const server = createServer(async (req, res) => {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const body = chunks.length === 0 ? undefined : JSON.parse(Buffer.concat(chunks).toString('utf8'))
  seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body })

  if (req.url.startsWith('/denied/')) {
    res.writeHead(403, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error_code: 'AgentArts.01020003', error_msg: 'Authentication required' }))
    return
  }
  if (req.url.startsWith('/v1/core/spaces/space-1/memories/search')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    if (body?.query === 'never stored') {
      res.end(JSON.stringify({ query: body.query, total: 0, results: [] }))
      return
    }
    res.end(JSON.stringify({
      query: body?.query ?? '',
      total: 1,
      results: [{ record: record('mem-1', '用户偏好用 pnpm 而不是 npm'), score: 0.9123 }],
    }))
    return
  }
  if (req.url.startsWith('/v1/core/spaces/space-1/memories')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      items: [record('mem-2', '发布流程：先跑 pnpm build，再 push tag')],
      total: 41,
      limit: 20,
      offset: 0,
    }))
    return
  }
  if (req.url.startsWith('/v1/core/spaces/denied/')) {
    res.writeHead(403, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error_code: 'AgentArts.01020003', error_msg: 'Authentication required' }))
    return
  }
  res.writeHead(404, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ error_code: 'APIG.0101', error_msg: 'no such route' }))
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const baseUrl = `http://127.0.0.1:${port}`

/** A fake Cordis context exposing exactly what the plugin touches. */
function makeContext({ apiKey, credentialValue, tools = true } = {}) {
  const registered = []
  const services = new Map()
  if (tools) {
    services.set('tools', {
      register(definition) {
        registered.push(definition)
        return () => {}
      },
    })
  }
  if (credentialValue !== undefined) {
    services.set('credentials', {
      async resolve() {
        return { value: credentialValue, source: 'stored' }
      },
    })
  }
  return {
    registered,
    tools: { register: (...args) => services.get('tools').register(...args) },
    get: (name) => services.get(name),
    logger: { info() {}, warn() {}, error() {} },
    effect() {},
    apiKey,
  }
}

/** Run one tool call against a configured plugin instance. */
async function call({ spaceId = 'space-1', key, credentialValue, args, baseUrlOverride = baseUrl }) {
  const ctx = makeContext({ apiKey: key, credentialValue })
  apply(ctx, { spaceId, apiKey: key ?? '', baseUrl: baseUrlOverride, apiKeyRef: 'AGENTARTS_MEMORY_API_KEY' })
  assert.equal(ctx.registered.length, 1, 'exactly one tool registered')
  const tool = ctx.registered[0]
  assert.equal(tool.name, 'agentarts_memory')
  const value = await tool.execute(args, { signal: undefined })
  return value.text
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

/* ---------------- schema and registration ---------------- */

await check('tool exposes the documented actions only', async () => {
  const ctx = makeContext()
  apply(ctx, {})
  const tool = ctx.registered[0]
  assert.deepEqual(tool.parameters.properties.action.enum, ['status', 'list', 'search'])
  assert.equal(tool.parameters.additionalProperties, false)
  // The key must not be a tool argument: the model cannot choose its identity.
  assert.equal('apiKey' in tool.parameters.properties, false)
  assert.equal('spaceId' in tool.parameters.properties, false)
})

/* ---------------- status ---------------- */

await check('status reports an unconfigured space without a request', async () => {
  seen.length = 0
  const text = await call({ spaceId: '', key: 'k', args: { action: 'status' } })
  assert.match(text, /Space：\(未配置\)/)
  assert.match(text, /凭据来源：config/)
  assert.equal(seen.length, 0)
})

await check('status prefers the credential store over the config key', async () => {
  const text = await call({ key: 'config-key', credentialValue: 'store-key', args: { action: 'status' } })
  assert.match(text, /凭据来源：credential:AGENTARTS_MEMORY_API_KEY/)
})

/* ---------------- guards ---------------- */

await check('list without a space id explains where to find it', async () => {
  await assert.rejects(
    () => call({ spaceId: '', key: 'k', args: { action: 'list' } }),
    /未配置 spaceId/,
  )
})

await check('missing credential is an actionable error, not a silent empty page', async () => {
  await assert.rejects(
    () => call({ key: '', args: { action: 'search', query: 'x' } }),
    /未配置 API Key/,
  )
})

await check('unknown action fails loudly', async () => {
  await assert.rejects(() => call({ key: 'k', args: { action: 'write' } }), /未知操作：write/)
})

/* ---------------- wire format ---------------- */

await check('list sends the documented query and bearer header', async () => {
  seen.length = 0
  const text = await call({ key: 'secret-key', args: { action: 'list' } })
  const request = seen[0]
  assert.equal(request.method, 'GET')
  assert.equal(request.auth, 'Bearer secret-key')
  assert.match(request.url, /^\/v1\/core\/spaces\/space-1\/memories\?/)
  assert.match(request.url, /limit=20/)
  assert.match(request.url, /offset=0/)
  assert.match(request.url, /sort_order=desc/)
  assert.match(text, /共 41 条/)
  assert.match(text, /发布流程/)
})

await check('list pages with the requested offset and limit', async () => {
  seen.length = 0
  await call({ key: 'k', args: { action: 'list', limit: 5, offset: 10 } })
  assert.match(seen[0].url, /limit=5/)
  assert.match(seen[0].url, /offset=10/)
})

await check('search posts the documented body and drops unset optional fields', async () => {
  seen.length = 0
  const text = await call({ key: 'k', args: { action: 'search', query: '发布流程' } })
  const request = seen[0]
  assert.equal(request.method, 'POST')
  assert.equal(request.url, '/v1/core/spaces/space-1/memories/search')
  assert.equal(request.body.query, '发布流程')
  assert.equal(request.body.top_k, 5)
  assert.equal(request.body.min_score, 0)
  assert.equal(request.body.rerank, false)
  assert.equal(request.body.only_actived, true)
  // No filters were asked for, so none may be invented.
  assert.equal('strategy_type' in request.body, false)
  assert.equal('memory_type' in request.body, false)
  assert.equal('actor_id' in request.body, false)
  assert.match(text, /score 0\.912/)
  assert.match(text, /pnpm/)
})

await check('search passes documented filters through', async () => {
  seen.length = 0
  await call({
    key: 'k',
    args: { action: 'search', query: 'q', strategy_type: 'user_preference', memory_type: 'reflection', top_k: 3, min_score: 0.5 },
  })
  const body = seen[0].body
  assert.equal(body.strategy_type, 'user_preference')
  assert.equal(body.memory_type, 'reflection')
  assert.equal(body.top_k, 3)
  assert.equal(body.min_score, 0.5)
})

await check('an illegal enum value is dropped rather than sent to be rejected', async () => {
  seen.length = 0
  await call({ key: 'k', args: { action: 'search', query: 'q', strategy_type: 'nonsense' } })
  assert.equal('strategy_type' in seen[0].body, false)
})

await check('a configured actor id narrows both calls', async () => {
  seen.length = 0
  const ctx = makeContext({ apiKey: 'k' })
  apply(ctx, { spaceId: 'space-1', apiKey: 'k', baseUrl, actorId: 'actor-1' })
  const tool = ctx.registered[0]
  await tool.execute({ action: 'search', query: 'q' }, {})
  await tool.execute({ action: 'list' }, {})
  assert.equal(seen[0].body.actor_id, 'actor-1')
  assert.match(seen[1].url, /actor_id=actor-1/)
})

/* ---------------- failures ---------------- */

await check('a service error keeps the AgentArts error code', async () => {
  await assert.rejects(
    () => call({ key: 'k', baseUrlOverride: `${baseUrl}/denied`, args: { action: 'list' } }),
    /AgentArts\.01020003: Authentication required/,
  )
})

await check('an unknown route surfaces the gateway error', async () => {
  const ctx = makeContext({ apiKey: 'k' })
  apply(ctx, { spaceId: 'no-such-space', apiKey: 'k', baseUrl })
  const tool = ctx.registered[0]
  await assert.rejects(() => tool.execute({ action: 'search', query: 'q' }, {}), /APIG\.0101/)
})

await check('an empty result set says so instead of rendering nothing', async () => {
  const text = await call({ key: 'k', args: { action: 'search', query: 'never stored' } })
  assert.match(text, /未命中任何记忆/)
  assert.match(text, /never stored/)
})

/* ---------------- config plumbing ---------------- */

await check('the schema projects into a settings form', async () => {
  const { Config } = await import('../lib/config.js')
  assert.equal(typeof Config.toJSON, 'function')
  const json = Config.toJSON()
  // This schemastery build flattens the tree into a deduplicated refs table, so
  // the fields are proven by the resolved value and the declared dict instead.
  assert.ok(json.refs !== undefined && json.uid !== undefined, 'schema JSON is projectable')
  assert.equal('apiKey' in Config.dict, true)
  assert.equal(Config.dict.apiKey.meta.role, 'secret', 'the key renders as a secret field')
  const fallback = Config({})
  assert.equal(fallback.spaceId, '')
  assert.equal(fallback.region, 'cn-southwest-2')
  assert.equal(fallback.topK, 5)
  assert.equal(fallback.rerank, false)
})

server.close()
console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
