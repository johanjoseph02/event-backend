/**
 * Outbox delivery. Rows are *leased* (their next attempt pushed five minutes out) in a
 * short transaction, sent outside it, then marked. A worker that dies mid-send leaves a
 * lease that simply expires, and another worker picks the row up. Several workers can run
 * at once: ``FOR UPDATE SKIP LOCKED`` hands each a different batch.
 */
import type { Ctx } from "../context.ts";
import type { EventRow } from "../domain/events.ts";
import type { RegistrationRow } from "../domain/registrations.ts";
import type { EmailKind } from "./outbox.ts";
import { render } from "./render.ts";

const MAX_ATTEMPTS = 8;

interface OutboxRow {
  id: string;
  kind: EmailKind;
  to_email: string;
  payload: { registrationId: string; eventId: string };
  attempts: number;
}

export interface DeliveryReport {
  sent: number;
  dropped: number;
  failed: number;
  retried: number;
}

export async function deliverDue(ctx: Ctx, batch = 25): Promise<DeliveryReport> {
  const report = { sent: 0, dropped: 0, failed: 0, retried: 0 };
  const { rows } = await ctx.db.query<OutboxRow>(
    `UPDATE outbox SET next_attempt_at = $2::timestamptz + interval '5 minutes', attempts = attempts + 1
      WHERE id IN (SELECT id FROM outbox WHERE status = 'pending' AND next_attempt_at <= $2
                   ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED)
      RETURNING id, kind, to_email, payload, attempts`, [batch, ctx.now()]);
  for (const row of rows) {
    try {
      const [{ rows: regs }, { rows: evs }] = await Promise.all([
        ctx.db.query<RegistrationRow>("SELECT * FROM registrations WHERE id = $1", [row.payload.registrationId]),
        ctx.db.query<EventRow>("SELECT * FROM events WHERE id = $1", [row.payload.eventId]),
      ]);
      const message = regs[0] && evs[0] ? await render(ctx, row.kind, regs[0], evs[0]) : null;
      if (!message) {
        await ctx.db.query("UPDATE outbox SET status = 'sent', sent_at = now(), last_error = 'obsolete' WHERE id = $1", [row.id]);
        report.dropped++;
        continue;
      }
      await ctx.transport.send(message);
      await ctx.db.query("UPDATE outbox SET status = 'sent', sent_at = now() WHERE id = $1", [row.id]);
      report.sent++;
    } catch (err) {
      const msg = (err as Error).message.slice(0, 500);
      if (row.attempts >= MAX_ATTEMPTS) {
        await ctx.db.query("UPDATE outbox SET status = 'failed', last_error = $2 WHERE id = $1", [row.id, msg]);
        report.failed++;
      } else {
        // exponential backoff: 1, 2, 4 ... minutes, capped at six hours
        const minutes = Math.min(2 ** (row.attempts - 1), 360);
        await ctx.db.query(
          "UPDATE outbox SET last_error = $2, next_attempt_at = $3::timestamptz + make_interval(mins => $4) WHERE id = $1",
          [row.id, msg, ctx.now(), minutes]);
        report.retried++;
      }
    }
  }
  return report;
}
