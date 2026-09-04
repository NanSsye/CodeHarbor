import { randomUUID } from "node:crypto";
import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export const maxAttachmentsPerTurn = 8;
export const maxAttachmentBytes = 15 * 1024 * 1024;
// Allow a small data-URL/header margin while bounding the encoded payload
// before Buffer.from can allocate memory.
export const maxAttachmentBase64Chars = Math.ceil(maxAttachmentBytes * 4 / 3) + 512;

const imageExtensions = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"]);
const fileExtensions = new Set([
  ".txt",
  ".md",
  ".markdown",
  ".json",
  ".yaml",
  ".yml",
  ".csv",
  ".log",
  ".pdf",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
  ".zip",
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".py",
  ".java",
  ".kt",
  ".swift",
  ".go",
  ".rs",
  ".c",
  ".h",
  ".cpp",
  ".hpp",
  ".cs",
  ".php",
  ".rb",
  ".sh",
  ".bash",
  ".zsh",
  ".ps1",
  ".html",
  ".css",
  ".scss",
  ".xml",
  ".toml",
  ".ini",
  ".conf",
  ".env",
  ".gradle",
  ".sql"
]);

export type UploadedAttachmentInput = {
  name: string;
  mimeType?: string;
  size?: number;
  dataBase64: string;
};

export type StoredAttachment = {
  id: string;
  originalName: string;
  mimeType: string;
  size: number;
  kind: "image" | "file";
  relativePath: string;
  absolutePath: string;
};

export async function storeAttachments(input: {
  cwd: string;
  threadId: string;
  attachments?: UploadedAttachmentInput[];
}) {
  const attachments = input.attachments ?? [];
  if (attachments.length > maxAttachmentsPerTurn) {
    throw Object.assign(new Error("too_many_attachments"), { statusCode: 400 });
  }
  if (attachments.length === 0) return [];

  const attachmentDir = path.resolve(input.cwd, ".acode", "attachments", input.threadId);
  await mkdir(attachmentDir, { recursive: true });
  // The workspace itself was realpath-checked by the route, but a user or a
  // local tool can place a symlink inside it after that check. Resolve the
  // attachment directory again before writing so uploads cannot follow an
  // in-workspace symlink to an outside tree.
  const workspaceRoot = await realpath(input.cwd).catch(() => null);
  const resolvedAttachmentDir = await realpath(attachmentDir).catch(() => null);
  if (!workspaceRoot || !resolvedAttachmentDir) {
    throw Object.assign(new Error("attachment_path_escape"), { statusCode: 400 });
  }
  ensurePathInside(workspaceRoot, resolvedAttachmentDir);

  const stored: StoredAttachment[] = [];
  try {
    for (const attachment of attachments) {
      const originalName = sanitizeAttachmentFileName(attachment.name);
      const mimeType = attachment.mimeType?.trim() || "application/octet-stream";
      const buffer = decodeBase64(attachment.dataBase64);
      const size = attachment.size ?? buffer.byteLength;
      if (size !== buffer.byteLength) {
        throw Object.assign(new Error("invalid_attachment_size"), { statusCode: 400 });
      }
      if (buffer.byteLength > maxAttachmentBytes) {
        throw Object.assign(new Error("attachment_too_large"), { statusCode: 413 });
      }
      const kind = classifyAttachment(originalName, mimeType);
      const id = `att_${randomUUID().replace(/-/g, "")}`;
      const storedName = `${id}-${originalName}`;
      const absolutePath = path.resolve(resolvedAttachmentDir, storedName);
      ensurePathInside(resolvedAttachmentDir, absolutePath);
      await writeFile(absolutePath, buffer, { mode: 0o600 });
      stored.push({
        id,
        originalName,
        mimeType,
        size: buffer.byteLength,
        kind,
        relativePath: path.posix.join(".acode", "attachments", input.threadId, storedName),
        absolutePath
      });
    }
  } catch (error) {
    await Promise.all(stored.map((attachment) => rm(attachment.absolutePath, { force: true }).catch(() => undefined)));
    throw error;
  }
  return stored;
}

export function appendAttachmentPrompt(text: string, attachments: StoredAttachment[]) {
  if (attachments.length === 0) return text;
  const lines = attachments.map((attachment) => {
    return `- ${attachment.originalName} (${attachment.mimeType}, ${formatBytes(attachment.size)}): ${attachment.relativePath}`;
  });
  return [
    text.trimEnd(),
    "",
    "本轮附带了以下附件。图片已作为本地图片输入，同时也保存在路径中；普通文件请按需读取：",
    ...lines
  ].join("\n");
}

export function buildCodexInput(text: string, attachments: StoredAttachment[]) {
  const input: Array<Record<string, unknown>> = [
    {
      type: "text",
      text: appendAttachmentPrompt(text, attachments),
      text_elements: []
    }
  ];
  for (const attachment of attachments) {
    if (attachment.kind === "image") {
      input.push({
        type: "localImage",
        path: attachment.absolutePath
      });
    }
  }
  return input;
}

function sanitizeAttachmentFileName(fileName: string) {
  const baseName = path.basename(fileName || "attachment");
  const cleaned = baseName
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[\\/]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned || cleaned === "." || cleaned === "..") return "attachment";
  return cleaned.slice(0, 120);
}

function classifyAttachment(fileName: string, mimeType: string): StoredAttachment["kind"] {
  const extension = path.extname(fileName).toLowerCase();
  const normalizedMime = mimeType.toLowerCase();
  if (normalizedMime.startsWith("image/") || imageExtensions.has(extension)) return "image";
  if (fileExtensions.has(extension) || normalizedMime.startsWith("text/") || normalizedMime === "application/octet-stream") {
    return "file";
  }
  throw Object.assign(new Error("unsupported_attachment_type"), { statusCode: 400 });
}

function decodeBase64(value: string) {
  const base64 = value.includes(",") ? value.slice(value.indexOf(",") + 1) : value;
  const compact = base64.replace(/[\r\n\t ]/g, "");
  if (!compact || compact.length > maxAttachmentBase64Chars || compact.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) {
    throw Object.assign(new Error("invalid_attachment"), { statusCode: 400 });
  }
  const buffer = Buffer.from(compact, "base64");
  if (buffer.byteLength === 0) {
    throw Object.assign(new Error("invalid_attachment"), { statusCode: 400 });
  }
  return buffer;
}

function ensurePathInside(parentPath: string, childPath: string) {
  const relative = path.relative(parentPath, childPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw Object.assign(new Error("attachment_path_escape"), { statusCode: 400 });
  }
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
