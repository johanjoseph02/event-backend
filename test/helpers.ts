import { randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, inject } from "vitest";
import { loadConfig } from "../src/config.ts";
import { type Ctx, makeCtx } from "../src/context.ts";
import { createPool } from "../src/db/pool.ts";
import { createEvent, type EventInput, setStatus } from "../src/domain/events.ts";
import { createOrganizer, issueToken } from "../src/domain/organizers.ts";
import { MemoryTransport } from "../src/email/transports.ts";

export interface TestEnv {
  ctx: Ctx;
  mail: MemoryTransport;
  clock: { now: Date };
  organizerId: string;
  token: string;
}

/** A fresh database cloned from the migrated template, and a context with a fake clock. */
export async function testEnv(): Promise<TestEnv> {
  const adminUrl = inject("pgAdminUrl");
  const name = `eb_test_${randomBytes(6).toString("hex")}`;
  const admin = new pg.Client(adminUrl);
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name} TEMPLATE ${inject("pgTemplate")}`);
  await admin.end();
  const url = adminUrl.replace(/\/[^/]*$/, `/${name}`);
  const db = createPool(url, 40);
  const config = loadConfig({
    DATABASE_URL: url, APP_SECRET: "test-secret-test-secret-test-secret-0123456789",
    BASE_URL: "http://events.test", EMAIL_TRANSPORT: "memory", REGISTRATION_RATE_PER_MIN: "1000",
  });
  const mail = new MemoryTransport();
  const clock = { now: new Date("2030-03-01T09:00:00Z") };
  const ctx = makeCtx(db, config, mail, () => clock.now);
  const org = await createOrganizer(ctx, `org-${name}@example.org`, "Test organiser");
  const token = await issueToken(ctx, org.id, "test");
  afterAll(async () => {
    await db.end();
    const a = new pg.Client(adminUrl);
    await a.connect();
    await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await a.end();
  });
  return { ctx, mail, clock, organizerId: org.id, token };
}

export const hours = (h: number) => h * 3600_000;

export async function publishedEvent(env: TestEnv, over: Partial<EventInput> = {}) {
  const slug = over.slug ?? `ev-${randomBytes(4).toString("hex")}`;
  const starts = new Date(env.clock.now.getTime() + hours(24 * 7));
  const e = await createEvent(env.ctx, env.organizerId, {
    slug, title: "GraphQL Workshop", description: "Hands-on.", venue: "Tech Park, Room 401",
    starts_at: starts, ends_at: new Date(starts.getTime() + hours(3)), capacity: 3, waitlist: true,
    registration_opens_at: null, registration_closes_at: null, rsvp_hours_before: 48,
    release_unconfirmed: false, rsvp_deadline_hours: 12, form: [], ...over,
  });
  return setStatus(env.ctx, env.organizerId, e.id, "published");
}

export const person = (i: number) => ({ name: `Person ${i}`, email: `person${i}@example.org` });
