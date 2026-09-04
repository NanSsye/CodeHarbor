# aCode

aCode 是一个远程接管本机 Codex 任务的工具，当前拆成两个部分：

- `server/`：本机 Gateway 服务端，基于 Node.js/Fastify/WebSocket，可在 macOS、Windows运行，不依赖 Docker。它是执行端，不是云端后端。
- `../cloud-relay-go/`：云端 Go WebSocket Relay，负责大量浏览器与 Gateway 长连接及消息路由。
- `app/`：移动客户端 App，目前包含 Android 和 iOS，通过 HTTP 和 WebSocket 连接服务端，用来查看任务、查看历史过程、继续发送消息和同步实时输出。

## 开源协议

本项目采用 `AGPL-3.0` 开源协议。

## 作者说
实在没精力更新和维护，所以开源出来给大家用吧，有一些bug，如果有时间会修。

## 连接模式

aCode 支持两类连接方式：

- 直连模式：客户端直接连接用户电脑上的本地 Gateway，适合同局域网或用户自己有公网入口的情况。
- 中转模式：本地 Gateway 主动连接 Relay，客户端连接 Relay，适合用户没有公网入口但需要外网远程访问。

中转模式是可选项，不会替代直连模式。

- 不配置 `RELAY_URL`：保持原有直连模式
- 配置 `RELAY_URL`：启用 Relay 中转

Relay 可以是：

- 你们提供的官方中转服务
- 用户自己部署的自建中转服务

## 安装

```bash
npm install
cp .env.example .env
```

然后编辑 `.env`，至少设置：

```env
ADMIN_TOKEN=换成一个长随机令牌
SESSION_SECRET=换成另一个长随机密钥
```

## 命令行服务端

## Windows 桌面端

`desktop/` 是 CodeHarbor 的可视化 Windows 客户端。它用 Electron 托管本机 Gateway，首次运行设置本地工作台密码和可选 Relay 账号，随后可查看运行状态、日志、启停 Gateway，并打开生产 HTTPS/WSS 工作台。客户端不需要用户另行安装 Node.js。

构建安装器：

```powershell
npm run server:build
npm run app:build
npm --prefix desktop install
npm --prefix desktop run dist
```

安装器输出到 `desktop/dist/CodeHarbor-Setup-<version>-x64.exe`。用户数据位于 `%APPDATA%/CodeHarbor`，卸载不会删除配置、日志或 Gateway 数据。

开发模式启动：

```bash
npm run server:dev
```

构建并启动独立服务端：

```bash
npm run server:build
npm run server:start
```

一键发行包：

```bash
npm run server:package
```

macOS DMG 发行包：

```bash
npm run server:package:macos
```

Windows x64 发行包：

```bash
npm run server:package:windows
```

普通发行包依赖目标机器已安装 Node.js 20+。macOS DMG 会内置 Node.js 运行时，目标 Mac 不需要单独安装 Node。
Windows ZIP 也会内置 Node.js 运行时，目标 Windows 不需要单独安装 Node。

首次启动会自适应当前机器环境：

- 自动生成长随机 `ADMIN_TOKEN` 和 `SESSION_SECRET`
- 自动选择当前局域网 IP 作为 `PUBLIC_ORIGIN`
- 默认端口 `8787` 被占用时，自动尝试后续端口
- 自动探测 `codex` / `codex.cmd` / `codex.exe`
- 自动探测包含 `state_5.sqlite` 的 Codex 数据目录

如果用户的 Codex 安装或历史目录比较特殊，再手动修改配置文件里的 `CODEX_BIN` / `CODEX_HOME`。

生成目录：

```text
dist-packages/aCode-server-当前版本/
dist-packages/aCode-server-macos-arm64-当前版本.dmg
dist-packages/aCode-server-windows-x64-当前版本.zip
```

发行包内可直接运行：

```bash
./acode-server init
./acode-server doctor
./acode-server start
```

Windows 使用：

```bat
aCode Server.exe
```

命令行模式：

```bat
acode-server.cmd init
acode-server.cmd doctor
acode-server.cmd start
```

macOS DMG 使用：

1. 打开 `dist-packages/aCode-server-macos-arm64-当前版本.dmg`
2. 双击 `aCode Server.app`
3. 终端会输出服务状态信息
4. 当前 CodeHarbor 客户端以手机浏览器/PWA 访问云端 HTTPS/WSS；本仓库没有可发布的 Android/iOS 原生工程

DMG 中也保留了 `Open aCode Server.command`，它只是兼容入口，会打开 `aCode Server.app`。

当前 DMG 未做 Apple 签名和公证。如果 macOS 阻止打开，可以右键点击 `aCode Server.app` 后选择“打开”，或在系统设置的隐私与安全性中允许打开。

默认配置文件位置：

```text
macOS/Linux: ~/.acode-server/config.env
Windows: %APPDATA%\aCode-server\config.env
```

常见自适应失败场景：

- 任务为空：当前服务端机器没有 Codex 历史，或 `CODEX_HOME` 没指向包含 `state_5.sqlite` 的目录
- 手机连不上：电脑和手机不在同一局域网，或防火墙/VPN 拦截了局域网访问
- Codex 启动失败：`codex` 不在 PATH，需设置 `CODEX_BIN`

也可以指定配置：

```bash
./acode-server start --config /path/to/config.env
```

如果启动时提示端口 `8787` 已经有 aCode Server 在运行，启动器不会再启动第二个服务。请继续使用正在运行的服务信息，或先停掉旧服务后再启动新包。

服务端会从当前工作目录读取 `.env`。局域网使用时通常这样配置：

```env
HOST=0.0.0.0
PORT=8787
PUBLIC_ORIGIN=http://你的电脑IP:8787
```

服务端会在本机启动或连接 `codex app-server`，并且只绑定到 `127.0.0.1`，不会直接把 Codex 内部控制端口暴露出去。

## 手机浏览器 / PWA

启动网页开发服务：

```bash
npm run app:dev
```

生产环境由 `cloud-relay-go` 提供 API/WSS，网页从当前 HTTPS 域名自动推导 `/api/v1` 和 `/ws`，登录凭证由 HttpOnly Cookie 与内存中的短期 WebSocket 凭证共同保护。手机直接打开部署后的 HTTPS 地址即可使用，不需要填写局域网地址或把 Codex 凭证放入浏览器。

当前仓库未包含 `app/android`、`app/ios` 或 `capacitor.config.*` 原生工程，因此 Android APK/iOS App 构建命令尚未形成可发布产物；如未来要交付原生客户端，需单独建立原生工程、云端地址配置、证书策略和真机验收，不应把下面的历史上游命令当作当前能力。

## 版本策略

Android 更新判断以 `versionCode` 为准，界面展示用四段 `versionName`：

- 大版本显示：`1.0.3.1`
- 小迭代递增最后一位：`1.0.3.2`、`1.0.3.3`
- `versionCode` 使用可递增整数，例如 `100030001`，确保再小的改动也能被旧 App 识别为可更新
- `package.json` 仍使用 npm 合法 semver，例如 `1.0.3-1`

真机登录时，服务地址填写电脑的局域网地址，例如：

```text
http://192.168.50.55:8787
```

Android 模拟器登录时，服务地址填写：

```text
http://10.0.2.2:8787
```

原生 Android/iOS 客户端目前不在本阶段交付范围内。请以 `documentation/comprehensive-audit-2026-09-04.md` 的发布门禁为准。

iOS 工程已允许本地网络和 HTTP 局域网访问，首次连接局域网服务时系统可能弹出本地网络权限提示。真机安装需要在 Xcode 中选择你的 Team 做签名。

## 常用命令

```bash
npm run check
npm run server:build
npm run app:build
npm run app:android:build:debug
npm run app:ios:sync
```

## 跨平台说明

服务端运行要求：

- Node.js 20+
- 本机已安装并可执行 `codex`
- 如果 `codex` 不在 `PATH`，可以通过 `.env` 设置 `CODEX_BIN`
- 默认读取当前用户目录下的 `.codex`，也可以通过 `CODEX_HOME` 指定

不需要 Docker。macOS、Windows、Linux 都可以直接运行服务端。

## 安全提醒

- 不要提交 `.env`
- `ADMIN_TOKEN` 必须使用长随机字符串
- 远程公网访问时建议使用 HTTPS 反向代理
- App 继续任务会通过本机 Gateway 调用 Codex，请只把服务开放给可信设备
