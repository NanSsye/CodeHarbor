# CodeHarbor Gateway source baseline

此目录保存 CodeHarbor 桌面端计划采用的 aCode Gateway 上游源码基线。

- 上游仓库：`https://github.com/BEelzebub594/aCode`
- 记录的上游 HEAD：`53189003c7ef9d49581b7bc022561024bb18d3bd`
- 本机运行发行版：`aCode-server-windows-x64-1.0.3-17`
- 主要服务源码：`acode-upstream/server/src/`
- 远程中继参考：`acode-upstream/official-relay-client/`

## 目录说明

- `server/`：Gateway HTTP 服务、Codex bridge、任务、认证、SQLite、附件和审计源码。
- `official-relay-client/`：官方中继客户端参考实现，后续用于 CodeHarbor 设备出站连接设计。
- `scripts/`：服务端打包脚本。
- 根目录 `package*.json`、`tsconfig*`、`tsup.server.config.ts`：构建配置。
- `relay-design-spec.md`：上游中继设计参考。

## 有意未复制

为了保持 CodeHarbor 独立且避免把运行时/用户数据提交进项目，本次没有复制：

- `runtime/`、Node.js、SQLite 和 `node_modules`
- `%APPDATA%\aCode-server\config.env`
- Codex `state_5.sqlite`、历史任务、附件和备份
- 已编译发行目录中的 `server/dist/`
- 上游移动端 `app/`、小程序 `miniprogram/` 和独立 `relay/` 应用

上游源码仍受其 `LICENSE` 约束。CodeHarbor 后续修改应保留来源、许可证和版本记录，并通过独立的 CodeHarbor 设备协议与云端连接，不直接把上游 HTTP 管理接口暴露给浏览器。

## 下一步

1. 阅读 `server/src/codexBridge.ts`、`threads.ts`、`auth.ts` 和 `main.ts`。
2. 为 CodeHarbor 定义版本化设备协议和出站 WSS 通道。
3. 将 aCode 的本地管理 API 与云端多租户 API 分开。
4. 在修改上游源码前先补协议探针和回归测试。
