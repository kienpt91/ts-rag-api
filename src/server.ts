import { buildApp } from "./app.js";
import { createComponents, createService, loadConfig } from "./config.js";

let config;
try {
  config = loadConfig();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
const components = await createComponents(config);
const service = createService(config, components);
const app = buildApp({
  service,
  bodyLimit: config.MAX_BODY_BYTES,
  logger: { level: config.LOG_LEVEL },
  healthCheck: () => components.store.count(),
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}

await app.listen({ host: config.HOST, port: config.PORT });
