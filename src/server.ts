import { loadConfig } from "./config.ts";
import { makeCtx } from "./context.ts";
import { migrate } from "./db/migrate.ts";
import { createPool } from "./db/pool.ts";
import { makeTransport } from "./email/transports.ts";
import { createApp } from "./http/app.ts";
import { startBackground } from "./runner.ts";

const config = loadConfig();
const db = createPool(config.DATABASE_URL);
const transport = makeTransport(config.EMAIL_TRANSPORT, {
  dir: config.EMAIL_OUTBOX_DIR, from: config.EMAIL_FROM, region: config.AWS_REGION,
});
const ctx = makeCtx(db, config, transport);

const applied = await migrate(db);
if (applied.length) console.log(JSON.stringify({ level: "info", msg: "migrated", applied }));

const server = createApp(ctx).listen(config.PORT, () => {
  console.log(JSON.stringify({ level: "info", msg: "listening", url: config.BASE_URL, email: transport.name }));
});
const stopBackground = config.RUN_WORKER ? startBackground(ctx) : () => {};

const shutdown = () => {
  stopBackground();
  server.close(() => db.end().then(() => process.exit(0)));
  setTimeout(() => process.exit(1), 10_000).unref();
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
