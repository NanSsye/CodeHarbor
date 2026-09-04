import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import packageJson from "../package.json" with { type: "json" };

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const buildDir = path.join(root, "tmp", "ios-unsigned");
const payloadDir = path.join(buildDir, "Payload");
const archiveName = `aCode-ios-unsigned-${packageJson.version}.ipa`;
const outputPath = path.join(root, "dist-packages", archiveName);
const appPath = path.join(
  process.env.DERIVED_DATA_PATH ?? path.join(root, "tmp", "ios-derived-data"),
  "Build",
  "Products",
  "Release-iphoneos",
  "App.app"
);

run("npm", ["run", "app:ios:sync"], root);
run(
  "xcodebuild",
  [
    "-project",
    "app/ios/App/App.xcodeproj",
    "-scheme",
    "App",
    "-configuration",
    "Release",
    "-destination",
    "generic/platform=iOS",
    "-derivedDataPath",
    process.env.DERIVED_DATA_PATH ?? path.join(root, "tmp", "ios-derived-data"),
    "CODE_SIGNING_ALLOWED=NO",
    "CODE_SIGNING_REQUIRED=NO",
    "CODE_SIGN_IDENTITY="
  ],
  root
);

if (!existsSync(appPath)) {
  throw new Error(`Built app was not found: ${appPath}`);
}

rmSync(buildDir, { recursive: true, force: true });
mkdirSync(payloadDir, { recursive: true });
mkdirSync(path.dirname(outputPath), { recursive: true });
cpSync(appPath, path.join(payloadDir, "aCode.app"), { recursive: true });
rmSync(outputPath, { force: true });
run("zip", ["-qry", outputPath, "Payload"], buildDir);

const sha = spawnSync("shasum", ["-a", "256", outputPath], { cwd: root, encoding: "utf8" });
if (sha.status === 0) {
  console.log(sha.stdout.trim());
}
console.log(`Unsigned IPA written: ${outputPath}`);

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit", shell: false });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
  }
}
