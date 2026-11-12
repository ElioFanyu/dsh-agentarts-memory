/**
 * Configuration schema for the AgentArts memory plugin.
 *
 * The DSH settings mirror projects a plugin's `Config` into a form by walking
 * `schema.dict`, so the schema is declared with `schemastery` when it is
 * available. It is loaded defensively: this package is installed into a profile
 * as a `link:` dependency, and under that layout Node resolves imports from the
 * package's own directory — it never walks up into the profile's `node_modules`.
 * A hard import therefore turns one missing vendor package into "the whole
 * plugin fails to activate", taking the tool and the settings page with it.
 *
 * Degrading instead: without `schemastery` the built-in row Configuration card
 * is absent (`status: absent`), while the tool and this plugin's own Settings
 * page keep working. The page reads and writes configuration through the
 * plugin's routes, so it never depended on this schema.
 *
 * This file is the single source of truth for names, ranges and defaults.
 *
 * @module @local/dsh-agentarts-memory/config
 */

import { createRequire } from 'node:module'

/** Resolve `schemastery` from this package, or `undefined` when it is absent. */
function loadSchemaBuilder() {
  try {
    const require = createRequire(import.meta.url)
    const resolved = require('@deepseek-ai/schemastery')
    const schema = resolved?.default ?? resolved
    return typeof schema === 'function' || typeof schema?.object === 'function' ? schema : undefined
  } catch {
    return undefined
  }
}

const Schema = loadSchemaBuilder()

/** The defaults, independent of whether the schema itself could be built. */
export const DEFAULTS = {
  /** Memory space id; the `id` query parameter in the console URL. */
  spaceId: '',
  /** Data-plane region; the default host template expands from it. */
  region: 'cn-southwest-2',
  /** Data-plane base URL; empty means it derives from `region`. */
  baseUrl: '',
  /** Actor id; must match the writing side or retrieval silently returns nothing. */
  actorId: '',
  /** Credential reference consulted before `apiKey`. */
  apiKeyRef: 'AGENTARTS_MEMORY_API_KEY',
  /**
   * API key written into this config row.
   *
   * Leave it empty. The settings page stores the key in the DSH credential
   * store (`<DSH_HOME>/.credentials.yaml`), outside the bundle, so it never
   * travels with the package or with the profile patch. A value typed into this
   * field by hand is persisted in clear text in the patch instead — which is
   * exactly what leaks when someone commits their profile.
   */
  apiKey: '',
  /** Default result count for a semantic search. */
  topK: 5,
  /** Default minimum similarity score, 0-1. */
  minScore: 0,
  /** Whether the service reranks results; reranking costs latency. */
  rerank: false,
  /** Recall only `active` memories, hiding superseded ones. */
  onlyActive: true,
}

/** Build the schema when a builder is available, otherwise `undefined`. */
function buildSchema() {
  if (Schema === undefined) return undefined
  try {
    return Schema.object({
      spaceId: Schema.string().default(DEFAULTS.spaceId),
      region: Schema.string().default(DEFAULTS.region),
      baseUrl: Schema.string().default(DEFAULTS.baseUrl),
      actorId: Schema.string().default(DEFAULTS.actorId),
      apiKeyRef: Schema.string().default(DEFAULTS.apiKeyRef),
      // The key renders as a masked field rather than plain text.
      apiKey: Schema.string().default(DEFAULTS.apiKey).role('secret'),
      topK: Schema.number().min(1).max(50).step(1).default(DEFAULTS.topK),
      minScore: Schema.number().min(0).max(1).default(DEFAULTS.minScore),
      rerank: Schema.boolean().default(DEFAULTS.rerank),
      onlyActive: Schema.boolean().default(DEFAULTS.onlyActive),
    })
  } catch {
    return undefined
  }
}

export let Config = buildSchema()

/**
 * Rebuild the schema if the first attempt failed.
 *
 * A Host process caches this module by URL, so if it first imported while
 * `schemastery` was unresolvable it keeps the `undefined` bound at that moment;
 * disabling and re-enabling the row re-applies the fiber without re-evaluating
 * the module. `export let` is a live binding, so a later assignment is visible
 * to every importer and the settings service sees a schema on its next read.
 *
 * @returns the schema, or `undefined` when no builder is resolvable.
 */
export function ensureConfig() {
  if (Config === undefined) {
    try {
      Config = buildSchema()
    } catch {
      Config = undefined
    }
  }
  return Config
}
