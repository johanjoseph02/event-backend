/**
 * Turn an outbox row into an email, using the registration *as it is now*. If the state
 * changed since the email was queued (a confirmation for someone who has since
 * cancelled), the email is dropped instead of sent.
 */
import QRCode from "qrcode";
import type { Ctx } from "../context.ts";
import { linkToken } from "../crypto.ts";
import type { EventRow } from "../domain/events.ts";
import { position, type RegistrationRow, ticketToken } from "../domain/registrations.ts";
import { ics } from "./ics.ts";
import type { Attachment, Message } from "./mime.ts";
import type { EmailKind } from "./outbox.ts";

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function when(e: EventRow): string {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    weekday: "long", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit",
    timeZone: "UTC", timeZoneName: "short",
  });
  return fmt.format(e.starts_at);
}

const stillValid: Record<EmailKind, (r: RegistrationRow, e: EventRow) => boolean> = {
  confirmed: (r) => r.status === "confirmed",
  promoted: (r) => r.status === "confirmed",
  ticket_reissued: (r) => r.status === "confirmed",
  rsvp_request: (r) => r.status === "confirmed" && r.rsvp === "pending",
  waitlisted: (r) => r.status === "waitlisted",
  released: (r) => r.status === "released",
  cancelled: (r) => r.status === "cancelled",
  event_cancelled: (_r, e) => e.status === "cancelled",
};

export async function render(ctx: Ctx, kind: EmailKind, reg: RegistrationRow, event: EventRow): Promise<Message | null> {
  if (!stillValid[kind](reg, event)) return null;
  const base = ctx.config.BASE_URL.replace(/\/$/, "");
  const ticketUrl = `${base}/t/${linkToken("ticket", reg.id, ctx.master)}`;
  const rsvpUrl = `${base}/r/${linkToken("rsvp", reg.id, ctx.master)}`;
  const greeting = `Hi ${reg.name},`;
  const details = `${event.title}\n${when(event)}${event.venue ? `\n${event.venue}` : ""}`;
  const attachments: Attachment[] = [];
  let subject: string;
  let body: string[];
  let qr = false;

  switch (kind) {
    case "confirmed":
    case "promoted":
    case "ticket_reissued": {
      subject = kind === "promoted" ? `A place opened up: you're in for ${event.title}`
        : kind === "ticket_reissued" ? `Your new ticket for ${event.title}` : `You're registered: ${event.title}`;
      body = [
        kind === "promoted" ? "Someone gave up their place and you were next on the waitlist. Your place is confirmed."
          : kind === "ticket_reissued" ? "Your ticket was reissued. The old QR code no longer works; use this one."
            : "Your place is confirmed.",
        details,
        "Show the QR code below at the door, or open your ticket:",
        ticketUrl,
        "Can't make it after all? Release your place so someone on the waitlist can come:",
        rsvpUrl,
      ];
      qr = true;
      attachments.push({
        filename: "invite.ics", contentType: "text/calendar; charset=utf-8; method=PUBLISH",
        content: Buffer.from(ics({ uid: `${reg.id}@event-backend`, title: event.title, description: event.description,
          venue: event.venue, startsAt: event.starts_at, endsAt: event.ends_at, url: ticketUrl }, ctx.now())),
      });
      break;
    }
    case "waitlisted": {
      const pos = await position(ctx.db, reg);
      subject = `You're on the waitlist for ${event.title}`;
      body = [`The event is full, so you're number ${pos ?? "?"} on the waitlist. If a place opens up before the event, you'll get it automatically and we'll email your ticket.`,
        details, "To leave the waitlist:", rsvpUrl];
      break;
    }
    case "rsvp_request":
      subject = `Still coming to ${event.title}?`;
      body = [`${event.title} is coming up. Please let us know whether you're still coming, so that if you're not, someone on the waitlist can have your place.`,
        details, "Confirm or release your place:", rsvpUrl,
        ...(event.release_unconfirmed
          ? [`Places not confirmed ${event.rsvp_deadline_hours} hours before the start are released to the waitlist.`] : [])];
      break;
    case "released":
      subject = `Your place at ${event.title} was released`;
      body = ["We didn't hear back in time, so your place went to someone on the waitlist. You can register again if places are still available.", details];
      break;
    case "cancelled":
      subject = `You've left ${event.title}`;
      body = ["Your registration is cancelled and your place has gone to the next person on the waitlist, if there was one. Thanks for letting us know.", details];
      break;
    case "event_cancelled":
      subject = `Cancelled: ${event.title}`;
      body = ["Sorry: this event has been cancelled.", details];
      attachments.push({
        filename: "cancel.ics", contentType: "text/calendar; charset=utf-8; method=CANCEL",
        content: Buffer.from(ics({ uid: `${reg.id}@event-backend`, title: event.title, description: event.description,
          venue: event.venue, startsAt: event.starts_at, endsAt: event.ends_at, url: base, cancelled: true }, ctx.now())),
      });
      break;
  }

  if (qr) {
    const png = await QRCode.toBuffer(ticketToken(ctx, event, reg), { errorCorrectionLevel: "M", margin: 2, width: 360 });
    attachments.unshift({ filename: "ticket.png", contentType: "image/png", content: png, cid: "ticket-qr" });
  }
  const text = [greeting, "", ...body.flatMap((p) => [p, ""])].join("\n");
  const html = `<!doctype html><html><body style="font-family:system-ui,sans-serif;line-height:1.5;color:#15181d;max-width:560px">
<p>${esc(greeting)}</p>
${body.map((p) => p.startsWith("http") ? `<p><a href="${esc(p)}">${esc(p)}</a></p>` : `<p>${esc(p).replace(/\n/g, "<br>")}</p>`).join("\n")}
${qr ? '<p><img src="cid:ticket-qr" alt="Your ticket QR code" width="240" height="240"></p>' : ""}
</body></html>`;
  return { to: reg.email, subject, text, html, attachments };
}
