# CodeHarbor

> 将本机 Codex 开发环境安全地带到手机网页。

在线工作台：**[code.pixlnan.com](https://code.pixlnan.com)**

CodeHarbor 是一个开源的远程 Codex 工作台：Windows 桌面客户端在本机运行 Gateway，云端 Go Relay 负责账号、设备配对、浏览器 HTTPS/WSS 和实时事件转发。代码、项目文件和 Git 操作仍留在用户自己的电脑上。

## 能做什么

- 手机浏览器登录并查看项目、会话和实时流式回复
- 工具调用、审批请求、文件变更和子代理关系实时展示
- `confirm` 审批模式与用户明确选择的 `full-access` 模式
- 事件游标、断线恢复、会话分支和设备配对/撤销
- Windows 可视化客户端：登录、注册入口、Gateway 启停、日志和托盘最小化
- 文件附件上传以及 Codex 生成文件回传下载

## 架构

```text
手机浏览器  ── HTTPS/WSS ──>  Go Relay + PostgreSQL/Redis
                                   ▲
                                   │ 出站 WSS
Windows CodeHarbor ──> 本机 Gateway ──> Codex app-server
```

云端不执行 Codex 命令，也不要求浏览器直连用户电脑。浏览器和桌面客户端均通过认证后的 WSS 通道通信。

## 快速开始

### Windows 用户

从 [Releases](https://github.com/NanSsye/CodeHarbor/releases) 下载最新版 `CodeHarbor-Setup-*-x64.exe`，安装后：

1. 输入本机 Gateway 账号和密码。
2. 注册或登录 CodeHarbor 云端账号。
3. 启动 Gateway，打开工作台即可使用。

客户端内置 Node.js，不需要另行安装 Node。安装包发布页同时提供 SHA-256 校验值。

### 从源码运行 Gateway/Web

要求：Node.js 20+、已安装并可执行的 Codex CLI。

```bash
cd gateway/acode-upstream
npm ci
npm run check
npm run build
npm run server:start
```

网页开发服务器：

```bash
cd gateway/acode-upstream
npm run app:dev
```

### 构建 Windows 安装包

```powershell
cd gateway/acode-upstream
npm ci
npm run server:build
npm --prefix desktop ci
npm --prefix desktop run dist
```

输出位于 `gateway/acode-upstream/desktop/dist/`。发布前请核对安装包 SHA-256，并使用 Windows 代码签名证书签名。

### 运行 Go Relay

```bash
cd cloud-relay-go
go test ./...
go build -o codeharbor-relay .
```

生产环境应通过 Docker Compose 提供 PostgreSQL、Redis、Relay 和 Web，并将 8900 仅暴露给受信任的 TLS 反向代理。环境变量模板和协议说明见 [`documentation/variables.md`](documentation/variables.md)。

## 文档

- [架构](documentation/architecture.md)
- [核心流程](documentation/flows.md)
- [权限与审批](documentation/permissions.md)
- [协议 v1](documentation/protocol.md)
- [环境变量](documentation/variables.md)
- [测试与发布门禁](documentation/tests.md)
- [路线图](documentation/roadmap.md)

## 安全边界

- 不要提交 `.env`、数据库、Redis 快照、Gateway 事件目录或本地 Codex 状态。
- 生产密钥只通过服务器 Secret/环境变量注入，绝不写入网页、URL 或 Git。
- 原始 Codex 事件只发送给已认证且已授权的账号/设备；事件可能包含用户主动输入的源码、路径或其他敏感内容。
- `full-access` 会允许 Codex 在本机执行其请求的高风险动作，仅应由用户明确选择。
- 对公网部署必须使用 HTTPS/WSS、可信代理网段、数据库备份和日志轮转。

## 开源许可

CodeHarbor 采用 AGPL-3.0。Gateway 部分基于 aCode 上游并保留其许可证与版权声明；详见 [`gateway/acode-upstream/LICENSE`](gateway/acode-upstream/LICENSE)。

## 项目状态

核心协议、Gateway、Go Relay、网页和 Windows 客户端已经具备可运行实现。万人并发、双 Relay 高可用、PITR、真实移动端长连接和完整生产灾备仍属于发布门禁项目，详见测试文档；欢迎提交 Issue 和 Pull Request。
