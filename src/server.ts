import { createApp } from "./app.js";
import { environment } from "./config.js";
import { createPivotTokenVerifier } from "./pivot-auth.js";
const config = environment();
const app = await createApp({
  ...config,
  logger: true,
  worker: true,
  ...(config.pivotApiUrl
    ? {
        verifyExternalToken: createPivotTokenVerifier({
          baseUrl: config.pivotApiUrl,
          host: config.pivotApiHost || new URL(config.pivotApiUrl).host,
        }),
      }
    : {}),
});
let closing: Promise<void> | undefined;
const shutdown = () => {
  closing ??= app
    .close()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
};
// The Agents SDK also handles signals. Retain our listener until close finishes
// so its asynchronous handler cannot mistake a removed once-listener for no owner.
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, shutdown);
await app.listen({ host: config.host, port: config.port });
