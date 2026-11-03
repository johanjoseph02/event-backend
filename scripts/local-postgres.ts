/** Start a throwaway PostgreSQL cluster in a temp directory: no Docker, no system service. */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";

export function pgBin(): string {
  const candidates = [process.env.PG_BIN, "/opt/homebrew/opt/postgresql@16/bin", "/usr/lib/postgresql/16/bin",
    "/usr/local/opt/postgresql@16/bin"].filter(Boolean) as string[];
  for (const c of candidates) if (existsSync(join(c, "initdb"))) return c;
  return execFileSync("pg_config", ["--bindir"]).toString().trim();
}

const freePort = () => new Promise<number>((resolve, reject) => {
  const s = createServer();
  s.listen(0, () => {
    const port = (s.address() as { port: number }).port;
    s.close(() => resolve(port));
  });
  s.on("error", reject);
});

export interface LocalPostgres {
  url: string;
  stop(): Promise<void>;
}

export async function startLocalPostgres(opts: { durable?: boolean } = {}): Promise<LocalPostgres> {
  const bin = pgBin();
  const dir = mkdtempSync(join(tmpdir(), "event-backend-pg-"));
  execFileSync(join(bin, "initdb"), ["-D", join(dir, "data"), "-U", "postgres", "--auth=trust", "-E", "UTF8",
    "--no-locale"], { stdio: "ignore" });
  const port = await freePort();
  const fast = opts.durable ? [] : ["-c", "fsync=off", "-c", "synchronous_commit=off", "-c", "full_page_writes=off"];
  const child = spawn(join(bin, "postgres"), ["-D", join(dir, "data"), "-p", String(port), "-k", dir,
    "-c", "listen_addresses=127.0.0.1", "-c", "max_connections=300", ...fast], { stdio: "ignore" });
  const url = `postgres://postgres@127.0.0.1:${port}/postgres`;
  for (let i = 0; ; i++) {
    try {
      const c = new pg.Client(url);
      await c.connect();
      await c.end();
      break;
    } catch (err) {
      if (i > 100) throw err;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  return {
    url,
    async stop() {
      child.kill("SIGINT");
      await new Promise((r) => child.once("exit", r));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
