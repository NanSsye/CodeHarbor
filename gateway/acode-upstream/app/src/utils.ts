import type { Session } from "./types";

export const cfg = () => {
  const origin = window.location.origin;
  return {
    api: `${origin}/api/v1`,
    ws: `${origin.replace(/^http/, "ws")}/ws`
  };
};

export const statusText = (s?: string) => {
  switch (s) {
    case "running":
      return "运行中";
    case "completed":
      return "已完成";
    case "failed":
      return "执行失败";
    case "cancelled":
      return "已中断";
    case "starting":
      return "启动中";
    case "waiting-approval":
      return "等待审批";
    case "resumable":
      return "可恢复";
    case "history-only":
      return "只读历史";
    default:
      return s || "未知状态";
  }
};

export const statusBadgeColor = (s?: string) => {
  switch (s) {
    case "running":
    case "streaming":
      return "var(--color-primary)";
    case "completed":
      return "var(--color-green)";
    case "waiting-approval":
      return "#e6a23c";
    case "failed":
    case "cancelled":
      return "var(--color-red)";
    default:
      return "var(--color-text-muted)";
  }
};

export const projectOf = (s: Session) =>
  s.projectName ||
  s.project ||
  (s.workspacePath ?? s.cwd ?? "")
    .split(/[\\/]/)
    .filter(Boolean)
    .pop() ||
  "默认工作区";

export const fmtTime = (value?: string | number) => {
  if (!value) return "";
  try {
    const d = typeof value === "number" ? new Date(value) : new Date(value);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch {
    return "";
  }
};

export const fmtRelativeTime = (value?: string | number) => {
  if (!value) return "";
  try {
    const time = typeof value === "number" ? value : new Date(value).getTime();
    const diff = Math.max(0, Date.now() - time);
    const sec = Math.floor(diff / 1000);
    if (sec < 60) return "刚刚";
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min} 分钟前`;
    const hour = Math.floor(min / 60);
    if (hour < 24) return `${hour} 小时前`;
    const days = Math.floor(hour / 24);
    if (days < 30) return `${days} 天前`;
    return new Date(time).toLocaleDateString();
  } catch {
    return "";
  }
};

export const fmtDuration = (ms?: number) => {
  if (!ms || ms <= 0) return "";
  if (ms < 1000) return `${ms}ms`;
  const sec = (ms / 1000).toFixed(1);
  return `${sec}s`;
};

export const fmtBytes = (bytes?: number) => {
  if (!bytes || bytes <= 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
};

export const base64Utf8 = (value: string) => {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
};

export const utf8Base64 = (base64: string) => {
  try {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new TextDecoder().decode(bytes);
  } catch {
    return base64;
  }
};

export const base64ToBytes = (base64: string) => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
};

export const fileToBase64 = (file: File): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = () => {
      const result = reader.result as string;
      const base64 = result.includes(",") ? result.split(",")[1] : result;
      resolve(base64);
    };
    reader.onerror = (error) => reject(error);
  });
};

export const copyToClipboard = async (text: string): Promise<boolean> => {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {}
  }
  try {
    const textArea = document.createElement("textarea");
    textArea.value = text;
    textArea.style.position = "fixed";
    textArea.style.left = "-999999px";
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    const success = document.execCommand("copy");
    document.body.removeChild(textArea);
    return success;
  } catch {
    return false;
  }
};
