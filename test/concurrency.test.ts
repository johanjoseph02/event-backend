import { describe, expect, it } from "vitest";
import { getEvent } from "../src/domain/events.ts";
import { register, withdraw } from "../src/domain/registrations.ts";
import { person, publishedEvent, testEnv } from "./helpers.ts";

const env = await testEnv();

describe("under concurrent load", () => {
  it("never confirms more people than there are seats", async () => {
    const e = await publishedEvent(env, { capacity: 50 });
    const results = await Promise.all(Array.from({ length: 300 }, (_, i) => register(env.ctx, e.slug, person(i))));
    const confirmed = results.filter((r) => r.registration.status === "confirmed");
    const waitlisted = results.filter((r) => r.registration.status === "waitlisted");
    expect(confirmed).toHaveLength(50);
    expect(waitlisted).toHaveLength(250);
    // every waitlist position is used exactly once
    expect(new Set(waitlisted.map((r) => r.position)).size).toBe(250);
    expect(Math.max(...waitlisted.map((r) => r.position ?? 0))).toBe(250);
    expect((await getEvent(env.ctx, e.id)).confirmed_count).toBe(50);
  });

  it("keeps the count right while people leave and join at the same time", async () => {
    const e = await publishedEvent(env, { capacity: 20 });
    const first = await Promise.all(Array.from({ length: 40 }, (_, i) => register(env.ctx, e.slug, person(i))));
    const leaving = first.filter((r) => r.registration.status === "confirmed").slice(0, 10);
    await Promise.all([
      ...leaving.map((r) => withdraw(env.ctx, r.registration.id, "attendee")),
      ...Array.from({ length: 30 }, (_, i) => register(env.ctx, e.slug, person(100 + i))),
    ]);
    const { rows } = await env.ctx.db.query<{ status: string; n: string }>(
      "SELECT status, COUNT(*) AS n FROM registrations WHERE event_id = $1 GROUP BY status", [e.id]);
    const by = Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
    expect(by).toEqual({ confirmed: 20, cancelled: 10, waitlisted: 40 });
    expect((await getEvent(env.ctx, e.id)).confirmed_count).toBe(20);
  });

  it("a double submit under load still creates one registration", async () => {
    const e = await publishedEvent(env, { capacity: 5 });
    const results = await Promise.allSettled(Array.from({ length: 20 }, () => register(env.ctx, e.slug, person(7))));
    const ok = results.filter((r) => r.status === "fulfilled");
    expect(ok.length).toBeGreaterThan(0);
    const { rows } = await env.ctx.db.query("SELECT COUNT(*)::int AS n FROM registrations WHERE event_id = $1", [e.id]);
    expect(rows[0].n).toBe(1);
  });
});
