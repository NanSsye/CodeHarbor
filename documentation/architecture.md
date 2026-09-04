# Architecture

## 状态

协议、Gateway、Go Relay 和移动优先 Web 首版已落地并通过本地门禁；生产级多实例、备份恢复、最小权限和真实手机验收仍是发布门禁。CodeHarbor 是全新项目，不复用 xbot 的运行时、数据库或租户边界。

## 目标架构

```text
Browser
  │ HTTPS / WSS
  ▼
CodeHarbor Cloud API + Realtime Router
  │ authenticated device channel
  ▼
CodeHarbor Gateway.exe (user computer)
  │ loopback WebSocket
  ▼
Codex CLI app-server
  │
  ├─ local project files
  └─ local Git / tools / subprocesses
```

桌面端向云端主动发起连接，适配 NAT、家庭网络和公司网络。浏览器不直接访问用户电脑，也不持有 Codex 凭据。

## 组件职责

| 组件 | 职责 | 不负责 |
|---|---|---|
| Web Console | 账号、设备、项目/任务视图、用户确认 | 直接执行本机命令 |
| Cloud API | 认证、租户隔离、设备授权、命令路由、事件转发 | 读取用户本机源码 |
| Gateway.exe | 启动/连接 Codex、访问本机项目和 Git、执行受控动作 | 账号密码和云端业务数据的最终真相 |
| Codex app-server | Codex 会话、模型推理、工具和子代理执行 | CodeHarbor 账号与计费 |

## 协议边界

Codex app-server 是实验性协议，桌面端必须封装其变化。云端使用版本化的 CodeHarbor 设备协议；Codex 原始字段可以作为已认证事件信封的 payload 转发给浏览器，但浏览器不直接建立 Codex JSON-RPC 通道。

建议消息类型：`device.hello`、`device.heartbeat`、`task.start`、`task.input`、`task.interrupt`、`task.event`、`task.result`、`git.status`、`action.request`、`action.result`。

## 关键数据

- `Account`：网站账户。
- `Device`：绑定的 Gateway 安装实例，含公钥、状态、撤销时间。
- `Workspace`：桌面端授权的项目目录，不等同于云端文件副本。
- `Task`：Codex thread/turn 的云端索引和必要元数据。
- `Event`：经过认证、账户/设备/会话授权和大小限制的任务事件；当前产品决策允许已授权网页读取原始 Codex 字段，不做内容脱敏。
- `ActionApproval`：提交、推送、权限提升等有副作用动作的确认记录。

## 已知风险 / 待验证假设

1. Codex app-server 的子代理事件是否稳定暴露，必须按实际版本抓取真实事件验证。
2. 模型切换字段是否支持按任务或按 turn 覆盖，必须以协议 schema 和真实任务验证为准。
3. Git 推送、PR 创建会产生外部副作用，不能通过任意命令接口实现。
4. 云端默认不保存源码，但任务文本、事件和附件的保存策略仍需产品决策。
5. Gateway 更新、设备撤销、断线重连和协议版本升级需要可回滚。

## Related Documents

- [`flows.md`](flows.md)：主要用户和安全流程。
- [`permissions.md`](permissions.md)：角色、资源和操作矩阵。
- [`automation.md`](automation.md)：Codex、工具和子代理边界。
- [`variables.md`](variables.md)：配置、密钥和设备凭据。
- [`tests.md`](tests.md)：现有/拟议验证及缺口。
- [`roadmap.md`](roadmap.md)：分阶段实施顺序。
