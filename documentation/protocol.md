# CodeHarbor Gateway Protocol v1

状态：客户端协议 v1 已冻结（事件游标、重连恢复、子代理关系持久化）；文件上传与受限下载已接入。

## 原始 Codex 事件

按当前产品决策，已认证且已授权的网页客户端可以接收原始 Codex 事件，不做内容脱敏或字段裁剪。Gateway 通过 WebSocket 发送：

```json
{
  "type": "codex",
  "method": "item/commandExecution/outputDelta",
  "params": { "threadId": "...", "turnId": "...", "delta": "..." }
}
```

原始事件只对已通过 `/api/auth/login` 或 Gateway session 认证的连接广播；未来云端接入时必须在云端按账户、设备、工作区和任务授权后再转发，不能把该通道变成公共订阅。`session-output` 等 Gateway 归一化事件继续保留，网页可按需选择原始或归一化视图。

## 连接

- HTTP：Gateway 本地 API，使用 `Authorization: Bearer <session-token>`。
- WebSocket：使用 subprotocol `codeharbor-v1.<session-token>` 建立 `/ws` 连接，连接成功先收到 `gateway-ready`。生产默认拒绝 `?token=`；只有在明确的旧客户端迁移窗口设置 `CODEHARBOR_ALLOW_QUERY_TOKEN=true` 才临时开放。
- 登录成功后 Relay 同时设置 `HttpOnly; Secure; SameSite=Strict` 的 `codeharbor_session` Cookie。浏览器刷新时可调用 `GET /api/v1/auth/session-token` 取得仅驻留内存的 WSS 会话令牌，从而不必把账户令牌写入 `localStorage`。
- RelayClient 到本机 Gateway 的 loopback `/ws` 同样使用 subprotocol，避免固定 Gateway token 出现在 Fastify 访问日志；旧 query token 仅保留旧客户端兼容。
- 会话列表：`GET /api/v1/sessions` 返回 `sessions`，最多 10,000 条；超过上限时返回 `truncated: true`。事件历史继续使用 `after`/`nextCursor` 分页。
- Relay 事件历史默认不删除；设置 `CODEHARBOR_EVENT_RETENTION_DAYS` 为正整数后会按天回收旧事件。启用回收意味着旧游标可能落在已删除区间，客户端必须在发现历史缺口时重新同步会话，而不能假定所有序号永久可得。
- Relay 浏览器订阅设备时可发送 `{"type":"subscribe","deviceId":"<id>","replace":true}`；`replace:true` 会清除该浏览器此前的设备订阅，避免切换设备后继续接收旧设备事件。未提供时保持兼容的追加语义。
- `gateway-ready.payload.eventCursor` 返回每个会话当前最新的 `eventSeq`。
- 客户端重连后发送 `{"type":"resume","cursors":{"<session-id>":42}}`；Gateway 按会话补发 `eventSeq > 42` 的归一化事件，最后发送 `resume-complete`。
- 当 Relay 启用了事件保留并发现请求游标早于当前保留窗口时，会先发送 `history-gap` 控制帧：`{"type":"history-gap","payload":{"sessionId":"<id>","requestedCursor":42,"availableFrom":900,"latestCursor":1200}}`。客户端应把该会话游标重置为 `availableFrom - 1`，继续接收/请求保留历史；被清理的前缀不可恢复。
- `eventSeq` 从 1 开始、按会话单调递增并持久化到 `gateway-data/events/<session>.jsonl`；客户端必须去重并只推进已连续收到的序号。游标不是全局序号，不能跨会话复用。
- 文件下载通过已认证的 Gateway 代理请求 `GET /files/download?sessionId=<id>&path=<workspace-relative-or-absolute-path>`；Gateway 只允许当前会话工作区且位于 `GATEWAY_ALLOWED_PATHS` 内的普通文件，单文件上限 8 MiB，返回 `Content-Disposition: attachment`。网页不得把该接口扩展为任意路径读取。
- `protocolVersion` 固定为 `codeharbor.gateway.v1`；不兼容变更递增主版本。
- 本机 Gateway 的 `GET /api/models` 读取 Codex `model/list`，网页通过已认证的设备代理加载当前电脑实际可用模型；模型列表不可用时不得把静态预设当作可用性保证。
- 所有客户端写请求应携带 `requestId`（客户端生成的幂等键）、`sessionId`（适用时）和 `expiresAt`（ISO 时间，适用时）。Gateway 必须拒绝过期请求。
- `POST /sessions` 的 `clientRequestId` 会持久化到 `gateway-data/create-requests.json`；同一请求重试返回原会话并标记 `duplicate`，不会再次创建 Codex thread。

## 云端 Relay API

云端 `cloud-relay-go` 对浏览器提供 HTTPS `/api/v1`，并通过同一账户令牌保护 WSS `/ws`。当前公开能力包括：

- `POST /api/v1/auth/login`：支持管理员账号密码登录，也支持首次设备的 6 位配对码登录；配对码默认 10 分钟有效且只能消费一次，成功后返回 30 天 HMAC 令牌和 `deviceId`。`POST /api/v1/auth/refresh` 滚动续期，`POST /api/v1/auth/logout` 持久撤销当前令牌。
- `POST /api/v1/auth/register`：创建普通 CodeHarbor 账号。账号名 3–64 位，仅允许字母、数字、点、下划线和短横线；密码至少 12 位。密码仅以 bcrypt 哈希持久化，注册成功直接返回当前账户会话；重复账号返回 409。
- `POST /api/v1/devices/enroll`、`GET /api/v1/devices`、`POST /api/v1/devices/:id/revoke`：账户绑定设备、查询在线状态并撤销自己的设备；设备 ID 统一限制为 256 字节以内且不含路径分隔符/控制字符。撤销会持久化失效凭证，写入共享 Redis 撤销键，并关闭当前 Relay 和 Redis 广播覆盖的其他 Relay 实例上的现有设备连接。
- `GET /api/v1/sessions`、`GET /api/v1/sessions/:id/events`：账户隔离的会话元数据和事件游标回放。
- 浏览器 WSS 消息使用 `gateway-proxy` 发送请求，Relay 按 `deviceId` 路由；Redis Pub/Sub 用于多实例事件、代理请求/响应、设备在线 TTL 和令牌撤销广播。
- 生产 Redis 同时维护设备单活租约：Relay 以随机连接 token 通过 SETNX 抢占 `codeharbor:device-presence:<deviceId>`，按消息续租并在断开时条件释放；配对时通过 ownership 广播原子把未绑定租约迁移到账号，撤销键会在续租 Lua 中被检查；同一设备在不同 Relay 实例上的第二条连接会被拒绝，避免命令重复投递。
- 账户注销会把令牌哈希写入带同等 TTL 的共享 Redis 撤销键并广播撤销事件；API 和浏览器 WSS 鉴权在 Redis 不可用时 fail-closed。注销/设备撤销若无法完成跨实例传播返回 `503`，但本地撤销已经落库并立即生效。

`GET /api/v1/protocol` 返回 `revision: 2`、`session-sync`、`event-seq`、`resume`、`history-gap`、`approval`、`device-enrollment`、`device-revocation`、`cookie-auth`、`ws-subprotocol-auth`、`full-access-confirmation` 和 `model-list` 能力。Relay 只转发已授权设备的消息，不执行 Codex 命令。

## 会话策略

`sessionPolicyMode` 只有两个值：

- `confirm`：默认值。Codex 高风险请求转为 `approval-requested`，等待明确决策。
- `full-access`：用户明确选择后启用；Gateway 使用完全访问策略并自动批准。

`full-access` 必须是会话级显式字段，不能由任意 CLI 参数或隐藏 HTTP 字段覆盖。所有新建会话、从 `confirm` 切换到 `full-access`、以及把新分叉会话设为 `full-access` 的请求，还必须携带 `confirmFullAccess: true`；缺少该字段一律拒绝。已有会话已经处于 `full-access` 时，后续普通 turn 不需重复确认。导入历史会话默认按 `confirm` 处理。

## 审批事件

Gateway 在 `confirm` 模式收到 Codex server request 时发送。按当前产品决策，已认证且已授权的网页接收原始字段，不做内容脱敏；连接认证、账户/设备/会话/工作区授权仍然是强制边界：

```json
{
  "type": "approval-requested",
  "sessionId": "<thread-id>",
  "requestId": "<gateway-request-id>",
  "timestamp": "<iso>",
  "payload": {
    "requestMethod": "item/commandExecution/requestApproval",
    "turnId": "<turn-id>",
    "itemId": "<item-id>",
    "summary": "<原始结构化摘要>",
    "command": "<原始结构化命令>",
    "cwd": "<授权工作区内路径>",
    "expiresAt": "<iso>"
  }
}
```

客户端通过 `POST /sessions/:id/approvals/:requestId` 决策：

```json
{ "decision": "approve", "requestId": "<same-id>" }
```

或：

```json
{ "decision": "deny", "requestId": "<same-id>" }
```

决策必须一次性消费、绑定会话和当前 turn，重复、过期、越权或未知请求一律拒绝。决策结果广播 `approval-resolved`，并写入审计日志。

## 子代理与分叉线程

父子关系已冻结为持久化数据：Gateway 写入 `subagent-relations.json`，同时在会话记录中维护 `parentSessionId` 与 `childSessionIds`。Gateway 重启后从该文件恢复关系，并用恢复的关系把子线程终态继续归一化为 `subagent-finished`。关系写入以 `(parentSessionId, childSessionId)` 幂等；删除会话时会同步清理相关关系，避免恢复出悬空父子节点。

Codex `0.147.0` 的 app-server 暴露 `thread/fork`，但没有独立的 `subagent/*` RPC。调用 `thread/fork` 后会返回并广播新的 `thread`，其 `forkedFromId` 指向父线程；当前返回的 `parentThreadId` 可能为空，因此客户端应以 `forkedFromId` 建立父子关系。Gateway 提供：

- `POST /sessions/:id/fork`：从已存在的会话创建分叉会话；
- `session-forked`：包含 `sessionId`、`parentSessionId` 和 `forkedFromId` 的归一化事件；
- 原始 `thread/started` 等 Codex 事件继续通过 `type: "codex"` 透传。

需要特别区分：Codex 桌面层的 `create_thread`/`spawn_agent` 是桌面编排器行为，不是这个 app-server 连接上的 RPC。桌面层会在 session 元数据中写入 `source.subagent.thread_spawn.parent_thread_id`、`agent_role` 等字段，并通过桌面内部的任务调度/等待工具传递进度；Gateway 当前只持有自己的 app-server stdio 管道，既不会收到这些桌面事件，也不应通过扫描全部 `~/.codex/sessions` 冒充实时订阅。要完整转发桌面子代理，必须让 Gateway 成为桌面编排器的事件出口（官方 desktop/remote-control 事件 API 或插件），或者由桌面层显式把子代理事件转发到 Gateway。

真实 Gateway 探针已确认：子线程 prompt 会产生 `item/completed` 内嵌的 `subAgentActivity`（含 `agentThreadId`、`agentPath`）和 `collabAgentToolCall`（含 `tool`、`status`、`senderThreadId`、`receiverThreadIds`）。Gateway 将它们归一化为 `subagent-started`、`subagent-tool`；并记录子线程到父线程的映射，在子线程 `thread/status/changed` 进入完成、失败或取消时生成 `subagent-finished`，同时保留原始 `type: "codex"` 事件。

## 事件兼容

Gateway 原样保留 Codex 事件的 `eventType` 和 `jsonPayload`。按当前产品决策，已认证且已授权的网页可以接收原始字段；未知事件使用 `codex-event` 透传，不因未知事件中断会话。访问控制仍由连接认证、会话/工作区授权和连接隔离保证。

## GitHub 方案调研（2026-09-03）

以下项目已通过 GitHub 仓库元数据核对，作为“手机浏览器可用”的候选，不直接复制其认证或执行边界：

| 项目 | 用途 | 取舍 |
| --- | --- | --- |
| [open-webui/open-webui](https://github.com/open-webui/open-webui) | 移动端友好的 AI 对话前端 | 功能完整、星标高；协议是 OpenAI/Ollama 风格，需要写 CodeHarbor 适配层，不能直接显示 Codex 原始事件 |
| [danny-avila/LibreChat](https://github.com/danny-avila/LibreChat) | 多模型、多用户 Web 前端 | MIT、已有 Agents/MCP；体量大，适合作为交互参考或后续可选壳，不宜现在嵌入 Gateway |
| [tsl0922/ttyd](https://github.com/tsl0922/ttyd) | Web terminal/PTY | MIT、移动端终端交互成熟；它暴露的是 shell，不符合审批协议，不能替代 Gateway |
| [butlerx/wetty](https://github.com/butlerx/wetty) | 浏览器终端 | MIT；同样缺少会话级审批、事件游标和 Codex 语义 |
| [coder/code-server](https://github.com/coder/code-server) | 手机浏览器中的完整 IDE | MIT、成熟但过重；适合开发工作区，不适合作为轻量 Codex 客户端 |

冻结结论：网页首版自研轻量 PWA，直接消费本协议的 HTTP/WebSocket；借鉴 Open WebUI 的对话布局和 ttyd 的窄屏终端交互，不把上述项目作为执行后端或安全边界。

## 当前实现状态

Gateway 已按会话记录 `confirm` / `full-access` 策略；`confirm` 模式使用 `readOnly` 沙箱，审批请求会挂起并通过 `POST /sessions/:id/approvals/:requestId` 决策，`full-access` 模式自动批准。会话同步携带策略字段并写入 Relay PostgreSQL，策略变更会即时同步，刷新后仍保持选择。停止接口先本地收敛为 `cancelled`、释放 turn gate，再后台尽力调用 Codex `turn/interrupt`；取消期间迟到的 turn 启动会被运行代次令牌丢弃，前端优先携带当前 `turnId`。模型列表已通过本机 `model/list` 动态读取；审批重放、TTL 过期和 amendment 的隔离路径已接入，但仍需要真实任务中的完整回写验收，不能视为生产验收完成。子代理目前可通过 `thread/fork` 实现父子会话和 `session-forked` 事件，独立子代理生命周期事件仍取决于 Codex 后续 app-server 暴露。

云端统一采用 Go 服务（`cloud-relay-go/`），同时提供业务 API 和实时 `/ws`、`/relay/device`；Node 仅保留在本机 Gateway，不作为云端后端。Go Relay 已接入 PostgreSQL 会话/事件存储、Redis Pub/Sub 事件广播和代理请求/响应跨实例路由；生产启动强制要求 `DATABASE_URL`、`REDIS_URL`、设备/浏览器令牌、认证密钥、管理员密码及允许的 Origin。不得恢复已删除的 Node 云端联调服务。

运行时加固还包括：Relay 和本机 Gateway 对慢 WebSocket 客户端按字节背压并主动关闭，Relay 收到 SIGTERM/SIGINT 时优雅停机；云端 JSON API 默认 `Cache-Control: no-store`。Web 容器采用 Gateway 根目录作为 Docker 构建上下文，前端在容器内使用锁文件重新构建，不依赖提交目录中的旧 `dist`。

云端生产启动要求 `NODE_ENV=production` 时必须显式提供至少 32 字符的 `CODEHARBOR_CLOUD_TOKEN`、`CODEHARBOR_DEVICE_TOKEN`、`CODEHARBOR_AUTH_SECRET`，至少 12 字符的 `CODEHARBOR_ADMIN_PASSWORD`，以及非空 `CODEHARBOR_ALLOWED_ORIGIN`；缺失或过短会启动失败。浏览器和 Gateway WebSocket 使用固定间隔心跳，连接关闭时清理关联请求。
