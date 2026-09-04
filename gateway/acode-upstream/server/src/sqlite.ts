import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function sqlitePath() {
  return sqliteBin();
}

export function sqliteJson<T>(dbPath: string, sql: string): Promise<T[]> {
  return new Promise((resolve, reject) => {
    execFile(
      sqliteBin(),
      ["-readonly", "-json", dbPath, sql],
      { maxBuffer: 20 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr.trim() || error.message));
          return;
        }
        try {
          resolve(stdout.trim() ? (JSON.parse(stdout) as T[]) : []);
        } catch (parseError) {
          reject(parseError);
        }
      }
    );
  });
}

function sqliteBin() {
  if (process.env.SQLITE_BIN) return process.env.SQLITE_BIN;
  const packaged = packagedSqliteBin();
  if (packaged && existsSync(packaged)) return packaged;
  return "sqlite3";
}

function packagedSqliteBin() {
  const distDir = path.dirname(fileURLToPath(import.meta.url));
  const packageDir = path.resolve(distDir, "..", "..");
  const executable = process.platform === "win32" ? "sqlite3.exe" : "sqlite3";
  return path.join(packageDir, "runtime", "sqlite", executable);
}
