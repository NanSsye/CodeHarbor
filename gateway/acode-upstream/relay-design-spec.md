# aCode Relay 设计规范

> **历史文档（非当前实现入口）**：本文保留早期 Node Relay/直连方案，仅供迁移参考。生产云端后端统一使用 `cloud-relay-go/`，当前协议、认证、持久化和部署要求以仓库根目录 `documentation/` 及 `cloud-relay-go/README.md` 为准；不要按本文的旧 query-token、SQLite 或 Node 云端示例部署。

## 目标

让没有公网入口的用户电脑也能被外部 App / 小程序远程操作。

核心原则：

- 中转必须是可选项，不改变原有局域网直连模式
- 用户电脑不需要开放入站端口
- 用户电脑只需要能主动访问你的中转服务器
- 客户端继续沿用现有 `HTTP + WebSocket` 访问模型
- 配对入口尽量兼容当前 `serverUrl + token` 的登录界面
- 官方中转域名对终端用户固定内置，不允许修改，也不在登录界面显示

## 模式划分

aCode 需要同时支持三种运行模式：

1. 直连模式

- 用户自己填本地 Gateway 的局域网或公网地址
- 用户直接使用本机 `ADMIN_TOKEN`
- 不依赖 Relay

2. 官方中转模式

- 用户把 `RELAY_URL` 配成你们提供的中转地址
- 客户端内置你们的 Relay 域名，用户不可修改
- 用户使用配对码登录

3. 自建中转模式

- 用户自己部署同协议的 Relay
- 本地 Gateway 指向自己的 `RELAY_URL`
- 客户端填用户自己的 Relay 域名

默认规则：

- `RELAY_URL` 为空时，系统必须完全退回直连模式
- `RELAY_URL` 有值时，系统启用中转能力
- 直连模式和中转模式的业务 API 尽量保持同构

## 总体架构

链路分成三段：

1. 本地 `aCode Gateway`
2. 公网 `aCode Relay`
3. 客户端 App / 小程序

工作方式：

- 本地 Gateway 启动后主动 `WSS` 连接 Relay
- Relay 为该设备签发短期配对码
- 用户在客户端把 Relay 地址作为 `serverUrl`，把配对码当成登录 token 输入
- 客户端后续所有 `/api/*`、`/download/*`、`/ws` 都连 Relay
- Relay 再通过设备长连接把请求转发给本地 Gateway

## 兼容性约束

为了尽量不改移动端，本次 relay 方案遵守以下兼容约束：

- 登录仍使用 `POST /api/auth/login`
- 登录请求体仍是 `{ "token": "..." }`
- 实时事件仍从 `/ws?token=...` 获取
- 任务列表、线程详情、继续执行、更新下载等路径继续保持原有路径

这意味着：

- 旧客户端可以直接把 Relay 当成原来的 Gateway 使用
- 用户不再输入本地电脑 IP，也不需要看到 Relay 域名
- 用户不再输入 `ADMIN_TOKEN`，而是输入配对码

## 本地 Gateway 规范

### 必要配置

本地 Gateway 需要支持以下环境变量：

```env
RELAY_URL=https://relay.example.com
RELAY_SERVER_TOKEN=你的 relay 注册密钥
RELAY_DEVICE_NAME=张三-MacBook
```

说明：

- `RELAY_URL`：Relay 外部访问地址
- `RELAY_SERVER_TOKEN`：首次注册设备时使用的共享密钥，只给电脑端 Gateway 使用
- `RELAY_DEVICE_NAME`：设备展示名称，可选

用户端填写规则：

- 手机 / App 不填写 `RELAY_SERVER_TOKEN`
- 手机 / App 只填写 `serverUrl` 和配对码
- 电脑端 Gateway 才持有 `RELAY_SERVER_TOKEN`

### 本地持久化

Gateway 首次注册成功后，必须把以下标识写到本地持久化文件：

- `deviceId`
- `deviceSecret`

当前实现保存位置：

```text
<GATEWAY_DATA_DIR>/relay-device.json
```

规则：

- 首次连接成功后保存
- 后续重连优先使用 `deviceId + deviceSecret`
- 不再依赖 `RELAY_SERVER_TOKEN`

### 本地事件转发

Gateway 连接 Relay 后，需要把本地 `/ws` 里的实时事件向 Relay 转发。

转发内容包括：

- `gateway-ready`
- `session-started`
- `session-user-input`
- `session-status`
- `session-output`
- `session-finished`

原则：

- 保持消息结构不变
- Relay 不重新解释业务字段，只做路由和广播

### 本地 HTTP 代理

Gateway 需要接收 Relay 发来的代理请求，并把它们转发到本机的：

- `/api/*`
- `/download/*`

转发要求：

- Relay 不把客户端 token 直接下发给本地 Gateway
- 本地代理请求统一注入本机 `gatewayAuthToken`
- 支持二进制响应，例如 APK 下载
- 支持 JSON 请求体和附件请求体

## Relay 服务端规范

### 功能边界

Relay 只负责：

- 设备注册与在线状态维护
- 配对码签发
- 客户端访问 token 签发
- HTTP 代理
- WebSocket 事件广播

Relay 不负责：

- 直接运行 Codex
- 保存线程主数据
- 解释任务业务逻辑

### 设备注册协议

设备通过 `GET /relay/device` 建立 WebSocket。

首次注册发送：

```json
{
  "type": "device-hello",
  "serverToken": "RELAY_SERVER_TOKEN",
  "deviceName": "张三-MacBook"
}
```

已注册设备重连发送：

```json
{
  "type": "device-hello",
  "deviceId": "uuid",
  "deviceSecret": "secret",
  "deviceName": "张三-MacBook"
}
```

Relay 成功响应：

```json
{
  "type": "device-ready",
  "deviceId": "uuid",
  "deviceSecret": "secret",
  "deviceName": "张三-MacBook",
  "pairCode": "AB12CD",
  "pairCodeExpiresAt": "2026-05-25T12:00:00.000Z"
}
```

电脑端接入成功后，Gateway 应直接在启动日志里打印：

- Relay 地址
- 设备名 / 设备 ID
- 当前配对码
- 配对码过期时间
- 手机端填写示例

当前实现已经会在本地 Gateway 日志中输出：

```text
Relay pair code: AB12CD, expires at 2026-05-25T12:00:00.000Z
Mobile login: enter pair code AB12CD
```

### 配对码规范

配对码要求：

- 长度 6 位
- 使用不易混淆字符集
- 默认 10 分钟过期
- 一次性消费

推荐规则：

- 同一设备同一时刻只保留一个未消费有效码
- 重新申请会覆盖旧码
- 码被消费后立即作废

### 客户端登录规范

客户端对 Relay 执行：

```http
POST /api/auth/login
Content-Type: application/json

{ "token": "AB12CD" }
```

Relay 登录逻辑：

- 如果 `token` 是已有访问 token，则续用
- 否则按配对码处理
- 成功后返回 device-scoped 访问 token

这里的 `token` 对手机客户端来说，首次就是配对码，不是：

- `RELAY_SERVER_TOKEN`
- 本地 `ADMIN_TOKEN`

返回体示例：

```json
{
  "token": "relay_access_token",
  "expiresAt": "2026-06-24T12:00:00.000Z",
  "deviceId": "uuid",
  "relay": true
}
```

### HTTP 代理规范

Relay 对客户端暴露的 API 与本地 Gateway 尽量一致。

代理流程：

1. 客户端请求 Relay
2. Relay 从访问 token 解析出 `deviceId`
3. Relay 通过设备 WebSocket 下发 `proxy-request`
4. 本地 Gateway 请求本机 `http://127.0.0.1:<port>`
5. Gateway 回传 `proxy-response`
6. Relay 原样返回给客户端

代理报文示例：

```json
{
  "type": "proxy-request",
  "requestId": "req-123",
  "method": "POST",
  "path": "/api/threads/uuid/turns",
  "headers": {
    "content-type": "application/json"
  },
  "bodyBase64": "..."
}
```

## 数据持久化规范

Relay 至少要持久化三类数据：

- 设备信息
- 配对码
- 访问 token

当前实现落盘到：

```text
~/.acode-relay/data/relay-state.json
```

后续生产化建议改成 SQLite：

- 设备表 `devices`
- 配对码表 `pair_codes`
- 访问 token 表 `access_tokens`

## 安全规范

必须遵守：

- Relay 必须部署在 HTTPS / WSS
- `RELAY_SERVER_TOKEN` 和 `RELAY_SESSION_SECRET` 必须是长随机串
- 客户端永远不直接接触本地 `ADMIN_TOKEN`
- 配对码必须短期有效且一次性
- 设备离线时 Relay 必须拒绝代理请求

建议增强：

- 增加设备解绑
- 增加配对确认
- 增加操作审计
- 增加访问 token 主动撤销

## 当前仓库里的实现范围

本次已经落下：

- `relay/` 独立中转服务
- 本地 Gateway 主动连接 Relay
- Relay 自动签发配对码
- 客户端可用 Relay 的 `/api/auth/login` 登录
- Relay 代理 `/api/*` 和 `/download/aCode-latest.apk`
- Relay 转发 `/ws` 事件
- Gateway 新增 `/api/relay/status` 和 `/api/relay/pair-code`

## 开发和运行方式

### 启动 Relay

```bash
npm run relay:dev
```

或：

```bash
npm run relay:build
npm run relay:start
```

需要的环境变量示例：

```env
RELAY_HOST=0.0.0.0
RELAY_PORT=8788
RELAY_PUBLIC_ORIGIN=https://relay.example.com
RELAY_SERVER_TOKEN=replace-with-a-long-random-secret
RELAY_SESSION_SECRET=replace-with-another-long-random-secret
```

### 启动本地 Gateway 并接入 Relay

```env
HOST=127.0.0.1
PORT=8787
PUBLIC_ORIGIN=http://127.0.0.1:8787
ADMIN_TOKEN=...
SESSION_SECRET=...
RELAY_URL=https://relay.example.com
RELAY_SERVER_TOKEN=replace-with-a-long-random-secret
RELAY_DEVICE_NAME=张三-MacBook
```

启动成功后，终端应直接出现类似输出：

```text
Relay enabled
Relay pair code: AB12CD, expires at 2026-05-25T12:00:00.000Z
Mobile login: enter pair code AB12CD
```

### 客户端使用方式

客户端登录时：

- `token` 填配对码
- 官方中转域名由客户端内置，不展示也不允许修改

## 产品侧展示规范

客户端和文档里要明确告诉用户，中转是可选项。

建议文案：

- 局域网直连：适合手机和电脑在同一网络
- 使用官方中转：适合没有公网、需要外网访问
- 使用自建中转：适合企业或高级用户自行托管

配置原则：

- 不强制用户使用你们的官方中转
- 不把自建中转做成隐藏能力
- 不让用户误以为配对码和 `ADMIN_TOKEN` 是同一个概念

## 后续建议

下一阶段建议补三件事：

1. 在 App 首页新增“中转配对模式”文案，避免用户把配对码误认为 `ADMIN_TOKEN`
2. Relay 改为 SQLite 持久化，避免 JSON 文件并发覆盖风险
3. 为 Relay 增加设备管理后台和解绑入口
# Relay 设计说明（历史基线）

> 本文档保留早期 Node Relay 设计作为参考。当前实现以 `cloud-relay-go/` 和 `documentation/protocol.md` 为准：云端后端统一使用 Go，配对码由 Go Relay 生成并消费，Node 只运行在用户电脑上的 Gateway。
