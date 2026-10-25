import { startInstance } from "./app.js";
import { loadInstanceConfig } from "./config/load-instance-config.js";

const configPath = process.argv[2];
if (!configPath) {
  console.error("Usage: tsx src/index.ts <path-to-instance-config.json>");
  process.exit(1);
}

const config = loadInstanceConfig(configPath);
const instance = await startInstance(config);

// One line, then exit 1 - Node's own default prints a stack trace and exits
// the same way, but a supervisor (systemd, docker) sees only the code.
process.on("unhandledRejection", (reason) => {
  instance.logger.fatal({ err: reason }, "Unhandled rejection - exiting");
  process.exit(1);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    instance.logger.info(`Received ${signal}, shutting down`);
    void instance
      .stop()
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        instance.logger.error({ err: error }, "stop() failed during shutdown");
        process.exit(1);
      });
  });
}
