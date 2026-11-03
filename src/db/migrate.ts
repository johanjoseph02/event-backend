import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Db } from "./pool.ts";

const DIR = fileURLToPath(new URL("./migrations/", import.meta.url));

/** Apply every ``migrations/NNN_*.sql`` not yet recorded, each in its own transaction. */
export async function migrate(db: Db): Promise<string[]> {
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const client = await db.connect();
  const applied: string[] = [];
  try {
    // One migrator at a time, even with several app instances starting together.
    await client.query("SELECT pg_advisory_lock(727274)");
    const done = new Set(
      (await client.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map((r) => r.name),
    );
    const files = (await readdir(DIR)).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(DIR + file, "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
        await client.query("COMMIT");
        applied.push(file);
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`migration ${file} failed: ${(err as Error).message}`);
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(727274)").catch(() => {});
    client.release();
  }
  return applied;
}
