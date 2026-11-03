/**
 * Registration rush: many people registering for one event at the same moment, over real
 * HTTP against the real server and a real (durable, fsync on) PostgreSQL.
 *
 *   npm run bench:race                       # 2,000 people, 500 seats, 200 at a time
 *   npm run bench:race -- 5000 1000 400      # people, seats, concurrency
 *
 * Checks the invariants (exactly ``seats`` confirmed, every waitlist position used once,
 * no duplicate rows) and reports throughput and latency percentiles.
 */
import type { AddressInfo } from "node:net";
import { loadConfig } from "../src/config.ts";
import { makeCtx } from "../src/context.ts";
import { migrate } from "../src/db/migrate.ts";
import { createPool } from "../src/db/pool.ts";
import { createEvent, setStatus } from "../src/domain/events.ts";
import { createOrganizer } from "../src/domain/organizers.ts";
import { MemoryTransport } from "../src/email/transports.ts";
import { createApp } from "../src/http/app.ts";
import { startLocalPostgres } from "./local-postgres.ts";

const [people = 2000, seats = 500, concurrency = 200] = process.argv.slice(2).map(Number);
process.env.NODE_ENV = "test"; // no per-request log lines

const pgLocal = process.env.DATABASE_URL ? null : await startLocalPostgres({ durable: true });
const url = process.env.DATABASE_URL ?? pgLocal!.url;
const db = createPool(url, 50);
await migrate(db);
const config = loadConfig({ DATABASE_URL: url, APP_SECRET: "race-secret-race-secret-race-secret-0001",
  REGISTRATION_RATE_PER_MIN: String(people * 10) });
const ctx = makeCtx(db, config, new MemoryTransport());
const server = createApp(ctx).listen(0);
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const org = await createOrganizer(ctx, `race-${Date.now()}@example.org`, "Race");
const slug = `race-${Date.now()}`;
const start = new Date(Date.now() + 7 * 86400_000);
const e = await createEvent(ctx, org.id, {
  slug, title: "Race", description: "", venue: "", starts_at: start, ends_at: new Date(start.getTime() + 3600_000),
  capacity: seats, waitlist: true, registration_opens_at: null, registration_closes_at: null,
  rsvp_hours_before: 48, release_unconfirmed: false, rsvp_deadline_hours: 12, form: [],
});
await setStatus(ctx, org.id, e.id, "published");

// Each person submits twice, as people do when a page is slow.
const jobs = Array.from({ length: people * 2 }, (_, i) => i % people);
const latencies: number[] = [];
const statuses = new Map<number, number>();
let next = 0;
const t0 = performance.now();
await Promise.all(Array.from({ length: concurrency }, async () => {
  while (next < jobs.length) {
    const i = jobs[next++]!;
    const t = performance.now();
    const r = await fetch(`${base}/api/public/events/${slug}/registrations`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: `Person ${i}`, email: `p${i}@example.org` }),
    });
    await r.arrayBuffer();
    latencies.push(performance.now() - t);
    statuses.set(r.status, (statuses.get(r.status) ?? 0) + 1);
  }
}));
const seconds = (performance.now() - t0) / 1000;

const { rows } = await db.query<{ status: string; n: string; positions: string; distinct_positions: string }>(
  `SELECT status, COUNT(*) AS n, COUNT(waitlist_position) AS positions,
          COUNT(DISTINCT waitlist_position) AS distinct_positions
     FROM registrations WHERE event_id = $1 GROUP BY status`, [e.id]);
const by = Object.fromEntries(rows.map((r) => [r.status, r]));
const { rows: ev } = await db.query<{ confirmed_count: number }>("SELECT confirmed_count FROM events WHERE id = $1", [e.id]);
const confirmed = Number(by.confirmed?.n ?? 0);
const waitlisted = Number(by.waitlisted?.n ?? 0);
latencies.sort((a, b) => a - b);
const pct = (p: number) => latencies[Math.min(latencies.length - 1, Math.floor(p * latencies.length))]!.toFixed(1);

const ok = confirmed === seats && waitlisted === people - seats && ev[0]!.confirmed_count === seats
  && by.waitlisted?.positions === by.waitlisted?.distinct_positions;
const report = {
  people, seats, concurrency, requests: jobs.length, seconds: Number(seconds.toFixed(2)),
  requests_per_second: Math.round(jobs.length / seconds),
  latency_ms: { p50: Number(pct(0.5)), p95: Number(pct(0.95)), p99: Number(pct(0.99)), max: Number(latencies.at(-1)!.toFixed(1)) },
  http_statuses: Object.fromEntries(statuses),
  confirmed, waitlisted, confirmed_count: ev[0]!.confirmed_count, invariants_hold: ok,
  node: process.version,
};
console.log(JSON.stringify(report, null, 2));
if (process.env.RACE_OUT) {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(process.env.RACE_OUT, JSON.stringify(report, null, 2) + "\n");
}

server.close();
db.removeAllListeners("error").on("error", () => {});
await db.end();
await pgLocal?.stop();
process.exit(ok ? 0 : 1);
