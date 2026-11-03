/**
 * Registration, waitlist, cancellation and RSVP.
 *
 * Capacity is enforced by taking a row lock on the event (``SELECT ... FOR UPDATE``) for
 * the length of each registration transaction. Concurrent registrations for one event
 * queue on that lock, so ``confirmed_count`` can never pass ``capacity``, and the
 * ``CHECK`` constraint on the table would reject it if code ever tried. Registrations for
 * different events do not contend.
 */
import { z } from "zod";
import type { Ctx } from "../context.ts";
import { signTicket } from "../crypto.ts";
import { transaction, type Tx } from "../db/pool.ts";
import { enqueue } from "../email/outbox.ts";
import { AppError, conflict, invalid, notFound } from "../errors.ts";
import { audit, type EventRow, getEvent } from "./events.ts";
import { validateAnswers } from "./forms.ts";

export const RegistrationInput = z.object({
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().toLowerCase().pipe(z.email().max(254)),
  answers: z.record(z.string(), z.unknown()).default({}),
});
export type RegistrationInput = z.infer<typeof RegistrationInput>;

export interface RegistrationRow {
  id: string;
  event_id: string;
  email: string;
  name: string;
  answers: Record<string, unknown>;
  status: "confirmed" | "waitlisted" | "cancelled" | "released";
  waitlist_position: string | null;
  rsvp: "pending" | "yes" | "no";
  rsvp_requested_at: Date | null;
  ticket_version: number;
  created_at: Date;
  updated_at: Date;
  confirmed_at: Date | null;
  cancelled_at: Date | null;
}

export interface RegisterResult {
  registration: RegistrationRow;
  duplicate: boolean;
  position: number | null;
}

function openForRegistration(e: EventRow, now: Date): void {
  if (e.status !== "published") throw new AppError(409, "not_open", "registration is not open for this event");
  if (e.registration_opens_at && now < e.registration_opens_at) {
    throw new AppError(409, "not_open_yet", "registration has not opened yet", { opens_at: e.registration_opens_at });
  }
  const closes = e.registration_closes_at ?? e.starts_at;
  if (now >= closes) throw new AppError(409, "closed", "registration has closed");
}

export async function register(ctx: Ctx, slug: string, raw: unknown): Promise<RegisterResult> {
  const input = RegistrationInput.safeParse(raw);
  if (!input.success) throw invalid("check the form", input.error.flatten().fieldErrors);
  const { name, email } = input.data;

  return transaction(ctx.db, async (tx) => {
    const { rows: found } = await tx.query<EventRow>("SELECT * FROM events WHERE slug = $1 FOR UPDATE", [slug]);
    const event = found[0];
    if (!event) throw notFound("event");
    openForRegistration(event, ctx.now());
    const { answers, errors } = validateAnswers(event.form, input.data.answers);
    if (Object.keys(errors).length) throw invalid("check the form", errors);

    const { rows: existing } = await tx.query<RegistrationRow>(
      "SELECT * FROM registrations WHERE event_id = $1 AND lower(email) = $2 FOR UPDATE", [event.id, email]);
    const prior = existing[0];
    if (prior && (prior.status === "confirmed" || prior.status === "waitlisted")) {
      // Same person submitting twice (double click, retry, second tab): not an error.
      return { registration: prior, duplicate: true, position: await position(tx, prior) };
    }

    const seat = event.confirmed_count < event.capacity;
    if (!seat && !event.waitlist) throw conflict("full", "this event is full");
    const status = seat ? "confirmed" : "waitlisted";
    const params = [event.id, email, name, JSON.stringify(answers), status];
    const { rows } = prior
      ? await tx.query<RegistrationRow>(
        `UPDATE registrations SET email = $2, name = $3, answers = $4, status = $5,
           waitlist_position = CASE WHEN $5 = 'waitlisted' THEN nextval('waitlist_order') END,
           confirmed_at = CASE WHEN $5 = 'confirmed' THEN now() END, cancelled_at = NULL,
           rsvp = 'pending', rsvp_requested_at = NULL, ticket_version = ticket_version + 1,
           updated_at = now()
         WHERE id = $6 AND event_id = $1 RETURNING *`, [...params, prior.id])
      : await tx.query<RegistrationRow>(
        `INSERT INTO registrations (event_id, email, name, answers, status, waitlist_position, confirmed_at)
         VALUES ($1, $2, $3, $4, $5, CASE WHEN $5 = 'waitlisted' THEN nextval('waitlist_order') END,
                 CASE WHEN $5 = 'confirmed' THEN now() END)
         RETURNING *`, params);
    const reg = rows[0]!;
    if (seat) await tx.query("UPDATE events SET confirmed_count = confirmed_count + 1 WHERE id = $1", [event.id]);
    await enqueue(tx, `${status}:${reg.id}:${reg.ticket_version}`, status, reg.email,
      { registrationId: reg.id, eventId: event.id });
    await audit(tx, `attendee:${email}`, `registration.${status}`, event.id, reg.id, {});
    return { registration: reg, duplicate: false, position: await position(tx, reg) };
  });
}

/** 1-based place in the queue, or null if not waitlisted. */
export async function position(q: Tx | Ctx["db"], reg: RegistrationRow): Promise<number | null> {
  if (reg.status !== "waitlisted" || reg.waitlist_position == null) return null;
  const { rows } = await q.query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM registrations
      WHERE event_id = $1 AND status = 'waitlisted' AND waitlist_position <= $2`,
    [reg.event_id, reg.waitlist_position]);
  return Number(rows[0]!.n);
}

/** Fill free seats from the front of the waitlist. Caller holds the event row lock. */
export async function promoteFromWaitlist(ctx: Ctx, tx: Tx, event: EventRow): Promise<RegistrationRow[]> {
  const { rows: fresh } = await tx.query<EventRow>("SELECT * FROM events WHERE id = $1", [event.id]);
  const e = fresh[0]!;
  const free = e.capacity - e.confirmed_count;
  if (free <= 0 || e.status !== "published" || ctx.now() >= e.starts_at) return [];
  const { rows } = await tx.query<RegistrationRow>(
    `UPDATE registrations SET status = 'confirmed', confirmed_at = now(), waitlist_position = NULL,
       updated_at = now()
     WHERE id IN (SELECT id FROM registrations WHERE event_id = $1 AND status = 'waitlisted'
                  ORDER BY waitlist_position LIMIT $2 FOR UPDATE)
     RETURNING *`, [e.id, free]);
  if (rows.length) {
    await tx.query("UPDATE events SET confirmed_count = confirmed_count + $2 WHERE id = $1", [e.id, rows.length]);
    for (const r of rows) {
      await enqueue(tx, `promoted:${r.id}:${r.ticket_version}`, "promoted", r.email, { registrationId: r.id, eventId: e.id });
      await audit(tx, "system", "registration.promoted", e.id, r.id, {});
    }
  }
  return rows;
}

export async function getRegistration(ctx: Ctx, id: string, tx?: Tx, lock = false): Promise<RegistrationRow> {
  const { rows } = await (tx ?? ctx.db).query<RegistrationRow>(
    `SELECT * FROM registrations WHERE id = $1${lock ? " FOR UPDATE" : ""}`, [id]);
  if (!rows[0]) throw notFound("registration");
  return rows[0];
}

type Reason = "cancelled" | "released";

/** Give up a seat or a waitlist place; anyone behind moves up. */
export async function withdraw(ctx: Ctx, registrationId: string, actor: string, reason: Reason = "cancelled",
  existingTx?: Tx): Promise<RegistrationRow> {
  const run = async (tx: Tx) => {
    const r0 = await getRegistration(ctx, registrationId, tx);
    const event = await getEvent(ctx, r0.event_id, tx, true);
    const reg = await getRegistration(ctx, registrationId, tx, true);
    if (reg.status === "cancelled" || reg.status === "released") return reg;
    const { rows } = await tx.query<RegistrationRow>(
      `UPDATE registrations SET status = $2, cancelled_at = now(), waitlist_position = NULL,
         ticket_version = ticket_version + 1, updated_at = now()
       WHERE id = $1 RETURNING *`, [reg.id, reason]);
    if (reg.status === "confirmed") {
      await tx.query("UPDATE events SET confirmed_count = confirmed_count - 1 WHERE id = $1", [event.id]);
    }
    await enqueue(tx, `${reason}:${reg.id}:${reg.ticket_version}`, reason, reg.email,
      { registrationId: reg.id, eventId: event.id });
    await audit(tx, actor, `registration.${reason}`, event.id, reg.id, { was: reg.status });
    if (reg.status === "confirmed") await promoteFromWaitlist(ctx, tx, event);
    return rows[0]!;
  };
  return existingTx ? run(existingTx) : transaction(ctx.db, run);
}

export async function rsvp(ctx: Ctx, registrationId: string, answer: "yes" | "no"): Promise<RegistrationRow> {
  if (answer === "no") {
    // Locks are always taken event first, then registration; withdraw() does that.
    return transaction(ctx.db, async (tx) => {
      await withdraw(ctx, registrationId, "attendee", "cancelled", tx);
      const { rows } = await tx.query<RegistrationRow>(
        "UPDATE registrations SET rsvp = 'no', updated_at = now() WHERE id = $1 RETURNING *", [registrationId]);
      return rows[0]!;
    });
  }
  const reg = await getRegistration(ctx, registrationId);
  if (reg.status !== "confirmed") throw conflict("not_confirmed", "only confirmed places can be confirmed");
  const { rows } = await ctx.db.query<RegistrationRow>(
    "UPDATE registrations SET rsvp = 'yes', updated_at = now() WHERE id = $1 RETURNING *", [registrationId]);
  return rows[0]!;
}

/** Invalidate the old QR code (for example, a screenshot was shared) and send a new one. */
export async function reissue(ctx: Ctx, eventId: string, registrationId: string, actor: string): Promise<RegistrationRow> {
  return transaction(ctx.db, async (tx) => {
    const reg = await getRegistration(ctx, registrationId, tx, true);
    if (reg.event_id !== eventId) throw notFound("registration");
    if (reg.status !== "confirmed") throw conflict("not_confirmed", "only confirmed registrations have tickets");
    const { rows } = await tx.query<RegistrationRow>(
      "UPDATE registrations SET ticket_version = ticket_version + 1, updated_at = now() WHERE id = $1 RETURNING *",
      [reg.id]);
    const r = rows[0]!;
    await enqueue(tx, `ticket_reissued:${r.id}:${r.ticket_version}`, "ticket_reissued", r.email,
      { registrationId: r.id, eventId });
    await audit(tx, actor, "registration.reissue", eventId, r.id, { version: r.ticket_version });
    return r;
  });
}

export function ticketToken(ctx: Ctx, event: EventRow, reg: RegistrationRow): string {
  return signTicket({ eventId: event.id, registrationId: reg.id, version: reg.ticket_version },
    event.ticket_private_key_enc, ctx.master);
}

export async function listRegistrations(ctx: Ctx, eventId: string, status?: string) {
  const { rows } = await ctx.db.query<RegistrationRow & { checked_in_at: Date | null }>(
    `SELECT r.*, c.scanned_at AS checked_in_at FROM registrations r
       LEFT JOIN checkins c ON c.registration_id = r.id
      WHERE r.event_id = $1 AND ($2::text IS NULL OR r.status = $2)
      ORDER BY r.status, r.waitlist_position NULLS FIRST, r.created_at`,
    [eventId, status ?? null]);
  return rows;
}

const csvCell = (v: unknown) => {
  const s = v instanceof Date ? v.toISOString() : v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
  // Quote everything, and defuse spreadsheet formulas in attendee-supplied text.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
};

export function toCsv(rows: Awaited<ReturnType<typeof listRegistrations>>, fields: string[]): string {
  const head = ["name", "email", "status", "rsvp", "checked_in_at", "created_at", ...fields];
  const lines = rows.map((r) => [r.name, r.email, r.status, r.rsvp, r.checked_in_at, r.created_at,
    ...fields.map((f) => r.answers[f])].map(csvCell).join(","));
  return [head.map(csvCell).join(","), ...lines].join("\r\n") + "\r\n";
}
