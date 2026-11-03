import { describe, expect, it } from "vitest";
import { signTicket } from "../src/crypto.ts";
import { bundle, createScanner, scan, scannerFromToken } from "../src/domain/checkin.ts";
import { getEvent } from "../src/domain/events.ts";
import { register, reissue, type RegistrationRow, ticketToken, withdraw } from "../src/domain/registrations.ts";
import { person, publishedEvent, testEnv } from "./helpers.ts";

const env = await testEnv();

async function setup(capacity = 3) {
  const e = await publishedEvent(env, { capacity });
  const door = await scannerFromToken(env.ctx, (await createScanner(env.ctx, e.id, "north door", "test")).token);
  const side = await scannerFromToken(env.ctx, (await createScanner(env.ctx, e.id, "side door", "test")).token);
  const regs: RegistrationRow[] = [];
  for (let i = 0; i < capacity + 1; i++) regs.push((await register(env.ctx, e.slug, person(i))).registration);
  const event = await getEvent(env.ctx, e.id);
  return { e: event, door, side, regs, ticket: (i: number) => ticketToken(env.ctx, event, regs[i]!) };
}

describe("check-in", () => {
  it("admits a valid ticket once and says who already used it", async () => {
    const { door, side, ticket } = await setup();
    expect(await scan(env.ctx, door, { token: ticket(0) })).toMatchObject({ result: "ok", name: "Person 0" });
    const again = await scan(env.ctx, side, { token: ticket(0) });
    expect(again).toMatchObject({ result: "already", first_scanner: "north door" });
  });

  it("rejects forged, foreign, cancelled, waitlisted and reissued tickets", async () => {
    const { e, door, regs, ticket } = await setup();
    const other = await setup();
    expect((await scan(env.ctx, door, { token: other.ticket(0) })).result).toBe("wrong_event");
    // signed with another event's key but claiming this event
    const forged = signTicket({ eventId: e.id, registrationId: regs[0]!.id, version: 1 },
      other.e.ticket_private_key_enc, env.ctx.master);
    expect((await scan(env.ctx, door, { token: forged })).result).toBe("invalid");
    expect((await scan(env.ctx, door, { token: "not a ticket" })).result).toBe("invalid");

    const old = ticket(1);
    await reissue(env.ctx, e.id, regs[1]!.id, "test");
    expect((await scan(env.ctx, door, { token: old })).result).toBe("revoked");

    const t2 = ticket(2);
    await withdraw(env.ctx, regs[2]!.id, "test");
    expect((await scan(env.ctx, door, { token: t2 })).result).toBe("not_confirmed");

    const { rows } = await env.ctx.db.query("SELECT result FROM scans WHERE event_id = $1 ORDER BY id", [e.id]);
    expect(rows.map((r) => r.result)).toEqual(["wrong_event", "invalid", "invalid", "revoked", "not_confirmed"]);
  });

  it("replays a retried scan instead of recording it twice", async () => {
    const { door, ticket, e } = await setup();
    const a = await scan(env.ctx, door, { token: ticket(0), client_scan_id: "abc" });
    const b = await scan(env.ctx, door, { token: ticket(0), client_scan_id: "abc" });
    expect(a.result).toBe("ok");
    expect(b).toMatchObject({ result: "ok", replayed: true });
    const { rows } = await env.ctx.db.query("SELECT COUNT(*)::int AS n FROM scans WHERE event_id = $1", [e.id]);
    expect(rows[0].n).toBe(1);
  });

  it("keeps the earliest scan when two offline doors admitted the same ticket", async () => {
    const { door, side, ticket, regs } = await setup();
    const late = await scan(env.ctx, door, { token: ticket(0), scanned_at: new Date("2030-03-08T09:05:00Z") });
    const early = await scan(env.ctx, side, { token: ticket(0), scanned_at: new Date("2030-03-08T09:01:00Z") });
    expect(late.result).toBe("ok");
    expect(early).toMatchObject({ result: "already", first_scanner: "side door" });
    const { rows } = await env.ctx.db.query("SELECT scanned_at, scanner_label FROM checkins WHERE registration_id = $1", [regs[0]!.id]);
    expect(rows[0]).toMatchObject({ scanner_label: "side door" });
    expect(rows[0].scanned_at.toISOString()).toBe("2030-03-08T09:01:00.000Z");
  });

  it("gives scanners an offline bundle with only current, confirmed tickets", async () => {
    const { door, regs, e } = await setup(2);
    await reissue(env.ctx, e.id, regs[0]!.id, "test");
    const b = await bundle(env.ctx, door);
    expect(b.public_key).toBe(e.ticket_public_key.toString("base64url"));
    expect(b.tickets.map((t) => [t.name, t.v])).toEqual([["Person 0", 2], ["Person 1", 1]]);
    expect(JSON.stringify(b)).not.toContain("ticket_private_key");
  });
});
