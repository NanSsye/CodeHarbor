import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

const version = process.env.CODEHARBOR_NODE_VERSION ?? "v20.20.2";
const arch = process.env.CODEHARBOR_NODE_ARCH ?? "x64";
const packageName = `node-${version}-win-${arch}`;
const root = process.cwd();
const runtimeDir = path.join(root, "runtime", "node");
const cacheDir = path.join(process.env.LOCALAPPDATA ?? os.tmpdir(), "CodeHarbor-build", "node-cache");
const zipPath = path.join(cacheDir, `${packageName}.zip`);
const extracted = path.join(cacheDir, packageName);

if (arch !== "x64" && arch !== "arm64") throw new Error(`Unsupported Node runtime arch: ${arch}`);
mkdirSync(cacheDir, { recursive: true });
if (!existsSync(path.join(extracted, "node.exe"))) {
  if (!existsSync(zipPath)) {
    const mirror = (process.env.CODEHARBOR_NODE_MIRROR ?? "https://npmmirror.com/mirrors/node").replace(/\/$/, "");
    const response = await fetch(`${mirror}/${version}/${packageName}.zip`, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`Node runtime download failed: HTTP ${response.status}`);
    writeFileSync(zipPath, Buffer.from(await response.arrayBuffer()));
  }
  rmSync(extracted, { recursive: true, force: true });
  const result = spawnSync("powershell", ["-NoProfile", "-Command", `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${cacheDir.replace(/'/g, "''")}' -Force`], { stdio: "inherit", shell: process.platform === "win32" });
  if (result.status !== 0) throw new Error("Unable to extract Node runtime");
}
rmSync(runtimeDir, { recursive: true, force: true });
mkdirSync(runtimeDir, { recursive: true });
const copy = spawnSync("powershell", ["-NoProfile", "-Command", `Copy-Item -Path '${path.join(extracted, "*").replace(/'/g, "''")}' -Destination '${runtimeDir.replace(/'/g, "''")}' -Recurse -Force`], { stdio: "inherit", shell: process.platform === "win32" });
if (copy.status !== 0) throw new Error("Unable to stage Node runtime");
console.log(`Node runtime staged: ${runtimeDir}`);
