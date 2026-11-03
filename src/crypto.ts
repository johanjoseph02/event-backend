/**
 * Everything cryptographic in one place.
 *
 * Tickets are Ed25519-signed, so a door scanner holding only the event's *public* key can
 * verify a ticket with no network. A ticket token is
 *
 *     "T1." + base64url(payload) + "." + base64url(signature)
 *
 * where payload is 34 bytes: event id (16), registration id (16), ticket version (uint16).
 * Bumping a registration's ticket version (reissue, cancellation) invalidates old QR codes.
 *
 * Magic links (view ticket, RSVP) carry an HMAC-SHA256 tag under APP_SECRET.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  timingSafeEqual,
  verify,
} from "node:crypto";

const b64u = (b: Buffer) => b.toString("base64url");
const unb64u = (s: string) => Buffer.from(s, "base64url");

export function masterKey(secret: string): Buffer {
  return createHash("sha256").update("event-backend:master:").update(secret).digest();
}

// --------------------------------------------------------------------- key storage

/** AES-256-GCM: nonce (12) | tag (16) | ciphertext. */
export function seal(plain: Buffer, key: Buffer): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]);
}

export function unseal(sealed: Buffer, key: Buffer): Buffer {
  const d = createDecipheriv("aes-256-gcm", key, sealed.subarray(0, 12));
  d.setAuthTag(sealed.subarray(12, 28));
  return Buffer.concat([d.update(sealed.subarray(28)), d.final()]);
}

export interface TicketKeys {
  publicKey: Buffer; // raw 32 bytes
  privateKeySealed: Buffer;
}

export function newTicketKeys(master: Buffer): TicketKeys {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pubRaw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const privDer = privateKey.export({ format: "der", type: "pkcs8" });
  return { publicKey: pubRaw, privateKeySealed: seal(privDer, master) };
}

// --------------------------------------------------------------------- tickets

const uuidBytes = (id: string) => Buffer.from(id.replaceAll("-", ""), "hex");
const bytesUuid = (b: Buffer) => {
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

export interface TicketClaims {
  eventId: string;
  registrationId: string;
  version: number;
}

export function signTicket(claims: TicketClaims, privateKeySealed: Buffer, master: Buffer): string {
  const payload = Buffer.alloc(34);
  uuidBytes(claims.eventId).copy(payload, 0);
  uuidBytes(claims.registrationId).copy(payload, 16);
  payload.writeUInt16BE(claims.version, 32);
  const key = createPrivateKey({ key: unseal(privateKeySealed, master), format: "der", type: "pkcs8" });
  return `T1.${b64u(payload)}.${b64u(sign(null, payload, key))}`;
}

/** Parse without verifying: tells the server which event's key to verify with. */
export function parseTicket(token: string): (TicketClaims & { payload: Buffer; sig: Buffer }) | null {
  const parts = token.trim().split(".");
  if (parts.length !== 3 || parts[0] !== "T1") return null;
  const payload = unb64u(parts[1] ?? "");
  const sig = unb64u(parts[2] ?? "");
  if (payload.length !== 34 || sig.length !== 64) return null;
  return {
    eventId: bytesUuid(payload.subarray(0, 16)),
    registrationId: bytesUuid(payload.subarray(16, 32)),
    version: payload.readUInt16BE(32),
    payload,
    sig,
  };
}

export function verifyTicket(token: string, publicKeyRaw: Buffer): TicketClaims | null {
  const t = parseTicket(token);
  if (!t) return null;
  const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), publicKeyRaw]);
  const key = createPublicKey({ key: spki, format: "der", type: "spki" });
  if (!verify(null, t.payload, key, t.sig)) return null;
  return { eventId: t.eventId, registrationId: t.registrationId, version: t.version };
}

// --------------------------------------------------------------------- links and tokens

export type LinkPurpose = "ticket" | "rsvp";

export function linkToken(purpose: LinkPurpose, registrationId: string, master: Buffer): string {
  const tag = createHmac("sha256", master).update(`${purpose}:${registrationId}`).digest().subarray(0, 16);
  return `${b64u(uuidBytes(registrationId))}.${b64u(tag)}`;
}

export function readLinkToken(purpose: LinkPurpose, token: string, master: Buffer): string | null {
  const [idPart, tagPart] = token.split(".");
  if (!idPart || !tagPart) return null;
  const id = unb64u(idPart);
  if (id.length !== 16) return null;
  const registrationId = bytesUuid(id);
  const expected = createHmac("sha256", master).update(`${purpose}:${registrationId}`).digest().subarray(0, 16);
  const given = unb64u(tagPart);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  return registrationId;
}

/** A new bearer token and the hash to store. Tokens are shown once and never stored. */
export function newBearerToken(prefix: string): { token: string; hash: Buffer } {
  const token = `${prefix}_${b64u(randomBytes(24))}`;
  return { token, hash: hashToken(token) };
}

export function hashToken(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}
