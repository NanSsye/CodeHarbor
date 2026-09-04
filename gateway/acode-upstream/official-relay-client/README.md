# Official Relay Client

这个目录用于“官方中转客户端服务”分发。

目标：

- 用户电脑下载后直接启动
- 不要求用户填写中转地址
- 不要求用户填写中转 token
- 启动后自动连接官方中转
- 终端直接显示配对码

## 运行方式

在仓库开发环境里：

```powershell
npm run server:build
node server/dist/cli.js official-start
```

如果只想预写配置：

```powershell
node server/dist/cli.js official-init
```

如果要安装为当前用户开机自启动服务：

```powershell
node server/dist/cli.js official-install-service
```

## 用户最终体验

1. 启动客户端服务
2. 服务自动连接官方中转
3. 终端打印配对码
4. 手机 App 输入配对码
5. 远程连接成功

## 内置配置

- 官方中转地址固定内置
- 官方中转注册凭据由部署环境通过 `RELAY_SERVER_TOKEN`（或账号凭据）显式注入，不随客户端打包
- 本地 `ADMIN_TOKEN` / `SESSION_SECRET` 自动生成
- 本地监听默认仅绑定 `127.0.0.1`
