import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["server/src/main.ts", "server/src/cli.ts"],
  format: ["esm"],
  platform: "node",
  target: "node20",
  outDir: "server/dist",
  clean: true,
  bundle: true,
  noExternal: [/.*/],
  splitting: false,
  banner: {
    js: [
      "import { createRequire as __createRequire } from 'module';",
      "const require = __createRequire(import.meta.url);"
    ].join("\n")
  }
});
