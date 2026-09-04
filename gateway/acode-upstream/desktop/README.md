# CodeHarbor Desktop

桌面端是一个 Windows Electron 安装包。它负责托管本机 Gateway、保存本机连接配置并提供日志/运行状态控制台，聊天工作台仍然使用 CodeHarbor 的 HTTPS/WSS 云端页面。

## 开发运行

在 `gateway/acode-upstream` 完成服务端和网页构建后：

```powershell
npm --prefix desktop install
npm run server:build
npm run app:build
npm --prefix desktop run dev
```

首次运行在桌面控制台设置工作台密码（至少 16 位），可选填写 Relay 账号密码。凭据通过 Electron `safeStorage` 加密后保存到 `%APPDATA%/CodeHarbor`，不会写入 URL 或网页 localStorage。

## 生成安装包

```powershell
npm --prefix desktop run dist
```

产物位于 `desktop/dist/CodeHarbor-Setup-<version>-x64.exe`。NSIS 安装器不会在卸载时删除用户配置、Gateway 数据或日志。

## 设计边界

- 主进程启动和停止 `server/dist/main.js`，窗口渲染进程没有 Node 权限。
- 聊天页面只允许通过菜单打开配置的 Relay HTTPS 地址；新窗口外链交给系统浏览器。
- Gateway stdout/stderr 会显示在控制台并追加到 `%APPDATA%/CodeHarbor/data/gateway.log`。
- OpenCode/Gemini 可用于视觉稿和 React/CSS 草案；认证、IPC、进程生命周期和安装器逻辑保持人工审查。
