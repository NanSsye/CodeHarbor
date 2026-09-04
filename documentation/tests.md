# Tests

CodeHarbor 已建立 Go Relay 单元/协议测试、Node/前端 TypeScript 检查和构建门禁。下表区分当前已通过的自动化证据与仍需 guarded live 的真实环境验收；不能用健康检查替代后者。

## Existing coverage

| 层级 | 当前门禁 |
|---|---|
| Node Gateway | `npm run server:check`、`npm run app:check`、`npm run build`；`app/` 内独立 `npm run build` |
| Go Relay | `go test -count=1 ./...`、`go vet ./...` |
| Compose | `docker compose config --quiet`；Relay Dockerfile 已通过本地源码构建 |
| 安全/依赖 | `npm audit --omit=dev --audit-level=high`（当前 0 vulnerabilities；开发环境仍需按发布节点复核） |

## Proposed tests

| 用例 | 规则 | 预期（含拒绝） | 类型 | 状态 |
|---|---|---|---|---|
| 配对设备 | 配对码一次性且短时有效 | Relay 生成 6 位/10 分钟配对码，登录消费后绑定设备；自动测试已通过，真实手机入口仍待验收 | 自动集成 + guarded live | partial |
| 设备撤销 | 撤销立即阻断命令 | `POST /api/v1/devices/:id/revoke` 的持久化、当前连接关闭、跨账户拒绝、未绑定连接关闭、共享撤销键和 Redis 跨实例关闭自动测试已通过；真实手机旧连接与重新配对仍待验收 | 自动集成 + guarded live | partial |
| 任务流式输出 | 事件按账户/任务隔离 | Relay WS 鉴权、订阅隔离、事件回放和跨实例通道已有自动测试 | 自动集成 | passed |
| 子代理事件 | 仅显示协议实际暴露的事件 | `thread/fork`、`subagent-*` 归一化已接线；桌面专属事件仍未暴露 | guarded live | partial |
| 模型切换 | 仅允许白名单值 | 动态 `model/list`、无效模型拒绝和 effort 覆盖已真实验证 | 自动集成 + guarded live | passed |
| 工作区边界 | 只能访问授权目录 | realpath、符号链接越界和下载路径边界已有代码/测试覆盖 | 自动/安全测试 | passed |
| 附件输入 | 限制大小并拒绝畸形编码 | 15 MiB 解码上限、约 20 MiB Base64 预解码上限和严格格式校验；17 项 Gateway 测试通过 | 自动/安全测试 | passed |
| Relay 代理 body | 代理请求不被超大 Base64 耗尽 | 16 MiB 解码上限及约 22.4 MiB 编码预检，超限请求在解码前返回 413 | 自动/安全测试 | passed |
| Codex stdout/RPC 护栏 | 异常 app-server 输出不耗尽内存 | stdout 未换行缓冲上限 32 MiB、pending RPC 上限 1,024；超限回归通过 | 自动/安全测试 | passed |
| Codex 策略缓存 | 长期线程不会造成策略映射无界增长 | per-thread 策略缓存限制 10,000 条并按最近使用淘汰 | 自动/安全测试 | passed |
| Git 推送 | 副作用动作二次确认 | 当前未提供独立 Git 推送 API，需产品入口后再做 guarded live | guarded live | not-implemented |
| 断线恢复 | 命令幂等且设备可重连 | resume、重放、过期/重放审批已有测试；真实手机长连接仍待验收 | 自动集成 + guarded live | partial |
| 工作区越权 | 已知线程 ID 不能绕过允许目录 | legacy turn/fork、读取、事件、interrupt/stop/approval 均复核可信 cwd；静态/类型检查通过，真实多设备仍待验收 | 自动/安全测试 + guarded live | partial |
| 乐观消息去重 | 同一 clientRequestId 只显示一次 | eventSeq 回显优先按 clientRequestId 去重；创建/分叉事件与响应按 ID 合并 | 前端构建 + 手工事件探针 | passed |
| WSS 凭证传输 | 生产令牌不进入 URL | subprotocol/Cookie 自动测试通过；生产默认拒绝 query token，显式迁移开关回归通过 | 自动/安全测试 | passed |
| 生产配置边界 | 高风险 Secret 和 Origin 必须显式满足最小长度/非空要求 | `TestValidateProductionConfig` 覆盖有效配置及五类缺失/过短配置 | Go 单元测试 | passed |
| 历史保留缺口 | 旧游标不应无限重试 | Relay resume 发送 `history-gap`，HTTP 返回 `historyGap/availableFrom`，客户端推进到保留窗口起点前；真实启用保留策略后的手机提示仍待验收 | 自动集成 + guarded live | partial |
| Redis 半断 | 外部依赖异常不阻塞实时读循环 | Publish/Set/Eval/鉴权查询最长 3 秒返回；账户注销写共享撤销键失败返回 503 且本地撤销仍生效；跨实例事件可由游标恢复 | 自动回归 + 故障注入 + 集成 | partial |
| PostgreSQL 半断 | 存储故障不挂死 WebSocket 处理 | Relay WebSocket 存储操作统一 15 秒上下文；真实数据库故障注入仍待发布节点 | 故障注入 + 集成 | partial |
| 就绪探针超时 | 依赖半断时快速失败 | `/readyz` PostgreSQL/Redis 检查均有有限上下文；真实故障注入和负载均衡摘除仍待发布节点 | 自动 + 故障注入 | partial |
| HTTP 依赖上下文 | 普通 API 半断不无限占用 handler | `/api/*` 与 `/readyz` 统一 15 秒 deadline，`/ws` 生命周期不受影响；真实数据库故障注入仍待发布节点 | 自动 + 故障注入 | partial |
| 设备单活租约 | 双 Relay 不重复接收同一设备 | Redis SETNX 租约、TTL 续租、配对 ownership 原子迁移和条件释放；跨实例真实断线/接管仍待发布节点 | 集成 + 故障注入 | partial |
| 设备连接 admission | 未认证连接不能耗尽 Relay | `/relay/device` 总连接数与单 IP 上限自动回归通过；公网边缘限流和真实高并发仍待发布节点 | 自动 + 压测 | partial |
| Docker 上下文隔离 | 构建不携带本地会话/密钥样本 | Relay 镜像完整构建通过；Web Node builder 构建通过且上下文约 97 KiB；完整 Nginx 阶段需发布节点复核 | 构建门禁 | partial |

## Gaps

- Codex app-server 版本兼容性和桌面专属子代理事件：当前版本没有完整事件出口。
- 浏览器、云端、Gateway、Codex 四段端到端链路：仍需真实手机验收。
- 双 Relay 多实例设备状态、代理响应和压力：仍需真实环境压测。
- Git 提交/推送/PR 的真实外部副作用：当前没有独立产品入口，不能声称已验收。
- PITR、备份恢复、生产数据库最小权限和万人并发：仍是发布前置项。

## CI gate（计划）

合并主分支前至少要求：类型检查、单元测试、协议契约测试、Secret 扫描、依赖审计和构建产物检查。真实 Codex/设备测试属于 guarded live gate，不用模拟测试冒充。
