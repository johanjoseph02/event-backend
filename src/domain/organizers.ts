import type { Ctx } from "../context.ts";
import { hashToken, newBearerToken } from "../crypto.ts";
import { conflict, unauthorized } from "../errors.ts";

export interface Organizer {
  id: string;
  email: string;
  name: string;
}

export async function createOrganizer(ctx: Ctx, email: string, name: string): Promise<Organizer> {
  try {
    const { rows } = await ctx.db.query<Organizer>(
      "INSERT INTO organizers (email, name) VALUES ($1, $2) RETURNING id, email, name", [email.trim().toLowerCase(), name]);
    return rows[0]!;
  } catch (err) {
    if ((err as { code?: string }).code === "23505") throw conflict("email_taken", "an organiser with that email exists");
    throw err;
  }
}

/** A new API token; only its hash is stored, so this is the one time it can be shown. */
export async function issueToken(ctx: Ctx, organizerId: string, label = ""): Promise<string> {
  const { token, hash } = newBearerToken("org");
  await ctx.db.query("INSERT INTO api_tokens (token_hash, organizer_id, label) VALUES ($1, $2, $3)",
    [hash, organizerId, label]);
  return token;
}

export async function organizerFromToken(ctx: Ctx, token: string): Promise<Organizer> {
  const { rows } = await ctx.db.query<Organizer>(
    `UPDATE api_tokens t SET last_used_at = now() FROM organizers o
      WHERE t.token_hash = $1 AND o.id = t.organizer_id RETURNING o.id, o.email, o.name`, [hashToken(token)]);
  if (!rows[0]) throw unauthorized();
  return rows[0];
}
