import { describe, expect, it } from "vitest";
import { getEvent, setStatus, stats, updateEvent } from "../src/domain/events.ts";
import { position, register, rsvp, withdraw } from "../src/domain/registrations.ts";
import { AppError } from "../src/errors.ts";
import { hours, person, publishedEvent, testEnv } from "./helpers.ts";

const env = await testEnv();

describe("registration", () => {
  it("confirms up to capacity, then waitlists in order", async () => {
    const e = await publishedEvent(env, { capacity: 2 });
    const r = [];
    for (let i = 0; i < 5; i++) r.push(await register(env.ctx, e.slug, person(i)));
    expect(r.map((x) => x.registration.status)).toEqual(["confirmed", "confirmed", "waitlisted", "waitlisted", "waitlisted"]);
    expect(r.map((x) => x.position)).toEqual([null, null, 1, 2, 3]);
    expect((await getEvent(env.ctx, e.id)).confirmed_count).toBe(2);
  });

  it("treats a second submission from the same email as the same registration", async () => {
    const e = await publishedEvent(env);
    const a = await register(env.ctx, e.slug, { name: "Asha", email: "Asha@Example.org" });
    const b = await register(env.ctx, e.slug, { name: "Asha R", email: "  asha@example.org " });
    expect(b.duplicate).toBe(true);
    expect(b.registration.id).toBe(a.registration.id);
    expect((await getEvent(env.ctx, e.id)).confirmed_count).toBe(1);
  });

  it("refuses when full without a waitlist, closed, not yet open, or a draft", async () => {
    const full = await publishedEvent(env, { capacity: 1, waitlist: false });
    await register(env.ctx, full.slug, person(1));
    await expect(register(env.ctx, full.slug, person(2))).rejects.toMatchObject({ status: 409, code: "full" });

    const later = await publishedEvent(env, { registration_opens_at: new Date(env.clock.now.getTime() + hours(1)) });
    await expect(register(env.ctx, later.slug, person(1))).rejects.toMatchObject({ code: "not_open_yet" });

    const closed = await publishedEvent(env, { registration_closes_at: new Date(env.clock.now.getTime() - 1) });
    await expect(register(env.ctx, closed.slug, person(1))).rejects.toMatchObject({ code: "closed" });

    await expect(register(env.ctx, "no-such-event", person(1))).rejects.toMatchObject({ status: 404 });
  });

  it("validates the form and the basics", async () => {
    const e = await publishedEvent(env, { form: [{ id: "coc", label: "I agree", type: "checkbox", required: true }] });
    await expect(register(env.ctx, e.slug, person(1))).rejects.toMatchObject({ status: 422, details: { coc: "must be ticked" } });
    await expect(register(env.ctx, e.slug, { name: "", email: "not-an-email" })).rejects.toBeInstanceOf(AppError);
    const ok = await register(env.ctx, e.slug, { ...person(1), answers: { coc: true } });
    expect(ok.registration.answers).toEqual({ coc: true });
  });

  it("promotes the first person on the waitlist when someone leaves", async () => {
    const e = await publishedEvent(env, { capacity: 1 });
    const a = await register(env.ctx, e.slug, person(1));
    const b = await register(env.ctx, e.slug, person(2));
    const c = await register(env.ctx, e.slug, person(3));
    await withdraw(env.ctx, a.registration.id, "attendee");
    const after = await stats(env.ctx, e.id);
    expect(after).toMatchObject({ confirmed: 1, waitlisted: 1, cancelled: 1 });
    const { rows } = await env.ctx.db.query("SELECT id, status FROM registrations WHERE event_id = $1 ORDER BY created_at", [e.id]);
    expect(rows.map((r) => r.status)).toEqual(["cancelled", "confirmed", "waitlisted"]);
    expect(rows[1].id).toBe(b.registration.id);
    expect(await position(env.ctx.db, { ...c.registration, waitlist_position: c.registration.waitlist_position })).toBe(1);
  });

  it("lets someone who cancelled register again, at the back of the queue", async () => {
    const e = await publishedEvent(env, { capacity: 1 });
    const a = await register(env.ctx, e.slug, person(1));
    await register(env.ctx, e.slug, person(2));
    await withdraw(env.ctx, a.registration.id, "attendee");
    const again = await register(env.ctx, e.slug, person(1));
    expect(again.registration.id).toBe(a.registration.id);
    expect(again.registration.status).toBe("waitlisted");
    expect(again.registration.ticket_version).toBeGreaterThan(a.registration.ticket_version);
  });

  it("promotes when capacity is raised and refuses to cut below the confirmed count", async () => {
    const e = await publishedEvent(env, { capacity: 1 });
    for (let i = 0; i < 3; i++) await register(env.ctx, e.slug, person(i));
    await updateEvent(env.ctx, env.organizerId, e.id, { capacity: 3 });
    expect(await stats(env.ctx, e.id)).toMatchObject({ confirmed: 3, waitlisted: 0 });
    await expect(updateEvent(env.ctx, env.organizerId, e.id, { capacity: 2 })).rejects.toMatchObject({ code: "capacity_below_confirmed" });
  });

  it("cancelling the event cancels everyone and emails them", async () => {
    const e = await publishedEvent(env, { capacity: 1 });
    await register(env.ctx, e.slug, person(1));
    await register(env.ctx, e.slug, person(2));
    await setStatus(env.ctx, env.organizerId, e.id, "cancelled");
    expect(await stats(env.ctx, e.id)).toMatchObject({ confirmed: 0, waitlisted: 0, cancelled: 2 });
    const { rows } = await env.ctx.db.query(
      "SELECT kind FROM outbox WHERE payload->>'eventId' = $1 AND kind = 'event_cancelled'", [e.id]);
    expect(rows).toHaveLength(2);
    await expect(register(env.ctx, e.slug, person(3))).rejects.toMatchObject({ code: "not_open" });
  });

  it("RSVP yes keeps the place; no releases it", async () => {
    const e = await publishedEvent(env, { capacity: 1 });
    const a = await register(env.ctx, e.slug, person(1));
    const b = await register(env.ctx, e.slug, person(2));
    expect((await rsvp(env.ctx, a.registration.id, "yes")).rsvp).toBe("yes");
    await expect(rsvp(env.ctx, b.registration.id, "yes")).rejects.toMatchObject({ code: "not_confirmed" });
    const gone = await rsvp(env.ctx, a.registration.id, "no");
    expect(gone).toMatchObject({ status: "cancelled", rsvp: "no" });
    expect(await stats(env.ctx, e.id)).toMatchObject({ confirmed: 1, waitlisted: 0 });
  });
});
