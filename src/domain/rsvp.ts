/**
 * RSVP reminders and, if the organiser opted in, releasing unconfirmed places.
 *
 * Free community events lose a large share of registrants on the day. Asking everyone
 * to confirm ``rsvp_hours_before`` the start, and handing unconfirmed places to the
 * waitlist ``rsvp_deadline_hours`` before the start, turns no-shows into attendees.
 * Both steps are idempotent and safe to run from a timer every minute.
 */
import type { Ctx } from "../context.ts";
import { transaction } from "../db/pool.ts";
import { enqueue } from "../email/outbox.ts";
import { audit, type EventRow } from "./events.ts";
import { withdraw } from "./registrations.ts";

export interface RsvpReport {
  reminded: number;
  released: number;
}

export async function runRsvp(ctx: Ctx): Promise<RsvpReport> {
  const now = ctx.now();
  const report = { reminded: 0, released: 0 };

  const { rows: due } = await ctx.db.query<EventRow>(
    `SELECT * FROM events WHERE status = 'published' AND rsvp_sent_at IS NULL
       AND starts_at > $1 AND starts_at - make_interval(hours => rsvp_hours_before) <= $1`, [now]);
  for (const e of due) {
    await transaction(ctx.db, async (tx) => {
      const { rows: locked } = await tx.query<EventRow>(
        "SELECT * FROM events WHERE id = $1 AND rsvp_sent_at IS NULL FOR UPDATE", [e.id]);
      if (!locked[0]) return;
      const { rows } = await tx.query<{ id: string; email: string }>(
        `UPDATE registrations SET rsvp_requested_at = $2, updated_at = now()
          WHERE event_id = $1 AND status = 'confirmed' AND rsvp = 'pending' RETURNING id, email`, [e.id, now]);
      for (const r of rows) {
        await enqueue(tx, `rsvp:${r.id}`, "rsvp_request", r.email, { registrationId: r.id, eventId: e.id });
      }
      await tx.query("UPDATE events SET rsvp_sent_at = $2 WHERE id = $1", [e.id, now]);
      await audit(tx, "system", "rsvp.requested", e.id, null, { count: rows.length });
      report.reminded += rows.length;
    });
  }

  const { rows: deadline } = await ctx.db.query<EventRow>(
    `SELECT * FROM events WHERE status = 'published' AND release_unconfirmed AND rsvp_sent_at IS NOT NULL
       AND rsvp_released_at IS NULL AND starts_at > $1
       AND starts_at - make_interval(hours => rsvp_deadline_hours) <= $1`, [now]);
  for (const e of deadline) {
    await transaction(ctx.db, async (tx) => {
      const { rows: locked } = await tx.query<EventRow>(
        "SELECT * FROM events WHERE id = $1 AND rsvp_released_at IS NULL FOR UPDATE", [e.id]);
      if (!locked[0]) return;
      // Only people who were actually asked can lose their place.
      const { rows } = await tx.query<{ id: string }>(
        `SELECT id FROM registrations WHERE event_id = $1 AND status = 'confirmed' AND rsvp = 'pending'
           AND rsvp_requested_at IS NOT NULL ORDER BY created_at DESC`, [e.id]);
      for (const r of rows) await withdraw(ctx, r.id, "system", "released", tx);
      await tx.query("UPDATE events SET rsvp_released_at = $2 WHERE id = $1", [e.id, now]);
      await audit(tx, "system", "rsvp.released", e.id, null, { count: rows.length });
      report.released += rows.length;
    });
  }
  return report;
}
