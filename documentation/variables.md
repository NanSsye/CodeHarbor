# Variables and Secrets

| 名称 | 使用方 | 范围 | 来源 | 轮换/撤销 | 风险 |
|---|---|---|---|---|---|
| `CODEHARBOR_ACCOUNT_SESSION` | 云端/浏览器 | 云端会话 | 安全 Cookie | 过期、登出 | 高 |
| `CODEHARBOR_DEVICE_PRIVATE_KEY` | Gateway | 仅本机 | 首次安装生成 | 设备撤销并重新绑定 | 极高 |
| `CODEHARBOR_DEVICE_TOKEN` | Gateway→云端 | 设备通道 | 配对后签发 | 可撤销、定期轮换 | 高 |
| `CODEX_AUTH` | Codex/Gateway | 仅本机 | Codex 登录流程 | 按 Codex 机制 | 极高 |
| `DATABASE_URL` | 云端 Relay | 服务端 | 部署密钥管理 | 轮换 | 极高 |
| `REDIS_URL` | 云端 Relay | 服务端 | 部署密钥管理 | 轮换 | 高 |
| `CODEHARBOR_AUTH_SECRET` | 云端 Relay | 服务端 | 部署密钥管理 | 轮换 | 极高 |
| `CODEHARBOR_ADMIN_PASSWORD` | 云端 Relay | 服务端 | 部署密钥管理 | 轮换 | 极高 |
| `CODEHARBOR_AUTO_MIGRATE` | 云端 Relay | 启动迁移开关 | 部署配置 | 发布时复核 | 中 |
| `CODEHARBOR_EVENT_RETENTION_DAYS` | 云端 Relay | 事件保留窗口；0 为永久 | 部署配置 | 发布时复核 | 高 |
| `ADMIN_TOKEN` | 本机 Gateway | 仅本机服务 | 初始化配置 | 轮换并重启 | 极高 |
| `SESSION_SECRET` | 本机 Gateway | 仅本机服务 | 初始化配置 | 轮换并重启 | 极高 |

## 规则

- 不把任何 Secret 打进前端 bundle、日志、任务事件、错误信息或文档示例；协议允许的原始 Codex 内容不等于允许转发 Secret。
- 浏览器只能获得短期云端会话；不下发 Codex/API 密钥。
- 设备私钥不可导出到云端；解绑后服务端拒绝旧公钥。

## 上线前检查

- 设备配对、撤销、重放和过期测试通过。
- 云端租户隔离和越权拒绝测试通过。
- 原始事件的认证/账户/设备/工作区边界、附件大小和本机路径过滤测试通过。
- Secret 扫描、构建产物检查和日志抽样完成。
- 备份、密钥轮换和设备 kill switch 已演练。
