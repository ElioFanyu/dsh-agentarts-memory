# dsh-agentarts-memory

把**华为云 AgentArts（智果）记忆库**的长期记忆接进 DeepSeek Harness。

装好之后，模型多一个 `agentarts_memory` 工具：可以分页浏览记忆空间里的记忆，
也可以按语义检索召回最相关的几条。**只读**——不会写入、修改或删除任何记忆。

## 为什么需要它

DSH 自带的记忆、`hindsight` 之类都活在本地。AgentArts 的记忆库是华为云侧的
多租户长期记忆服务，记忆按 `Space` 划分、按 `actor_id` / `session_id` 做隔离，
存在云上、跨会话共享。想在 DSH 里用「之前那些 Agent 记下来的偏好和结论」，
就得有个东西把这两边接起来——这个插件就是那根线。

DSH 现有插件里没有能直连 AgentArts 的：

| 可能看起来相关的 | 实际是什么 |
| --- | --- |
| `dsh-connect-huawei` | 接的是华为「码道 CodeArts」和「办 OfficeAce」的**模型路由**，不碰 AgentArts |
| `dsh-mcp-connector` 市场目录 | 没有任何华为云 AgentArts 连接器 |
| `@deepseek-ai/dsh-mcp-client`（obsidian-mcp 行） | 只连了 Obsidian 一个 MCP server |

所以这个插件直接说 AgentArts 记忆库数据面协议。

## 用起来是什么样

配好 `spaceId` 和 API Key 之后，模型可以这样用：

- 「我上次说的那套发布流程，记忆里还有吗？」→ `action: search`，`query` 是那句话
- 「这个记忆库里都记了什么」→ `action: list`，分页翻
- 「偏好类的记忆有哪些」→ `action: search` + `strategy_type: user_preference`

`status` 用来检查配置：端点、Space、凭据来源都会打印出来，凭据只显示来源不显示值。

## 配置

在 **设置 → AgentArts 记忆库**（侧栏位置：内置插件之后、Agent 预设之前）里填，
保存后立即生效，不需要重启：

| 字段 | 说明 |
| --- | --- |
| `spaceId` | 记忆库 Space ID。控制台记忆库详情页 URL 的 `id` 参数就是它 |
| `apiKey` | 记忆库详情页「API Key」处复制/下载的值。**存入本机凭据库**，不进配置文件，页面也读不回来 |
| `actorId` | 可选。记忆按 actor 隔离，**必须和写入侧一致**，否则检索会静默返回空（HTTP 200、零记录、不报错） |
| `region` | 默认 `cn-southwest-2`（西南-贵阳一） |
| `baseUrl` | 覆盖数据面地址；留空则由 region 推导 |
| `topK` / `minScore` / `rerank` / `onlyActive` | 检索默认值 |

页面上有「测试连接」：它用表单里**还没保存**的值真的请求一次 AgentArts，
直接把「Key 对不对、Space 能不能读」答在这里，而不是让你发一条消息等失败。
成功会报出当前可读的记忆条数。

`spaceId` 是配置而不是工具参数，是故意的：模型不该能把自己指到别人的记忆空间去。

### 页面背后的三条路由

| 路由 | 作用 |
| --- | --- |
| `GET /dsh-agentarts-memory/status` | 当前生效的端点、Space、凭据**来源**（不返回值） |
| `POST /dsh-agentarts-memory/probe` | 用表单里的候选值试连一次 |
| `POST /dsh-agentarts-memory/save` | 保存：API Key 进凭据库，其余字段走 `configEditor.edit` 校验并重载 |

写操作（`probe` / `save`）**只接受本机回环地址**：页面本身可能从别的机器可达，
一个不带鉴权的 `POST` 会让那台机器改掉本机配置。

### 端点

数据面：`https://memory.<region>.huaweicloud-agentarts.com`。
记忆库管理/控制面在 `https://agentarts.<region>.myhuaweicloud.com`，本插件不用它。

## 工具

`agentarts_memory`，`action` 取 `status` / `list` / `search`：

| 参数 | 用于 | 说明 |
| --- | --- | --- |
| `query` | search | 检索文本，1-2000 字符 |
| `strategy_type` | list / search | `semantic` / `summary` / `user_preference` / `episodic` / `procedural` |
| `memory_type` | search | `memory` / `episode` / `reflection` |
| `top_k` | search | 1-50 |
| `min_score` | search | 0-1 |
| `limit` / `offset` | list | `limit` 1-100，`offset` 从 0 开始 |

对应接口：

- `GET /v1/core/spaces/{space_id}/memories`
- `POST /v1/core/spaces/{space_id}/memories/search`

## 已知限制

- **只读**。写入记忆、删除记忆都不在工具里；那是控制台的活，而且一次错的语义写入会污染此后所有检索。
- 检索要经过一次跨公网调用，`rerank` 默认关闭以省时延。
- 记忆库的「短期记忆 / 消息」接口不在这个插件范围内，只做了长期记忆。

### 记忆空间必须允许公网访问

如果记忆库只允许 VPC 内访问，带合法 Key 调用数据面会返回：

```
AgentArts.01020003: Public network access is disabled for this space
```

这不是 Key 的问题（**认证已经通过**，否则报的是 `Authentication required`），
是华为云控制台里这个记忆空间的**公网访问开关**没开。要么在控制台打开它，
要么把 DSH 部署进同一 VPC。插件侧没有绕过的办法。

## 排障

| 现象 | 原因 |
| --- | --- |
| 页面能开，点按钮报 `非 JSON 响应 (HTTP 405)` | Host 路由没挂载：插件激活比 `webServer` 早。已在 `apply` 里改用 `ctx.inject(['webServer'])` 延迟注册；若仍出现，重启 DSH。 |
| `设置页通道未挂载（HTTP 405）` | 同上，页面现在会直接说清楚，而不是报「非 JSON」。 |
| `Public network access is disabled` | 记忆空间的公网访问开关没开，见上。 |
| `Authentication required: please provide a valid API Key` | Key 无效或没填。 |
| 检索返回 HTTP 200、零结果、不报错 | `actorId` 与写入侧不一致。 |

## 与本机其它插件的关系

- 装的是 `@local/dsh-agentarts-memory`，row id 与包名同名，通过 `install_bundle` 安装。
- 两半：Host（`lib/index.js`）给模型工具和路由，Client（`lib/client.js`）注册设置页。
- `@deepseek-ai/schemastery` 随包内置在 `node_modules/` 里：这个插件以 `link:` 方式装进
  profile，Node 从插件自己的目录解析依赖、不会向上找到 profile 的 `node_modules`。
  内置的那份缺失时插件仍然可用（工具和设置页都走自己的路由），只是「内置插件」里
  那一行的 schema 表单会没有。
- `lib/config.js` 的 `ensureConfig()` 会在 `apply` 时重建 schema：如果 Host 进程第一次
  导入本模块时 `schemastery` 还不可解析，模块被 Node 永久缓存住的是 `undefined`，
  禁用再启用这一行并不会重新求值模块——这一步把那份绑定补回来，不用重启。
