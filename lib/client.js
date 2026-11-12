/**
 * AgentArts memory — Client half.
 *
 * This plugin deliberately has no Settings page.
 *
 * Its key, Space ID and Actor ID are configured in the 记忆库 hub
 * (`@local/dsh-memories`), which owns one page for all three memory backends.
 * A second page here would put the same connection fields in two places, and
 * two forms editing one row is how a value silently reverts.
 *
 * What this plugin still ships is its Host half: the `agentarts_memory` tool,
 * and the loopback routes (`/dsh-agentarts-memory/*`) that the hub calls to
 * read and write the row. So the client half has nothing to register — it
 * exists only because the bundle declares a web client, and an empty apply is
 * the honest shape of "this backend is configured elsewhere".
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-agentarts-memory',
  factory() {
    /** Nothing to register: configuration lives in the 记忆库 hub. */
    function apply() {}

    return {
      inject: ['slots'],
      apply,
    }
  },
})
