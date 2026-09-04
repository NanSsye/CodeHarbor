import { startServer } from "./index.js";
import { gatewayStore } from "./gatewayStore.js";
import { codexBridge } from "./codexBridge.js";

try {
  const server = await startServer();
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      codexBridge.shutdown();
      await server.close();
    } catch {
      // Continue flushing event persistence even if a live socket refuses to
      // close during process shutdown.
    }
    await gatewayStore.flush();
  };
  process.once("SIGINT", () => { void shutdown().finally(() => process.exit(0)); });
  process.once("SIGTERM", () => { void shutdown().finally(() => process.exit(0)); });
} catch (error) {
  console.error(error);
  process.exit(1);
}
