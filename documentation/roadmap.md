# Roadmap

## Phase 0 — Protocol spike

- 固定 Codex CLI/app-server 版本。
- 抓取任务、工具、子代理、模型和中断事件样本。
- 明确哪些字段可稳定映射到 CodeHarbor 协议。
- 输出协议版本和兼容策略。

## Phase 1 — Desktop connector + account binding

- Gateway.exe 启动器、健康检查和本机工作区白名单。
- 云端账号、一次性配对、设备公钥、WSS 心跳和撤销。
- 单账户单设备 MVP。

## Phase 2 — Web Codex workspace

- 类 Codex 的三栏网页布局。
- 项目/任务列表、对话、流式输出、工具状态和停止任务。
- 断线重连、任务幂等、事件脱敏。

## Phase 3 — Local project and Git

- 分支、变更统计、diff、文件列表。
- 提交/推送/PR 的预览、确认、审计和失败恢复。

## Phase 4 — Models, policies, subagents

- 模型白名单和按任务选择。
- 推理强度、沙箱和审批策略。
- 通过真实协议验证后增加子代理树和时间线。

## MVP success criteria

用户能够在另一台设备登录网站，绑定自己的电脑，选择一个本机项目，发送一条任务，看到流式 Codex 回复和工具状态，并安全停止任务；设备离线、越权、非法工作区和未确认 Git 动作必须被拒绝。

## 当前阶段（2026-09-04）

Gateway、Go Relay、网页和协议的本地实现已完成，协议 v1 的事件游标、重连恢复、设备/会话隔离和父子分叉关系已冻结。当前仍是生产前验证阶段：真实手机登录与长连接、审批完整生命周期（含 TTL 和 amendment 回写）、双 Relay/Redis 故障恢复、万人级压测、PITR 备份恢复以及 Linux/amd64 竞态检测尚未完成。发布判定以 `documentation/tests.md` 和最新全面审计为准。
