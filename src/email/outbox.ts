import type { Tx } from "../db/pool.ts";

export type EmailKind =
  | "confirmed"
  | "waitlisted"
  | "promoted"
  | "rsvp_request"
  | "released"
  | "cancelled"
  | "event_cancelled"
  | "ticket_reissued";

/**
 * Queue an email in the same transaction as the change it reports. ``dedupeKey`` makes
 * the call idempotent: retrying a request never sends the same email twice.
 */
export async function enqueue(tx: Tx, dedupeKey: string, kind: EmailKind, to: string,
  payload: { registrationId: string; eventId: string }): Promise<void> {
  await tx.query(
    `INSERT INTO outbox (dedupe_key, kind, to_email, payload) VALUES ($1, $2, $3, $4)
     ON CONFLICT (dedupe_key) DO NOTHING`,
    [dedupeKey, kind, to, JSON.stringify(payload)],
  );
}
