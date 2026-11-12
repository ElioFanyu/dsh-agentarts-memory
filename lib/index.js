/**
 * Huawei Cloud AgentArts memory — Host half.
 *
 * AgentArts (智果智能体平台) keeps long-term memories in a *memory space*; the
 * data plane exposes two read endpoints that matter to an agent:
 *
 *   GET  /v1/core/spaces/{space_id}/memories          list records
 *   POST /v1/core/spaces/{space_id}/memories/search   semantic retrieval
 *
 * This plugin turns those two endpoints into one model-facing tool,
 * `agentarts_memory`, so a session can recall what earlier sessions stored in
 * the same space instead of starting from nothing.
 *
 * Design choices worth stating:
 *
 *   - The tool is read-only. Nothing here writes, updates or deletes a memory:
 *     a wrong semantic write pollutes every later retrieval, and the console is
 *     the right place to curate a space.
 *   - The API key never reaches the model. It is read per call from the
 *     credential store (or the config row) and only ever appears in an
 *     Authorization header.
 *   - `spaceId` is configuration, not a tool argument: an agent must not be able
 *     to point itself at somebody else's memory space.
 *
 * @module @local/dsh-agentarts-memory
 */

import { Config, DEFAULTS, ensureConfig } from './config.js'
import { ROUTE_PREFIX, errorText, isLoopback, readJsonBody, sendJson } from './routes.js'

/** Stable plugin name; must match the row inserted by `cordis.patch.yml`. */
export const name = 'dsh-agentarts-memory'

/** Package name the Loader records for this row; used to find our own entry. */
const PACKAGE_NAME = '@local/dsh-agentarts-memory'
/** Re-exported so the Loader can project this row into a settings form. */
export { Config }

/** The tools service is the only hard requirement; credentials is optional. */
export const inject = ['tools']

/** Credential reference consulted when the config row carries no key. */
const DEFAULT_API_KEY_REF = DEFAULTS.apiKeyRef

/** Default data-plane region and endpoint shape, per the AgentArts API docs. */
const DEFAULT_REGION = DEFAULTS.region
const DEFAULT_HOST_TEMPLATE = 'https://memory.{region}.huaweicloud-agentarts.com'

/** Hard ceilings: a memory space can hold a lot, a model context cannot. */
const MAX_PAGE = 100
const MAX_QUERY_CHARS = 2000
const REQUEST_TIMEOUT_MS = 30_000

/** Strategy types accepted by the search endpoint (invalid values are rejected). */
const STRATEGY_TYPES = ['semantic', 'summary', 'user_preference', 'episodic', 'procedural']

/** Memory record kinds returned by the endpoints. */
const MEMORY_TYPES = ['memory', 'episode', 'reflection']

/* ---------------------------------------------------------------------- *
 * Configuration
 * ---------------------------------------------------------------------- */

/** Read a trimmed string from the config row, ignoring wrong types. */
function text(config, key) {
  const value = config?.[key]
  return typeof value === 'string' ? value.trim() : ''
}

/** Read an integer clamped into a range, falling back when absent or invalid. */
function clampedInt(config, key, fallback, min, max) {
  const value = config?.[key]
  const number = typeof value === 'number' ? value : Number.NaN
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.floor(number)))
}

/** Read a boolean, falling back when absent. */
function bool(config, key, fallback) {
  const value = config?.[key]
  return typeof value === 'boolean' ? value : fallback
}

/**
 * Resolve the effective settings once per plugin load.
 *
 * The endpoint can be overridden outright (`baseUrl`) because private-network
 * AgentArts deployments and the public region hostnames differ, and guessing an
 * endpoint is worse than asking for one.
 */
function resolveSettings(config) {
  const region = text(config, 'region') || DEFAULT_REGION
  const baseUrl =
    text(config, 'baseUrl') || DEFAULT_HOST_TEMPLATE.replace('{region}', region)
  return {
    spaceId: text(config, 'spaceId'),
    actorId: text(config, 'actorId'),
    apiKeyRef: text(config, 'apiKeyRef') || DEFAULT_API_KEY_REF,
    apiKey: text(config, 'apiKey'),
    region,
    baseUrl: baseUrl.replace(/\/+$/, ''),
    topK: clampedInt(config, 'topK', 5, 1, 50),
    minScore: (() => {
      const value = config?.minScore
      const number = typeof value === 'number' ? value : Number.NaN
      return Number.isFinite(number) ? Math.min(1, Math.max(0, number)) : 0
    })(),
    rerank: bool(config, 'rerank', false),
    onlyActive: bool(config, 'onlyActive', true),
  }
}

/* ---------------------------------------------------------------------- *
 * Credential resolution
 * ---------------------------------------------------------------------- */

/**
 * Resolve the API key for one call.
 *
 * Order matters: an explicitly stored value in the credential store wins over
 * the config row, so a user who rotates a key in the credential store does not
 * also have to scrub an old one out of the patch. Resolution happens per call —
 * never cached — so a rotated key reaches the very next request.
 */
async function resolveApiKey(ctx, settings) {
  const credentials = typeof ctx.get === 'function' ? ctx.get('credentials') : undefined
  if (credentials !== undefined && typeof credentials.resolve === 'function') {
    try {
      const resolved = await credentials.resolve(settings.apiKeyRef)
      const value = typeof resolved === 'string' ? resolved : resolved?.value
      if (typeof value === 'string' && value.trim() !== '') {
        return { key: value.trim(), source: `credential:${settings.apiKeyRef}` }
      }
    } catch {
      /* a broken credential store must not hide a configured key */
    }
  }
  if (settings.apiKey !== '') return { key: settings.apiKey, source: 'config' }
  return { key: undefined, source: 'none' }
}

/* ---------------------------------------------------------------------- *
 * HTTP client
 * ---------------------------------------------------------------------- */

/** Turn a response body into a readable error, keeping the service error code. */
function serviceError(status, body) {
  const code = typeof body?.error_code === 'string' ? body.error_code : `HTTP ${status}`
  const message = typeof body?.error_msg === 'string' ? body.error_msg : ''
  return message === '' ? code : `${code}: ${message}`
}

/** One JSON request against the AgentArts data plane. */
async function request(settings, key, { method, path, body, signal }) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  const abort = () => controller.abort()
  signal?.addEventListener('abort', abort, { once: true })
  try {
    const response = await fetch(`${settings.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${key}`,
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    })
    const raw = await response.text()
    let parsed
    try {
      parsed = raw === '' ? {} : JSON.parse(raw)
    } catch {
      parsed = undefined
    }
    if (!response.ok) {
      throw new Error(serviceError(response.status, parsed))
    }
    if (parsed === undefined) throw new Error('响应不是合法 JSON')
    return parsed
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
  }
}

/** Build a query string, dropping empty values. */
function query(pairs) {
  const search = new URLSearchParams()
  for (const [key, value] of pairs) {
    if (value === undefined || value === null || value === '') continue
    search.set(key, String(value))
  }
  const text = search.toString()
  return text === '' ? '' : `?${text}`
}

/* ---------------------------------------------------------------------- *
 * Response shaping
 * ---------------------------------------------------------------------- */

/** Render one memory record as the compact block the model reads. */
function renderRecord(record, score) {
  const lines = []
  const head = []
  if (typeof score === 'number') head.push(`score ${score.toFixed(3)}`)
  if (typeof record.strategy_type === 'string') head.push(record.strategy_type)
  if (typeof record.memory_type === 'string') head.push(record.memory_type)
  if (typeof record.created_at === 'string') head.push(record.created_at)
  lines.push(head.length === 0 ? '(no metadata)' : head.join(' · '))
  const content = typeof record.content === 'string' ? record.content : ''
  lines.push(content)
  if (typeof record.id === 'string') lines.push(`id: ${record.id}`)
  return lines.join('\n')
}

/* ---------------------------------------------------------------------- *
 * Tool
 * ---------------------------------------------------------------------- */

const TOOL_ACTIONS = ['status', 'list', 'search']

const TOOL_SCHEMA = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: TOOL_ACTIONS,
      description:
        'status 检查当前配置与凭据是否可用；list 分页列出记忆空间里的记忆记录；search 按语义检索最相关的记忆。',
    },
    query: {
      type: 'string',
      description: 'search 的检索文本（1-2000 字符）。省略时只按过滤条件检索。',
    },
    strategy_type: {
      type: 'string',
      enum: STRATEGY_TYPES,
      description: '按策略类型过滤：semantic 语义 / summary 摘要 / user_preference 用户偏好 / episodic 事件 / procedural 流程。',
    },
    memory_type: {
      type: 'string',
      enum: MEMORY_TYPES,
      description: '按记忆类型过滤：memory 一般记忆 / episode 事件记忆 / reflection 反思记忆。',
    },
    top_k: { type: 'integer', description: 'search 返回条数，1-50，默认取插件配置（默认 5）。' },
    min_score: { type: 'number', description: 'search 相似度阈值 0-1，默认取插件配置。' },
    limit: { type: 'integer', description: 'list 每页条数，1-100，默认 20。' },
    offset: { type: 'integer', description: 'list 偏移量，从 0 开始，默认 0。' },
  },
  required: ['action'],
  additionalProperties: false,
}

/** Shape and run one tool call. */
async function runAction(ctx, settings, args, signal) {
  const action = String(args?.action ?? '')

  if (action === 'status') {
    const credential = await resolveApiKey(ctx, settings)
    const lines = [
      `端点：${settings.baseUrl}`,
      `Space：${settings.spaceId === '' ? '(未配置)' : settings.spaceId}`,
      `凭据来源：${credential.source === 'none' ? '(未配置)' : credential.source}`,
      `默认检索：top_k ${settings.topK} · min_score ${settings.minScore} · rerank ${settings.rerank ? 'on' : 'off'} · 仅 active ${settings.onlyActive ? 'yes' : 'no'}`,
    ]
    if (settings.actorId !== '') lines.push(`actor_id：${settings.actorId}`)
    return lines.join('\n')
  }

  if (action !== 'list' && action !== 'search') {
    throw new Error(`未知操作：${action === '' ? '(空)' : action}`)
  }
  if (settings.spaceId === '') {
    throw new Error('未配置 spaceId：请在「设置 → 插件 → AgentArts 记忆库」里填写记忆库 Space ID（控制台记忆库详情页 URL 里的 id 参数）。')
  }
  const credential = await resolveApiKey(ctx, settings)
  if (credential.key === undefined) {
    throw new Error(
      `未配置 API Key：请在「设置 → 插件 → AgentArts 记忆库」里填写 apiKey，或把 Key 存进凭据 ${settings.apiKeyRef}。`,
    )
  }

  if (action === 'list') {
    const limit = clampedInt(args, 'limit', 20, 1, MAX_PAGE)
    const offset = clampedInt(args, 'offset', 0, 0, 1_000_000)
    const path =
      `/v1/core/spaces/${encodeURIComponent(settings.spaceId)}/memories` +
      query([
        ['strategy_type', pick(args?.strategy_type, STRATEGY_TYPES)],
        ['actor_id', settings.actorId],
        ['limit', limit],
        ['offset', offset],
        ['sort_by', 'created_at'],
        ['sort_order', 'desc'],
      ])
    const data = await request(settings, credential.key, { method: 'GET', path, signal })
    const items = Array.isArray(data.items) ? data.items : []
    const total = typeof data.total === 'number' ? data.total : items.length
    if (items.length === 0) {
      return `记忆空间 ${settings.spaceId} 中${settings.actorId === '' ? '' : ` actor_id=${settings.actorId} 的`}记录：0 条（total ${total}）。`
    }
    const blocks = items.map((record, index) => `## ${offset + index + 1}\n${renderRecord(record)}`)
    return [
      `记忆空间 ${settings.spaceId} · 第 ${offset + 1}-${offset + items.length} 条 / 共 ${total} 条`,
      '',
      blocks.join('\n\n'),
    ].join('\n')
  }

  const rawQuery = typeof args?.query === 'string' ? args.query.trim() : ''
  if (rawQuery.length > MAX_QUERY_CHARS) {
    throw new Error(`query 过长（${rawQuery.length} 字符，上限 ${MAX_QUERY_CHARS}）`)
  }
  const topK = clampedInt(args, 'top_k', settings.topK, 1, 50)
  const minScore = (() => {
    const value = args?.min_score
    const number = typeof value === 'number' ? value : Number.NaN
    return Number.isFinite(number) ? Math.min(1, Math.max(0, number)) : settings.minScore
  })()
  const body = {
    top_k: topK,
    min_score: minScore,
    rerank: settings.rerank,
    only_actived: settings.onlyActive,
  }
  if (rawQuery !== '') body.query = rawQuery
  const strategyType = pick(args?.strategy_type, STRATEGY_TYPES)
  if (strategyType !== undefined) body.strategy_type = strategyType
  const memoryType = pick(args?.memory_type, MEMORY_TYPES)
  if (memoryType !== undefined) body.memory_type = memoryType
  if (settings.actorId !== '') body.actor_id = settings.actorId

  const data = await request(settings, credential.key, {
    method: 'POST',
    path: `/v1/core/spaces/${encodeURIComponent(settings.spaceId)}/memories/search`,
    body,
    signal,
  })
  const results = Array.isArray(data.results) ? data.results : []
  if (results.length === 0) {
    return `检索「${rawQuery === '' ? '(仅过滤条件)' : rawQuery}」未命中任何记忆（top_k ${topK}，min_score ${minScore}）。`
  }
  const blocks = results.map((entry, index) => {
    const record = entry?.record ?? {}
    return `## ${index + 1}\n${renderRecord(record, typeof entry?.score === 'number' ? entry.score : undefined)}`
  })
  return [
    `检索「${rawQuery === '' ? '(仅过滤条件)' : rawQuery}」命中 ${results.length} 条（记忆空间 ${settings.spaceId}）`,
    '',
    blocks.join('\n\n'),
  ].join('\n')
}

/** Keep only a value the endpoint documents, dropping anything else. */
function pick(value, allowed) {
  return typeof value === 'string' && allowed.includes(value) ? value : undefined
}

/* ---------------------------------------------------------------------- *
 * Plugin entry
 * ---------------------------------------------------------------------- */

export function apply(ctx, config) {
  const log = (message) => {
    try {
      ctx.logger?.info?.(message)
    } catch {
      /* logging must never break the plugin */
    }
  }

  // Repair the schema binding if this module was first evaluated while
  // `schemastery` was unresolvable; the settings service sees the live export.
  ensureConfig()

  /**
   * Effective settings for this mount.
   *
   * Re-resolved whenever the Loader re-applies the row (which is exactly what
   * happens after the settings page saves), so the tool and the page can never
   * disagree about which space they are pointed at.
   */
  let settings = resolveSettings(config)

  const dispose = ctx.tools.register({
    name: 'agentarts_memory',
    description:
      '读取华为云 AgentArts（智果）记忆库里的长期记忆：list 分页列出记忆空间中的记录，search 用语义检索召回最相关的记忆，status 检查配置是否可用。用户提到「记忆库」「AgentArts」「之前记过的偏好/结论」时用它；这是只读工具，不能写入、修改或删除记忆。',
    parameters: TOOL_SCHEMA,
    output: {
      schema: { type: 'object', properties: { text: { type: 'string' } }, additionalProperties: false },
      render: (_args, value) => [{ type: 'text', text: typeof value?.text === 'string' ? value.text : '' }],
    },
    async execute(args, exec) {
      try {
        const text = await runAction(ctx, settings, args, exec?.signal)
        return { text }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw new Error(message)
      }
    },
  })

  ctx.effect?.(() => dispose, 'dsh-agentarts-memory: tool')

  /* ---- the settings page channel ---- */

  /**
   * Mount the routes once `webServer` exists.
   *
   * A synchronous `ctx.get('webServer')` in `apply` reads `undefined` whenever
   * this row activates before the web carrier does, and the old code then
   * skipped registration silently — the settings page rendered fine (its half
   * is browser-side) while every button posted into the SPA fallback and came
   * back 405. `ctx.inject` waits for the service and runs this the moment it
   * arrives, which is what the shipped settings cards do for the same reason.
   */
  const registerLater = (services, label, run) => {
    try {
      if (typeof ctx.inject === 'function') {
        ctx.inject(services, () => {
          try {
            const disposer = run()
            if (disposer !== undefined) ctx.effect(() => disposer, label)
          } catch (error) {
            ctx.logger?.error?.(error)
          }
        })
        return
      }
    } catch (error) {
      ctx.logger?.error?.(error)
    }
    try {
      const disposer = run()
      if (disposer !== undefined) ctx.effect(() => disposer, label)
    } catch (error) {
      ctx.logger?.error?.(error)
    }
  }

  registerLater(['webServer'], 'dsh-agentarts-memory: settings route', () => {
    const webServer = typeof ctx.get === 'function' ? ctx.get('webServer') : undefined
    if (webServer === undefined || typeof webServer.register !== 'function') {
      log('dsh-agentarts-memory: 当前部署没有 webServer，设置页通道不可用')
      return undefined
    }
    return webServer.register({
      kind: 'prefix',
      path: ROUTE_PREFIX,
      handler: async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        const action = url.pathname.slice(ROUTE_PREFIX.length).replace(/^\/+/, '')
        const method = req.method ?? 'GET'
        try {
          if (method === 'GET' && action === 'status') {
            const credential = await resolveApiKey(ctx, settings)
            sendJson(res, 200, {
              ok: true,
              status: {
                baseUrl: settings.baseUrl,
                spaceId: settings.spaceId,
                actorId: settings.actorId,
                region: settings.region,
                apiKeyRef: settings.apiKeyRef,
                credentialSource: credential.source,
                hasKey: credential.key !== undefined,
                topK: settings.topK,
                minScore: settings.minScore,
                rerank: settings.rerank,
                onlyActive: settings.onlyActive,
              },
            })
            return
          }

          // Reads may come from anywhere the page itself is reachable; writes
          // may not, because they change this machine's configuration.
          if (method !== 'POST') {
            sendJson(res, 405, { ok: false, error: '方法不允许' })
            return
          }
          if (!isLoopback(req.socket?.remoteAddress)) {
            sendJson(res, 403, { ok: false, error: '仅允许本机访问' })
            return
          }

          if (action === 'probe') {
            const body = await readJsonBody(req)
            // Probe the values in the form, not the saved ones: the point is to
            // answer "does this key work" before it is committed anywhere.
            const candidate = {
              ...settings,
              spaceId: typeof body.spaceId === 'string' && body.spaceId.trim() !== '' ? body.spaceId.trim() : settings.spaceId,
              baseUrl: typeof body.baseUrl === 'string' && body.baseUrl.trim() !== '' ? body.baseUrl.trim().replace(/\/+$/, '') : settings.baseUrl,
              actorId: typeof body.actorId === 'string' ? body.actorId.trim() : settings.actorId,
            }
            let key = credentialKeyOf(body)
            if (key === undefined) {
              key = (await resolveApiKey(ctx, candidate)).key
            }
            if (candidate.spaceId === '') {
              sendJson(res, 200, { ok: false, error: '还没填 Space ID。控制台记忆库详情页 URL 里的 id 参数就是它。' })
              return
            }
            if (key === undefined) {
              sendJson(res, 200, { ok: false, error: '还没填 API Key。记忆库详情页「API Key」处可以复制或下载。' })
              return
            }
            try {
              const data = await request(candidate, key, {
                method: 'GET',
                path: `/v1/core/spaces/${encodeURIComponent(candidate.spaceId)}/memories${query([['limit', 1], ['actor_id', candidate.actorId]])}`,
                signal: undefined,
              })
              const total = typeof data.total === 'number' ? data.total : Array.isArray(data.items) ? data.items.length : 0
              sendJson(res, 200, {
                ok: true,
                text: `连接成功：记忆空间可读，当前可见 ${total} 条记忆。`,
                total,
              })
            } catch (error) {
              sendJson(res, 200, { ok: false, error: errorText(error) })
            }
            return
          }

          if (action === 'save') {
            const body = await readJsonBody(req)
            const saved = await saveConfiguration(ctx, settings, body)
            sendJson(res, 200, { ok: true, ...saved })
            return
          }

          sendJson(res, 404, { ok: false, error: `未知操作：${action}` })
        } catch (error) {
          sendJson(res, 500, { ok: false, error: errorText(error) })
        }
      },
    })
  })

  log(
    `dsh-agentarts-memory: 端点 ${settings.baseUrl}，Space ${settings.spaceId === '' ? '(未配置)' : settings.spaceId}，凭据 ${settings.apiKey === '' ? `凭据 ${settings.apiKeyRef}` : '配置行 apiKey'}`,
  )
}

/** Read a candidate key out of a request body, if the page sent one. */
function credentialKeyOf(body) {
  const value = body?.apiKey
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/**
 * Persist the settings page form.
 *
 * Two destinations, deliberately:
 *
 *   - the API key goes to the credential store, so rotating it never leaves a
 *     stale secret in the profile patch (a patch is a file people paste into
 *     issues and commit);
 *   - every other field goes through `configEditor.edit`, which validates the
 *     change against `Config` and re-applies the row through the normal Loader
 *     path, so the tool picks it up without a restart.
 *
 * @returns what the page should report about the write.
 */
async function saveConfiguration(ctx, settings, body) {
  const probe = {
    ...settings,
    spaceId: typeof body.spaceId === 'string' ? body.spaceId.trim() : settings.spaceId,
    baseUrl: typeof body.baseUrl === 'string' && body.baseUrl.trim() !== '' ? body.baseUrl.trim().replace(/\/+$/, '') : '',
    actorId: typeof body.actorId === 'string' ? body.actorId.trim() : settings.actorId,
    region: typeof body.region === 'string' && body.region.trim() !== '' ? body.region.trim() : settings.region,
    topK: Number.isFinite(body.topK) ? Math.min(50, Math.max(1, Math.floor(body.topK))) : settings.topK,
    minScore: Number.isFinite(body.minScore) ? Math.min(1, Math.max(0, body.minScore)) : settings.minScore,
    rerank: typeof body.rerank === 'boolean' ? body.rerank : settings.rerank,
    onlyActive: typeof body.onlyActive === 'boolean' ? body.onlyActive : settings.onlyActive,
  }

  let keySaved = false
  let keyError
  const candidateKey = credentialKeyOf(body)
  if (candidateKey !== undefined) {
    const credentials = typeof ctx.get === 'function' ? ctx.get('credentials') : undefined
    if (credentials !== undefined && typeof credentials.set === 'function') {
      try {
        await credentials.set(settings.apiKeyRef, candidateKey)
        keySaved = true
      } catch (error) {
        keyError = `API Key 存入凭据失败：${errorText(error)}`
      }
    } else {
      keyError = '当前部署没有凭据服务，API Key 未保存。'
    }
  }

  const configEditor = typeof ctx.get === 'function' ? ctx.get('configEditor') : undefined
  if (configEditor === undefined || typeof configEditor.edit !== 'function') {
    return {
      configSaved: false,
      keySaved,
      ...(keyError === undefined ? {} : { keyError }),
      warning: '当前部署没有 configEditor：除 API Key 外的配置无法写入，请手动改 profile 的 cordis.patch.yml。',
    }
  }

  const entry = findOwnEntry(ctx)
  if (entry === undefined) {
    return {
      configSaved: false,
      keySaved,
      ...(keyError === undefined ? {} : { keyError }),
      warning: '找不到本插件的 profile 行，配置未写入。',
    }
  }

  await configEditor.edit(entry, (current) => ({
    ...current,
    spaceId: probe.spaceId,
    region: probe.region,
    baseUrl: probe.baseUrl,
    actorId: probe.actorId,
    topK: probe.topK,
    minScore: probe.minScore,
    rerank: probe.rerank,
    onlyActive: probe.onlyActive,
    // The key lives in the credential store; clear any copy left in the patch.
    apiKey: '',
    // Keep whatever reference name was already decided.
    apiKeyRef: settings.apiKeyRef,
  }))

  return {
    configSaved: true,
    keySaved,
    ...(keyError === undefined ? {} : { keyError }),
    reloaded: true,
  }
}

/** Resolve this plugin's own Loader row, preferring the fiber that mounted us. */
function findOwnEntry(ctx) {
  try {
    let fallback
    for (const entry of ctx.loader.entries()) {
      const name = entry?.options?.name
      if (name !== PACKAGE_NAME) continue
      if (entry.fiber === ctx.fiber) return entry
      if (entry.disabled !== true && fallback === undefined) fallback = entry
    }
    return fallback
  } catch {
    return undefined
  }
}
