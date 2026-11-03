import { describe, expect, it } from "vitest";
import { runRsvp } from "../src/domain/rsvp.ts";
import { register, rsvp, withdraw } from "../src/domain/registrations.ts";
import { stats } from "../src/domain/events.ts";
import { deliverDue } from "../src/email/worker.ts";
import { hours, person, publishedEvent, testEnv } from "./helpers.ts";

const env = await testEnv();
const rsvpEnv = await testEnv(); // its own database: RSVP runs over every event

async function drain(on = env) {
  const total = { sent: 0, dropped: 0, failed: 0, retried: 0 };
  for (;;) {
    const r = await deliverDue(on.ctx);
    for (const k of Object.keys(total) as (keyof typeof total)[]) total[k] += r[k];
    if (r.sent + r.dropped + r.failed + r.retried === 0) return total;
  }
}

describe("email outbox", () => {
  it("sends a confirmation with a QR code and a calendar invite", async () => {
    const e = await publishedEvent(env, { capacity: 1 });
    env.mail.sent.length = 0;
    await register(env.ctx, e.slug, person(1));
    await register(env.ctx, e.slug, person(2));
    expect(await drain()).toMatchObject({ sent: 2 });
    const [confirmed, waitlisted] = env.mail.sent;
    expect(confirmed!.subject).toBe("You're registered: GraphQL Workshop");
    expect(confirmed!.attachments.map((a) => a.filename)).toEqual(["ticket.png", "invite.ics"]);
    expect(confirmed!.attachments[0]!.content.subarray(1, 4).toString()).toBe("PNG");
    expect(confirmed!.text).toContain("http://events.test/t/");
    expect(waitlisted!.subject).toContain("waitlist");
    expect(waitlisted!.text).toContain("number 1 on the waitlist");
  });

  it("retries failed deliveries with backoff, then gives up", async () => {
    const e = await publishedEvent(env);
    env.mail.sent.length = 0;
    env.mail.failNext = 1;
    await register(env.ctx, e.slug, person(3));
    expect(await drain()).toMatchObject({ retried: 1, sent: 0 });
    env.clock.now = new Date(env.clock.now.getTime() + 2 * 60_000);
    expect(await drain()).toMatchObject({ sent: 1 });
    env.mail.failNext = 100;
    await register(env.ctx, e.slug, person(4));
    for (let i = 0; i < 9; i++) {
      await drain();
      env.clock.now = new Date(env.clock.now.getTime() + hours(7));
    }
    const { rows } = await env.ctx.db.query("SELECT status, attempts FROM outbox WHERE to_email = 'person4@example.org'");
    expect(rows[0]).toMatchObject({ status: "failed", attempts: 8 });
    env.mail.failNext = 0;
    env.clock.now = new Date("2030-03-01T09:00:00Z");
  });

  it("drops emails that no longer apply", async () => {
    const e = await publishedEvent(env);
    env.mail.sent.length = 0;
    const r = await register(env.ctx, e.slug, person(5));
    await withdraw(env.ctx, r.registration.id, "attendee");
    const out = await drain();
    expect(out.dropped).toBe(1); // the confirmation, now obsolete
    expect(env.mail.sent.map((m) => m.subject)).toEqual(["You've left GraphQL Workshop"]);
  });
});

describe("RSVP", () => {
  it("asks confirmed people before the event and releases silent ones at the deadline", async () => {
    const e = await publishedEvent(rsvpEnv, { capacity: 2, rsvp_hours_before: 48, rsvp_deadline_hours: 12, release_unconfirmed: true });
    const a = await register(rsvpEnv.ctx, e.slug, person(10));
    const b = await register(rsvpEnv.ctx, e.slug, person(11));
    await register(rsvpEnv.ctx, e.slug, person(12)); // waitlisted
    await drain(rsvpEnv);
    rsvpEnv.mail.sent.length = 0;

    expect(await runRsvp(rsvpEnv.ctx)).toEqual({ reminded: 0, released: 0 }); // a week out: too early
    rsvpEnv.clock.now = new Date(e.starts_at.getTime() - hours(47));
    expect(await runRsvp(rsvpEnv.ctx)).toMatchObject({ reminded: 2 });
    expect(await runRsvp(rsvpEnv.ctx)).toMatchObject({ reminded: 0 }); // idempotent
    await drain(rsvpEnv);
    expect(rsvpEnv.mail.sent.filter((m) => m.subject.startsWith("Still coming")).length).toBe(2);

    await rsvp(rsvpEnv.ctx, a.registration.id, "yes");
    rsvpEnv.clock.now = new Date(e.starts_at.getTime() - hours(11));
    expect(await runRsvp(rsvpEnv.ctx)).toMatchObject({ released: 1 });
    const s = await stats(rsvpEnv.ctx, e.id);
    expect(s).toMatchObject({ confirmed: 2, released: 1, waitlisted: 0, rsvp_yes: 1 });
    const { rows } = await rsvpEnv.ctx.db.query("SELECT status FROM registrations WHERE id = $1", [b.registration.id]);
    expect(rows[0].status).toBe("released");
    // the person promoted from the waitlist was never asked, so keeps the place
    expect(await runRsvp(rsvpEnv.ctx)).toEqual({ reminded: 0, released: 0 });
    rsvpEnv.clock.now = new Date("2030-03-01T09:00:00Z");
  });

  it("does not release anyone unless the organiser opted in", async () => {
    const e = await publishedEvent(rsvpEnv, { capacity: 1, release_unconfirmed: false });
    const r = await register(rsvpEnv.ctx, e.slug, person(20));
    rsvpEnv.clock.now = new Date(e.starts_at.getTime() - hours(1));
    expect(await runRsvp(rsvpEnv.ctx)).toMatchObject({ released: 0 });
    const { rows } = await rsvpEnv.ctx.db.query("SELECT rsvp_requested_at FROM registrations WHERE id = $1", [r.registration.id]);
    expect(rows[0].rsvp_requested_at).not.toBeNull();
    expect(await stats(rsvpEnv.ctx, e.id)).toMatchObject({ confirmed: 1 });
    rsvpEnv.clock.now = new Date("2030-03-01T09:00:00Z");
  });
});
