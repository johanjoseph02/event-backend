/** A separate email and RSVP worker, for running the API with RUN_WORKER=false. */
import { loadConfig } from "./config.ts";
import { makeCtx } from "./context.ts";
import { createPool } from "./db/pool.ts";
import { makeTransport } from "./email/transports.ts";
import { startBackground } from "./runner.ts";

const config = loadConfig();
const db = createPool(config.DATABASE_URL, 4);
const ctx = makeCtx(db, config, makeTransport(config.EMAIL_TRANSPORT, {
  dir: config.EMAIL_OUTBOX_DIR, from: config.EMAIL_FROM, region: config.AWS_REGION,
}));
const stop = startBackground(ctx);
console.log(JSON.stringify({ level: "info", msg: "worker started" }));
const shutdown = () => { stop(); db.end().then(() => process.exit(0)); };
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
