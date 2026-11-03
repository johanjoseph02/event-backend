/**
 * Door check-in.
 *
 * A scan is accepted when the ticket's Ed25519 signature verifies under the event's key,
 * the registration is confirmed, and the ticket version is current (a reissued or
 * cancelled ticket has a newer version on the server). The first accepted scan wins;
 * later scans of the same ticket are reported as ``already`` with when and where it was
 * first used, which is what a door volunteer needs to handle a shared screenshot.
 *
 * Scanners can work offline (see ``bundle``) and sync later. When two scanners admitted
 * the same ticket while offline, the earliest ``scanned_at`` is kept as the check-in.
 * ``client_scan_id`` makes a sync safe to retry.
 */
import type { Ctx } from "../context.ts";
import { hashToken, newBearerToken, parseTicket, verifyTicket } from "../crypto.ts";
import { transaction } from "../db/pool.ts";
import { conflict, notFound, unauthorized } from "../errors.ts";
import { audit, type EventRow } from "./events.ts";

export type ScanResult = "ok" | "already" | "invalid" | "wrong_event" | "not_confirmed" | "revoked";

export interface Scanner {
  event_id: string;
  label: string;
}

export interface ScanInput {
  token: string;
  client_scan_id?: string | undefined;
  scanned_at?: Date | undefined;
}

export interface ScanOutcome {
  result: ScanResult;
  name?: string;
  checked_in_at?: Date;
  first_scanner?: string;
  replayed?: boolean;
}

export async function createScanner(ctx: Ctx, eventId: string, label: string, actor: string) {
  const { token, hash } = newBearerToken("scn");
  try {
    await ctx.db.query("INSERT INTO scanners (token_hash, event_id, label) VALUES ($1, $2, $3)", [hash, eventId, label]);
  } catch (err) {
    if ((err as { code?: string }).code === "23505") throw conflict("label_taken", "a scanner with that label exists");
    throw err;
  }
  await ctx.db.query(
    "INSERT INTO audit_log (actor, action, event_id, data) VALUES ($1, 'scanner.create', $2, $3)",
    [actor, eventId, JSON.stringify({ label })]);
  return { label, token };
}

export async function revokeScanner(ctx: Ctx, eventId: string, label: string): Promise<void> {
  const r = await ctx.db.query(
    "UPDATE scanners SET revoked_at = now() WHERE event_id = $1 AND label = $2 AND revoked_at IS NULL",
    [eventId, label]);
  if (!r.rowCount) throw notFound("scanner");
}

export async function listScanners(ctx: Ctx, eventId: string) {
  const { rows } = await ctx.db.query<{ label: string; created_at: Date; revoked_at: Date | null }>(
    "SELECT label, created_at, revoked_at FROM scanners WHERE event_id = $1 ORDER BY created_at", [eventId]);
  return rows;
}

export async function scannerFromToken(ctx: Ctx, token: string): Promise<Scanner> {
  const { rows } = await ctx.db.query<Scanner>(
    "SELECT event_id, label FROM scanners WHERE token_hash = $1 AND revoked_at IS NULL", [hashToken(token)]);
  if (!rows[0]) throw unauthorized();
  return rows[0];
}

export async function scan(ctx: Ctx, scanner: Scanner, input: ScanInput): Promise<ScanOutcome> {
  const scannedAt = input.scanned_at ?? ctx.now();
  return transaction(ctx.db, async (tx) => {
    if (input.client_scan_id) {
      const { rows } = await tx.query<{ result: ScanResult; registration_id: string | null }>(
        `SELECT result, registration_id FROM scans
          WHERE event_id = $1 AND scanner_label = $2 AND client_scan_id = $3`,
        [scanner.event_id, scanner.label, input.client_scan_id]);
      if (rows[0]) {
        const { rows: c } = await tx.query<{ scanned_at: Date; scanner_label: string; name: string }>(
          `SELECT c.scanned_at, c.scanner_label, r.name FROM checkins c
             JOIN registrations r ON r.id = c.registration_id WHERE c.registration_id = $1`,
          [rows[0].registration_id]);
        return { result: rows[0].result, replayed: true, name: c[0]?.name, checked_in_at: c[0]?.scanned_at,
          first_scanner: c[0]?.scanner_label };
      }
    }

    const log = async (result: ScanResult, registrationId: string | null) => {
      await tx.query(
        `INSERT INTO scans (event_id, registration_id, result, scanner_label, client_scan_id, scanned_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [scanner.event_id, registrationId, result, scanner.label, input.client_scan_id ?? null, scannedAt]);
    };

    const parsed = parseTicket(input.token);
    if (!parsed) {
      await log("invalid", null);
      return { result: "invalid" };
    }
    if (parsed.eventId !== scanner.event_id) {
      await log("wrong_event", null);
      return { result: "wrong_event" };
    }
    const { rows: ev } = await tx.query<EventRow>("SELECT * FROM events WHERE id = $1", [scanner.event_id]);
    const claims = verifyTicket(input.token, ev[0]!.ticket_public_key);
    if (!claims) {
      await log("invalid", null);
      return { result: "invalid" };
    }
    const { rows: regs } = await tx.query<{ id: string; name: string; status: string; ticket_version: number }>(
      "SELECT id, name, status, ticket_version FROM registrations WHERE id = $1 AND event_id = $2 FOR UPDATE",
      [claims.registrationId, scanner.event_id]);
    const reg = regs[0];
    if (!reg) {
      await log("invalid", null);
      return { result: "invalid" };
    }
    if (reg.status !== "confirmed") {
      await log("not_confirmed", reg.id);
      return { result: "not_confirmed", name: reg.name };
    }
    if (claims.version !== reg.ticket_version) {
      await log("revoked", reg.id);
      return { result: "revoked", name: reg.name };
    }

    const { rows: inserted } = await tx.query<{ scanned_at: Date }>(
      `INSERT INTO checkins (registration_id, event_id, scanned_at, scanner_label, client_scan_id)
       VALUES ($1, $2, $3, $4, $5) ON CONFLICT (registration_id) DO NOTHING RETURNING scanned_at`,
      [reg.id, scanner.event_id, scannedAt, scanner.label, input.client_scan_id ?? null]);
    if (inserted[0]) {
      await log("ok", reg.id);
      return { result: "ok", name: reg.name, checked_in_at: scannedAt };
    }
    // Already in. If this scan happened earlier (an offline device syncing late), it
    // becomes the recorded check-in; either way this device is told "already".
    const { rows: first } = await tx.query<{ scanned_at: Date; scanner_label: string }>(
      `UPDATE checkins SET scanned_at = LEAST(scanned_at, $2),
         scanner_label = CASE WHEN $2 < scanned_at THEN $3 ELSE scanner_label END
       WHERE registration_id = $1 RETURNING scanned_at, scanner_label`,
      [reg.id, scannedAt, scanner.label]);
    await log("already", reg.id);
    return { result: "already", name: reg.name, checked_in_at: first[0]!.scanned_at,
      first_scanner: first[0]!.scanner_label };
  });
}

/**
 * Everything a scanner needs to check people in without a network: the event's public
 * key and the current version of every confirmed ticket. Names are included so the
 * door can greet people; treat a scanner device as holding the guest list.
 */
export async function bundle(ctx: Ctx, scanner: Scanner) {
  const { rows: ev } = await ctx.db.query<EventRow>("SELECT * FROM events WHERE id = $1", [scanner.event_id]);
  const e = ev[0]!;
  const { rows } = await ctx.db.query<{ id: string; name: string; ticket_version: number; checked_in_at: Date | null }>(
    `SELECT r.id, r.name, r.ticket_version, c.scanned_at AS checked_in_at
       FROM registrations r LEFT JOIN checkins c ON c.registration_id = r.id
      WHERE r.event_id = $1 AND r.status = 'confirmed' ORDER BY r.name`, [e.id]);
  return {
    event: { id: e.id, title: e.title, starts_at: e.starts_at, ends_at: e.ends_at, venue: e.venue },
    public_key: e.ticket_public_key.toString("base64url"),
    scanner: scanner.label,
    generated_at: ctx.now(),
    tickets: rows.map((r) => ({ id: r.id, name: r.name, v: r.ticket_version, checked_in_at: r.checked_in_at })),
  };
}

export async function recordAudit(ctx: Ctx, actor: string, action: string, eventId: string, data: unknown) {
  await transaction(ctx.db, (tx) => audit(tx, actor, action, eventId, null, data));
}
