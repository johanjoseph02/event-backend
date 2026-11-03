import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  linkToken, masterKey, newTicketKeys, parseTicket, readLinkToken, seal, signTicket, unseal, verifyTicket,
} from "../src/crypto.ts";
import { Form, validateAnswers } from "../src/domain/forms.ts";
import { ics } from "../src/email/ics.ts";
import { buildMime } from "../src/email/mime.ts";

const master = masterKey("unit-test-secret-unit-test-secret-1234");

describe("tickets", () => {
  const keys = newTicketKeys(master);
  const claims = { eventId: randomUUID(), registrationId: randomUUID(), version: 3 };
  const token = signTicket(claims, keys.privateKeySealed, master);

  it("round-trips and is compact enough for a small QR code", () => {
    expect(verifyTicket(token, keys.publicKey)).toEqual(claims);
    expect(token.length).toBeLessThan(140);
    expect(parseTicket(token)?.version).toBe(3);
  });

  it("rejects tampering, other keys and junk", () => {
    const [p, payload, sig] = token.split(".");
    const bytes = Buffer.from(payload!, "base64url");
    bytes[33] = bytes[33]! ^ 1; // bump the version
    expect(verifyTicket(`${p}.${bytes.toString("base64url")}.${sig}`, keys.publicKey)).toBeNull();
    expect(verifyTicket(token, newTicketKeys(master).publicKey)).toBeNull();
    for (const junk of ["", "T1.abc.def", "T2." + token.slice(3), "hello"]) expect(verifyTicket(junk, keys.publicKey)).toBeNull();
  });

  it("keeps the signing key sealed under the master key", () => {
    expect(() => unseal(keys.privateKeySealed, masterKey("another-secret-another-secret-123456"))).toThrow();
    expect(unseal(seal(Buffer.from("x"), master), master).toString()).toBe("x");
  });
});

describe("magic links", () => {
  const id = randomUUID();
  it("bind purpose and registration", () => {
    const t = linkToken("ticket", id, master);
    expect(readLinkToken("ticket", t, master)).toBe(id);
    expect(readLinkToken("rsvp", t, master)).toBeNull();
    expect(readLinkToken("ticket", t.slice(0, -2) + "AA", master)).toBeNull();
    expect(readLinkToken("ticket", "nonsense", master)).toBeNull();
  });
});

describe("forms", () => {
  const form = Form.parse([
    { id: "team", label: "Team", type: "text", required: true, max_length: 10 },
    { id: "track", label: "Track", type: "select", options: ["web", "ml"] },
    { id: "coc", label: "Code of conduct", type: "checkbox", required: true },
  ]);

  it("validates against the event's questions", () => {
    expect(validateAnswers(form, { team: " Alpha ", track: "ml", coc: true })).toEqual({
      answers: { team: "Alpha", track: "ml", coc: true }, errors: {},
    });
    const bad = validateAnswers(form, { team: "x".repeat(11), track: "art" });
    expect(Object.keys(bad.errors).sort()).toEqual(["coc", "team", "track"]);
    expect(validateAnswers(form, "garbage").errors.team).toBe("required");
  });

  it("rejects duplicate field ids", () => {
    expect(() => Form.parse([{ id: "a", label: "A", type: "checkbox" }, { id: "a", label: "B", type: "checkbox" }])).toThrow();
  });
});

describe("email", () => {
  it("writes a valid, folded iCalendar invite", () => {
    const text = ics({ uid: "u@x", title: "Workshop; part 1, intro", description: "Line one\nLine two ".repeat(10),
      venue: "Room 4", startsAt: new Date("2030-01-01T10:00:00Z"), endsAt: new Date("2030-01-01T12:00:00Z"),
      url: "http://x" }, new Date("2029-12-01T00:00:00Z"));
    expect(text).toContain("DTSTART:20300101T100000Z");
    expect(text).toContain("SUMMARY:Workshop\\; part 1\\, intro");
    for (const line of text.split("\r\n")) expect(Buffer.byteLength(line)).toBeLessThanOrEqual(75);
  });

  it("builds multipart MIME with inline images and attachments", () => {
    const mime = buildMime("Events <e@x.org>", {
      to: "a@b.org", subject: "Tickét", text: "hi", html: "<p>hi</p>",
      attachments: [{ filename: "ticket.png", contentType: "image/png", content: Buffer.from([1, 2, 3]), cid: "qr" },
        { filename: "invite.ics", contentType: "text/calendar", content: Buffer.from("BEGIN:VCALENDAR") }],
    });
    expect(mime).toMatch(/^From: Events <e@x.org>\r\n/);
    expect(mime).toContain("Subject: =?UTF-8?B?");
    expect(mime).toContain("Content-ID: <qr>");
    expect(mime).toContain('Content-Disposition: attachment; filename="invite.ics"');
    expect(mime.match(/--mixed_/g)?.length).toBe(4);
  });
});
