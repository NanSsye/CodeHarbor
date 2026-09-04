# CodeHarbor Go Relay

云端实时层的 Go 实现：维护浏览器 `/ws` 与桌面 Gateway `/relay/device` 长连接，按 `deviceId` 路由代理请求/响应，并广播 Gateway 事件。Node.js 继续承担本地 Gateway 与业务兼容层。

开发运行：

```powershell
$env:CODEHARBOR_CLOUD_TOKEN="browser-token"
$env:CODEHARBOR_DEVICE_TOKEN="device-token"
go run .
```

生产启动要求设置令牌、`CODEHARBOR_ALLOWED_ORIGIN`、`DATABASE_URL` 和 `REDIS_URL`。PostgreSQL 保存会话/事件，Redis Pub/Sub 负责多实例事件扇出；缺少任一生产依赖时服务拒绝启动。自包含 Compose 默认自动执行幂等 schema；使用最小权限 runtime role 时，应先用迁移账号执行 `schema.sql`，再设置 `CODEHARBOR_AUTO_MIGRATE=false`，避免运行时账号需要 DDL 权限。

事件历史默认永久保留（`CODEHARBOR_EVENT_RETENTION_DAYS=0`）。如需回收磁盘，可设置正整数天数；清理任务会删除窗口外的 `gateway_events`，旧客户端游标无法恢复已删除事件，启用前应先定义客户端重置/重新同步策略。

账号注册接口为 `POST /api/v1/auth/register`，密码仅以 bcrypt 哈希保存，注册成功直接签发 30 天 HMAC 会话令牌；登录接口为 `POST /api/v1/auth/login`，同样设置 HttpOnly/Secure/SameSite Cookie。网页刷新时可调用 `GET /api/v1/auth/session-token` 获取仅驻留内存的 WSS 凭证，已认证客户端也可调用 `POST /api/v1/auth/refresh` 滚动续期。浏览器 WSS 使用 `codeharbor-v1.<token>` subprotocol；生产默认关闭 query token，只有明确设置 `CODEHARBOR_ALLOW_QUERY_TOKEN=true` 才用于限时迁移。

首次未绑定设备会在 `/relay/device` 的 `device-ready` 响应中收到 6 位、10 分钟有效的一次性 `pairCode`。手机或网页可将其作为 `{ "token": "AB12CD" }` 提交到登录接口；成功后设备归属当前管理员账户，配对码立即失效。

健康检查：`GET /healthz` 仅表示进程存活；`GET /readyz` 会检查 PostgreSQL 和 Redis，供负载均衡器决定是否接收流量。
