/**
 * Everything running locally in one command, no Docker:
 *
 *   npm run demo
 *
 * Starts a throwaway PostgreSQL, the API with its background worker (emails are written
 * to ./outbox as .eml files), creates an organiser, a published event with a waitlist and
 * a door scanner, and prints the links to try.
 */
import { loadConfig } from "../src/config.ts";
import { makeCtx } from "../src/context.ts";
import { linkToken } from "../src/crypto.ts";
import { migrate } from "../src/db/migrate.ts";
import { createPool } from "../src/db/pool.ts";
import { createScanner } from "../src/domain/checkin.ts";
import { createEvent, setStatus } from "../src/domain/events.ts";
import { createOrganizer, issueToken } from "../src/domain/organizers.ts";
import { register } from "../src/domain/registrations.ts";
import { FileTransport } from "../src/email/transports.ts";
import { createApp } from "../src/http/app.ts";
import { startBackground } from "../src/runner.ts";
import { startLocalPostgres } from "./local-postgres.ts";

const port = Number(process.env.PORT ?? 3000);
const pgLocal = await startLocalPostgres();
const config = loadConfig({
  DATABASE_URL: pgLocal.url, APP_SECRET: "demo-secret-demo-secret-demo-secret-0001",
  BASE_URL: `http://localhost:${port}`, EMAIL_TRANSPORT: "file", PORT: String(port),
});
const db = createPool(config.DATABASE_URL);
await migrate(db);
const ctx = makeCtx(db, config, new FileTransport(config.EMAIL_OUTBOX_DIR, config.EMAIL_FROM));

const org = await createOrganizer(ctx, "organiser@example.org", "Demo organiser");
const token = await issueToken(ctx, org.id, "demo");
const starts = new Date(Date.now() + 3 * 86400_000);
starts.setUTCHours(12, 30, 0, 0);
const event = await createEvent(ctx, org.id, {
  slug: "graphql-workshop", title: "Hands-on GraphQL Workshop",
  description: "Build a GraphQL API from scratch in three hours. Bring a laptop.",
  venue: "Tech Park, Room 401", starts_at: starts, ends_at: new Date(starts.getTime() + 3 * 3600_000),
  capacity: 3, waitlist: true, registration_opens_at: null, registration_closes_at: null,
  rsvp_hours_before: 48, release_unconfirmed: true, rsvp_deadline_hours: 12,
  form: [
    { id: "year", label: "Year of study", type: "select", options: ["1st", "2nd", "3rd", "4th"], required: true },
    { id: "github", label: "GitHub username (optional)", type: "text", required: false, max_length: 40 },
    { id: "coc", label: "I agree to the code of conduct", type: "checkbox", required: true },
  ],
});
await setStatus(ctx, org.id, event.id, "published");
const people = ["Aditi Rao", "Karthik Iyer", "Sara Thomas", "Rohan Mehta"];
const regs = [];
for (const [i, name] of people.entries()) {
  regs.push((await register(ctx, event.slug, {
    name, email: `${name.split(" ")[0]!.toLowerCase()}@example.org`, answers: { year: ["1st", "2nd", "3rd", "4th"][i], coc: true },
  })).registration);
}
const scanner = await createScanner(ctx, event.id, "main door", "demo");

createApp(ctx).listen(port);
const stop = startBackground(ctx, 2000);
const base = config.BASE_URL;
console.log(`
  Registration page   ${base}/e/${event.slug}
  A confirmed ticket  ${base}/t/${linkToken("ticket", regs[0]!.id, ctx.master)}
  A waitlisted ticket ${base}/t/${linkToken("ticket", regs[3]!.id, ctx.master)}
  Door scanner        ${base}/scanner#token=${scanner.token}
  Emails              ./${config.EMAIL_OUTBOX_DIR}/*.eml

  Organiser API token ${token}
    curl -s -H "Authorization: Bearer ${token}" ${base}/api/events/${event.id}/stats

  Ctrl-C to stop (the database is thrown away).
`);

const shutdown = async () => {
  stop();
  db.removeAllListeners("error").on("error", () => {});
  await db.end();
  await pgLocal.stop();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
