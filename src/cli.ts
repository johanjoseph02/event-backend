/**
 *   node src/cli.ts migrate
 *   node src/cli.ts create-organizer <email> <name>     prints an API token, once
 *   node src/cli.ts issue-token <email> [label]
 */
import { loadConfig } from "./config.ts";
import { makeCtx } from "./context.ts";
import { migrate } from "./db/migrate.ts";
import { createPool } from "./db/pool.ts";
import { createOrganizer, issueToken } from "./domain/organizers.ts";
import { MemoryTransport } from "./email/transports.ts";

const [cmd, ...args] = process.argv.slice(2);
const config = loadConfig();
const db = createPool(config.DATABASE_URL, 2);
const ctx = makeCtx(db, config, new MemoryTransport());

try {
  if (cmd === "migrate") {
    const applied = await migrate(db);
    console.log(applied.length ? `applied ${applied.join(", ")}` : "up to date");
  } else if (cmd === "create-organizer" && args[0] && args[1]) {
    await migrate(db);
    const o = await createOrganizer(ctx, args[0], args.slice(1).join(" "));
    console.log(`organiser ${o.email} (${o.id})\nAPI token (shown once): ${await issueToken(ctx, o.id, "cli")}`);
  } else if (cmd === "issue-token" && args[0]) {
    const { rows } = await db.query<{ id: string }>("SELECT id FROM organizers WHERE lower(email) = lower($1)", [args[0]]);
    if (!rows[0]) throw new Error(`no organiser ${args[0]}`);
    console.log(`API token (shown once): ${await issueToken(ctx, rows[0].id, args[1] ?? "cli")}`);
  } else {
    console.log("usage: cli.ts migrate | create-organizer <email> <name> | issue-token <email> [label]");
    process.exitCode = 2;
  }
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await db.end();
}
