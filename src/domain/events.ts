import { z } from "zod";
import type { Ctx } from "../context.ts";
import { newTicketKeys } from "../crypto.ts";
import { transaction, type Tx } from "../db/pool.ts";
import { enqueue } from "../email/outbox.ts";
import { conflict, invalid, notFound } from "../errors.ts";
import { Form } from "./forms.ts";

export const EventInput = z
  .object({
    slug: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/).max(80),
    title: z.string().min(1).max(200),
    description: z.string().max(10_000).default(""),
    venue: z.string().max(300).default(""),
    starts_at: z.coerce.date(),
    ends_at: z.coerce.date(),
    capacity: z.number().int().positive().max(100_000),
    waitlist: z.boolean().default(true),
    registration_opens_at: z.coerce.date().nullable().default(null),
    registration_closes_at: z.coerce.date().nullable().default(null),
    rsvp_hours_before: z.number().int().min(0).max(24 * 30).default(48),
    release_unconfirmed: z.boolean().default(false),
    rsvp_deadline_hours: z.number().int().min(0).max(24 * 30).default(12),
    form: Form.default([]),
  })
  .refine((e) => e.ends_at > e.starts_at, { message: "ends_at must be after starts_at", path: ["ends_at"] })
  .refine((e) => e.rsvp_deadline_hours <= e.rsvp_hours_before, {
    message: "the RSVP deadline must come after the reminder",
    path: ["rsvp_deadline_hours"],
  });
export type EventInput = z.infer<typeof EventInput>;

export const EventPatch = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(10_000),
  venue: z.string().max(300),
  starts_at: z.coerce.date(),
  ends_at: z.coerce.date(),
  capacity: z.number().int().positive().max(100_000),
  waitlist: z.boolean(),
  registration_opens_at: z.coerce.date().nullable(),
  registration_closes_at: z.coerce.date().nullable(),
  rsvp_hours_before: z.number().int().min(0),
  release_unconfirmed: z.boolean(),
  rsvp_deadline_hours: z.number().int().min(0),
  form: Form,
}).partial();

export interface EventRow {
  id: string;
  organizer_id: string;
  slug: string;
  title: string;
  description: string;
  venue: string;
  starts_at: Date;
  ends_at: Date;
  capacity: number;
  waitlist: boolean;
  registration_opens_at: Date | null;
  registration_closes_at: Date | null;
  rsvp_hours_before: number;
  release_unconfirmed: boolean;
  rsvp_deadline_hours: number;
  form: Form;
  status: "draft" | "published" | "cancelled";
  confirmed_count: number;
  ticket_public_key: Buffer;
  ticket_private_key_enc: Buffer;
  rsvp_sent_at: Date | null;
  rsvp_released_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/** What organisers see: everything but the sealed private key. */
export function publicView(e: EventRow) {
  const { ticket_private_key_enc: _sealed, ticket_public_key, ...rest } = e;
  return { ...rest, ticket_public_key: ticket_public_key.toString("base64url"), seats_left: e.capacity - e.confirmed_count };
}

/** What anyone may see about a published event. */
export function attendeeView(e: EventRow) {
  return {
    slug: e.slug, title: e.title, description: e.description, venue: e.venue,
    starts_at: e.starts_at, ends_at: e.ends_at, status: e.status, form: e.form,
    seats_left: Math.max(e.capacity - e.confirmed_count, 0), waitlist: e.waitlist,
    registration_opens_at: e.registration_opens_at, registration_closes_at: e.registration_closes_at,
  };
}

export async function createEvent(ctx: Ctx, organizerId: string, input: EventInput): Promise<EventRow> {
  const keys = newTicketKeys(ctx.master);
  try {
    const { rows } = await ctx.db.query<EventRow>(
      `INSERT INTO events (organizer_id, slug, title, description, venue, starts_at, ends_at, capacity,
         waitlist, registration_opens_at, registration_closes_at, rsvp_hours_before, release_unconfirmed,
         rsvp_deadline_hours, form, ticket_public_key, ticket_private_key_enc)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
      [organizerId, input.slug, input.title, input.description, input.venue, input.starts_at, input.ends_at,
        input.capacity, input.waitlist, input.registration_opens_at, input.registration_closes_at,
        input.rsvp_hours_before, input.release_unconfirmed, input.rsvp_deadline_hours, JSON.stringify(input.form),
        keys.publicKey, keys.privateKeySealed],
    );
    return rows[0]!;
  } catch (err) {
    if ((err as { code?: string }).code === "23505") throw conflict("slug_taken", `slug ${input.slug} is taken`);
    throw err;
  }
}

export async function getEvent(ctx: Ctx | { db: Ctx["db"] }, id: string, tx?: Tx, lock = false): Promise<EventRow> {
  const q = tx ?? ctx.db;
  const { rows } = await q.query<EventRow>(`SELECT * FROM events WHERE id = $1${lock ? " FOR UPDATE" : ""}`, [id]);
  if (!rows[0]) throw notFound("event");
  return rows[0];
}

export async function eventBySlug(ctx: Ctx, slug: string): Promise<EventRow> {
  const { rows } = await ctx.db.query<EventRow>("SELECT * FROM events WHERE slug = $1", [slug]);
  if (!rows[0]) throw notFound("event");
  return rows[0];
}

export async function ownedEvent(ctx: Ctx, organizerId: string, id: string): Promise<EventRow> {
  const e = await getEvent(ctx, id).catch(() => null);
  if (!e || e.organizer_id !== organizerId) throw notFound("event");
  return e;
}

export async function listEvents(ctx: Ctx, organizerId: string): Promise<EventRow[]> {
  const { rows } = await ctx.db.query<EventRow>(
    "SELECT * FROM events WHERE organizer_id = $1 ORDER BY starts_at DESC", [organizerId]);
  return rows;
}

const COLUMNS = new Set(Object.keys(EventPatch.shape));

export async function updateEvent(ctx: Ctx, organizerId: string, id: string, patch: z.infer<typeof EventPatch>) {
  return transaction(ctx.db, async (tx) => {
    const e = await getEvent(ctx, id, tx, true);
    if (e.organizer_id !== organizerId) throw notFound("event");
    if (e.status === "cancelled") throw conflict("cancelled", "a cancelled event cannot be edited");
    const next = { ...e, ...patch };
    if (next.ends_at <= next.starts_at) throw invalid("ends_at must be after starts_at");
    if (next.capacity < e.confirmed_count) {
      throw conflict("capacity_below_confirmed",
        `${e.confirmed_count} people are already confirmed; capacity cannot go below that`);
    }
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) {
      if (!COLUMNS.has(k)) continue;
      values.push(k === "form" ? JSON.stringify(v) : v);
      sets.push(`${k} = $${values.length}`);
    }
    if (!sets.length) return e;
    values.push(id);
    const { rows } = await tx.query<EventRow>(
      `UPDATE events SET ${sets.join(", ")}, updated_at = now() WHERE id = $${values.length} RETURNING *`, values);
    const updated = rows[0]!;
    // More seats: move people up from the waitlist straight away.
    if (updated.capacity > e.capacity) {
      const { promoteFromWaitlist } = await import("./registrations.ts");
      await promoteFromWaitlist(ctx, tx, updated);
    }
    await audit(tx, `organizer:${organizerId}`, "event.update", id, null, patch);
    return getEvent(ctx, id, tx);
  });
}

export async function setStatus(ctx: Ctx, organizerId: string, id: string, status: "published" | "cancelled") {
  return transaction(ctx.db, async (tx) => {
    const e = await getEvent(ctx, id, tx, true);
    if (e.organizer_id !== organizerId) throw notFound("event");
    if (e.status === "cancelled") throw conflict("cancelled", "the event is already cancelled");
    if (status === "published" && e.status === "published") return e;
    await tx.query("UPDATE events SET status = $1, updated_at = now() WHERE id = $2", [status, id]);
    if (status === "cancelled") {
      const { rows } = await tx.query<{ id: string; email: string; name: string }>(
        `UPDATE registrations SET status = 'cancelled', cancelled_at = now(), updated_at = now(),
           ticket_version = ticket_version + 1
         WHERE event_id = $1 AND status IN ('confirmed', 'waitlisted') RETURNING id, email, name`, [id]);
      await tx.query("UPDATE events SET confirmed_count = 0 WHERE id = $1", [id]);
      for (const r of rows) {
        await enqueue(tx, `event-cancelled:${r.id}`, "event_cancelled", r.email, { registrationId: r.id, eventId: id });
      }
    }
    await audit(tx, `organizer:${organizerId}`, `event.${status}`, id, null, {});
    return getEvent(ctx, id, tx);
  });
}

export async function stats(ctx: Ctx, eventId: string) {
  const { rows } = await ctx.db.query<{ status: string; n: string; rsvp_yes: string; rsvp_no: string; checked_in: string }>(
    `SELECT r.status, COUNT(*) AS n,
            COUNT(*) FILTER (WHERE r.rsvp = 'yes') AS rsvp_yes,
            COUNT(*) FILTER (WHERE r.rsvp = 'no') AS rsvp_no,
            COUNT(c.registration_id) AS checked_in
       FROM registrations r LEFT JOIN checkins c ON c.registration_id = r.id
      WHERE r.event_id = $1 GROUP BY r.status`, [eventId]);
  const by = Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
  const confirmed = by.confirmed ?? 0;
  const checkedIn = rows.reduce((s, r) => s + Number(r.checked_in), 0);
  const scans = await ctx.db.query<{ result: string; n: string }>(
    "SELECT result, COUNT(*) AS n FROM scans WHERE event_id = $1 GROUP BY result", [eventId]);
  return {
    confirmed,
    waitlisted: by.waitlisted ?? 0,
    cancelled: by.cancelled ?? 0,
    released: by.released ?? 0,
    rsvp_yes: rows.reduce((s, r) => s + Number(r.rsvp_yes), 0),
    rsvp_no: rows.reduce((s, r) => s + Number(r.rsvp_no), 0),
    checked_in: checkedIn,
    show_rate: confirmed ? checkedIn / confirmed : null,
    scans: Object.fromEntries(scans.rows.map((r) => [r.result, Number(r.n)])),
  };
}

export async function audit(tx: Tx, actor: string, action: string, eventId: string | null,
  registrationId: string | null, data: unknown): Promise<void> {
  await tx.query(
    "INSERT INTO audit_log (actor, action, event_id, registration_id, data) VALUES ($1, $2, $3, $4, $5)",
    [actor, action, eventId, registrationId, JSON.stringify(data ?? {})]);
}
