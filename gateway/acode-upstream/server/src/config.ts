import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

type RawEnv = Record<string, string | undefined>;

export function defaultConfigPath() {
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA ?? path.join(homedir(), "AppData", "Roaming"), "aCode-server", "config.env");
  }
  return path.join(homedir(), ".acode-server", "config.env");
}

function argValue(name: string) {
  const index = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  const prefix = `${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : undefined;
}

export function resolveConfigPath() {
  const explicitPath = argValue("--config") ?? process.env.ACODE_CONFIG;
  if (explicitPath) return path.resolve(explicitPath);
  const userConfigPath = defaultConfigPath();
  if (existsSync(userConfigPath)) return userConfigPath;
  return path.join(process.cwd(), ".env");
}

function loadDotenv() {
  const envPath = resolveConfigPath();
  if (!existsSync(envPath)) return;

  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(trimmed);
    if (!match) continue;
    const [, key, rawValue] = match;
    // Match standard dotenv precedence: explicit process environment values
    // (service managers, Docker, CLI) must not be overwritten by a local file.
    if (process.env[key] === undefined) {
      process.env[key] = rawValue.replace(/^['"]|['"]$/g, "");
    }
  }
}

function envNumber(env: RawEnv, key: string, fallback: number) {
  const value = env[key];
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${key} must be a number`);
  }
  return parsed;
}

function required(env: RawEnv, key: string) {
  const value = env[key];
  if (!value || value.includes("replace-with-")) {
    throw new Error(`${key} is required. Set it in .env or the process environment.`);
  }
  return value;
}

loadDotenv();

const codexHome = process.env.CODEX_HOME ?? path.join(homedir(), ".codex");
// No built-in account is safe for a new installation. The desktop client
// supplies the user's explicit local Gateway username at runtime.
const gatewayAuthUsername = process.env.GATEWAY_AUTH_USERNAME ?? "";
const relayAccountToken = process.env.RELAY_ACCOUNT_TOKEN?.trim()
  || process.env.CODEHARBOR_ACCOUNT_TOKEN?.trim()
  || "";
const relayAccountUsername = process.env.RELAY_ACCOUNT_USERNAME?.trim()
  || process.env.CODEHARBOR_ACCOUNT_USERNAME?.trim()
  || "";
const relayAccountPassword = process.env.RELAY_ACCOUNT_PASSWORD
  ?? process.env.CODEHARBOR_ACCOUNT_PASSWORD
  ?? "";

export const config = {
  host: process.env.HOST ?? "127.0.0.1",
  port: envNumber(process.env, "PORT", 8787),
  publicOrigin: process.env.PUBLIC_ORIGIN ?? `http://127.0.0.1:${process.env.PORT ?? 8787}`,
  gatewayName: process.env.GATEWAY_NAME ?? "remote-vibecoding-gateway",
  gatewayVersion: process.env.GATEWAY_VERSION ?? "1.1.37-compatible",
  gatewayAuthUsername,
  gatewayAuthPassword: process.env.GATEWAY_AUTH_PASSWORD ?? process.env.ADMIN_TOKEN ?? "",
  gatewayAuthToken: process.env.GATEWAY_AUTH_TOKEN ?? process.env.ADMIN_TOKEN ?? "",
  allowedFilesystemRoots: (process.env.GATEWAY_ALLOWED_PATHS ?? process.cwd()).split(/\s+/).filter(Boolean),
  adminToken: required(process.env, "ADMIN_TOKEN"),
  sessionSecret: required(process.env, "SESSION_SECRET"),
  // Keep browser logins valid for 30 days by default. Operators can shorten
  // this with SESSION_TTL_HOURS without changing the protocol.
  sessionTtlHours: envNumber(process.env, "SESSION_TTL_HOURS", 30 * 24),
  codexHome,
  codexBin: process.env.CODEX_BIN ?? "codex",
  codexAppServerPort: envNumber(process.env, "CODEX_APP_SERVER_PORT", 8790),
  auditDir: process.env.AUDIT_DIR ?? path.join(codexHome, "remote-control"),
  gatewayDataDir: process.env.GATEWAY_DATA_DIR ?? path.join(codexHome, "remote-control", "gateway-data"),
  relayUrl: process.env.RELAY_URL?.trim() || "",
  // Account credentials are only read at runtime. They are never printed by
  // the launcher and are not persisted by the Relay client.
  relayAccountToken,
  relayAccountUsername,
  relayAccountPassword,
  relayOrigin: process.env.RELAY_ORIGIN?.trim() || "",
  // Kept solely for explicitly configured legacy deployments. New clients use
  // account enrollment and a per-device credential instead.
  relayServerToken: process.env.RELAY_SERVER_TOKEN?.trim() || "",
  relayDeviceName: process.env.RELAY_DEVICE_NAME?.trim() || "",
  appUpdateVersionCode: envNumber(process.env, "APP_UPDATE_VERSION_CODE", 1),
  appUpdateVersionName: process.env.APP_UPDATE_VERSION_NAME ?? "1.0",
  appUpdateNotes: process.env.APP_UPDATE_NOTES ?? "aCode Android 更新包",
  appUpdateApkPath: path.resolve(process.env.APP_UPDATE_APK_PATH ?? path.join(process.cwd(), "aCode-debug.apk")),
  appUpdatePublicDownload: process.env.APP_UPDATE_PUBLIC_DOWNLOAD !== "false"
};

export type AppConfig = typeof config;

export const appUpdateHistory = [
  {
    versionCode: 100030018,
    versionName: "1.0.3.18",
    date: "2026-05-25",
    notes: [
      "支持执行中插话引导，不中断当前 turn",
      "新增主动停止入口，服务端可自动解析 active turn",
      "客户端按任务状态区分空闲发送和执行中插话"
    ]
  },
  {
    versionCode: 100030011,
    versionName: "1.0.3.11",
    date: "2026-05-24",
    notes: [
      "进一步适配 Android 手势返回",
      "任务详情页写入 WebView 历史栈",
      "手势返回先回首页，再次返回才退出 App"
    ]
  },
  {
    versionCode: 100030010,
    versionName: "1.0.3.10",
    date: "2026-05-24",
    notes: [
      "适配 Android 手势返回",
      "弹窗页优先关闭",
      "任务详情页返回首页，首页再次返回才退出 App"
    ]
  },
  {
    versionCode: 100030009,
    versionName: "1.0.3.9",
    date: "2026-05-24",
    notes: [
      "修正版本递增，避免同版本不同包",
      "增强任务过程事件可见性",
      "优化客户端空闲状态刷新流量"
    ]
  },
  {
    versionCode: 100030008,
    versionName: "1.0.3.8",
    date: "2026-05-24",
    notes: [
      "降低客户端空闲状态下的网络流量",
      "运行中任务保留 5 秒高速刷新",
      "状态变更后 5 分钟内才低速刷新任务列表"
    ]
  },
  {
    versionCode: 100030007,
    versionName: "1.0.3.7",
    date: "2026-05-24",
    notes: [
      "支持 App 内下载更新并直接唤起系统安装器",
      "任务过程按时间顺序穿插显示在对话流中",
      "取消单独的最近过程卡片"
    ]
  },
  {
    versionCode: 100030006,
    versionName: "1.0.3.6",
    date: "2026-05-24",
    notes: [
      "提升小米/MIUI 桌面小组件识别兼容性",
      "补充小组件 label/icon，降低默认尺寸声明",
      "简化 Widget Provider 的系统声明"
    ]
  },
  {
    versionCode: 100030005,
    versionName: "1.0.3.5",
    date: "2026-05-24",
    notes: [
      "增加 Android 桌面小组件",
      "小组件显示正在进行的任务、最近反馈和任务统计",
      "App 登录和实时事件会同步刷新小组件"
    ]
  },
  {
    versionCode: 100030004,
    versionName: "1.0.3.4",
    date: "2026-05-24",
    notes: [
      "修复历史页当前版本显示错误",
      "优化任务卡片标题和摘要去重",
      "附件选择后返回任务页会继续保留",
      "修正执行完成后的状态归位"
    ]
  },
  {
    versionCode: 100030003,
    versionName: "1.0.3.3",
    date: "2026-05-24",
    notes: [
      "增加浏览器直链下载地址，绕过旧 App 内下载按钮失效问题",
      "更新接口返回 publicDownloadUrl，方便手动更新",
      "继续保留历史更新记录"
    ]
  },
  {
    versionCode: 100030002,
    versionName: "1.0.3.2",
    date: "2026-05-24",
    notes: [
      "增加历史更新页面，方便查看每个版本的变化",
      "首页使用 aCode App 图标，移除圆形 C 状态图标",
      "继续修正首页执行中状态统计和任务状态同步"
    ]
  },
  {
    versionCode: 100030001,
    versionName: "1.0.3.1",
    date: "2026-05-23",
    notes: [
      "采用四段显示版本和大 versionCode，后续小迭代也可触发更新检测",
      "修复任务列表数据库读取失败时的降级响应",
      "优化首页任务筛选、执行中状态和统计口径"
    ]
  },
  {
    versionCode: 100010000,
    versionName: "1.0.1",
    date: "2026-05-23",
    notes: [
      "修复旧版更新下载未认证",
      "增强慢网络和 WebSocket 重连",
      "支持附件上传，区分用户和 Codex 消息颜色"
    ]
  },
  {
    versionCode: 100000000,
    versionName: "1.0.0",
    date: "2026-05-23",
    notes: [
      "首个 Android 客户端和本机 Gateway 服务",
      "支持查看任务列表、过程历史和远程继续 Codex 任务",
      "提供 APK 在线更新入口"
    ]
  }
];
