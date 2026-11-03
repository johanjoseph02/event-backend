/**
 * Three small server-rendered pages: register, view a ticket, confirm or release a place.
 * Plain HTML forms with no scripts, so they work on any phone and with JavaScript off.
 */
import type { EventRow } from "../domain/events.ts";
import type { RegistrationRow } from "../domain/registrations.ts";

const esc = (s: unknown) => String(s ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const when = (e: EventRow) => new Intl.DateTimeFormat("en-GB", {
  weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit", timeZone: "UTC", timeZoneName: "short",
}).format(e.starts_at);

function layout(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  :root { color-scheme: light dark; --ink:#15181d; --muted:#5d6673; --bg:#f6f7f9; --panel:#fff; --line:#e2e6eb; --accent:#2b59c3; --ok:#1f8a4c; --warn:#b26b00; }
  @media (prefers-color-scheme: dark) { :root { --ink:#e8ebef; --muted:#9aa3ae; --bg:#0f1216; --panel:#171b21; --line:#29303a; --accent:#7d9bff; --ok:#4fd08a; --warn:#f0b44c; } }
  * { box-sizing: border-box; }
  body { margin:0; font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; background:var(--bg); color:var(--ink); }
  main { max-width:560px; margin:0 auto; padding:24px 16px 48px; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:14px; padding:20px; margin-top:16px; }
  h1 { font-size:26px; line-height:1.2; margin:0 0 6px; }
  .muted { color:var(--muted); }
  label { display:block; font-weight:600; margin:14px 0 6px; }
  input[type=text], input[type=email], select { width:100%; font:inherit; color:inherit; background:var(--bg); border:1px solid var(--line); border-radius:10px; padding:10px 12px; }
  .check { display:flex; gap:10px; align-items:flex-start; font-weight:500; }
  button { font:inherit; border-radius:10px; padding:11px 16px; border:1px solid var(--accent); background:var(--accent); color:#fff; cursor:pointer; }
  button.secondary { background:transparent; color:var(--ink); border-color:var(--line); }
  :focus-visible { outline:3px solid color-mix(in srgb, var(--accent) 50%, transparent); outline-offset:2px; }
  .status { display:inline-block; padding:2px 10px; border-radius:999px; border:1px solid currentColor; font-size:14px; font-weight:600; }
  .ok { color:var(--ok); } .warn { color:var(--warn); }
  img.qr { display:block; width:100%; max-width:300px; margin:12px auto; border-radius:8px; background:#fff; padding:8px; }
  .row { display:flex; gap:10px; flex-wrap:wrap; margin-top:12px; }
</style></head><body><main>${body}</main></body></html>`;
}

function eventHeader(e: EventRow): string {
  return `<h1>${esc(e.title)}</h1><p class="muted">${esc(when(e))}${e.venue ? ` · ${esc(e.venue)}` : ""}</p>`;
}

export function registrationPage(e: EventRow): string {
  const seats = Math.max(e.capacity - e.confirmed_count, 0);
  const open = e.status === "published";
  const fields = e.form.map((f) => {
    const id = `a_${f.id}`;
    const req = f.required ? " required" : "";
    if (f.type === "checkbox") {
      return `<label class="check"><input type="checkbox" name="${id}" value="on"${req}> ${esc(f.label)}</label>`;
    }
    if (f.type === "select") {
      return `<label for="${id}">${esc(f.label)}</label><select id="${id}" name="${id}"${req}>
        <option value="">Choose…</option>${f.options.map((o) => `<option>${esc(o)}</option>`).join("")}</select>`;
    }
    return `<label for="${id}">${esc(f.label)}</label><input type="text" id="${id}" name="${id}" maxlength="${f.max_length}"${req}>`;
  }).join("\n");
  const note = e.status === "cancelled" ? '<p class="status warn">This event has been cancelled.</p>'
    : seats > 0 ? `<p class="muted">${seats} place${seats === 1 ? "" : "s"} left.</p>`
      : e.waitlist ? '<p class="status warn">Full: you can join the waitlist.</p>' : '<p class="status warn">This event is full.</p>';
  return layout(e.title, `${eventHeader(e)}
  ${e.description ? `<p>${esc(e.description).replace(/\n/g, "<br>")}</p>` : ""}
  <div class="card">${note}
  ${open && (seats > 0 || e.waitlist) ? `<form method="post" action="/api/public/events/${esc(e.slug)}/registrations">
    <label for="name">Name</label><input type="text" id="name" name="name" autocomplete="name" required maxlength="200">
    <label for="email">Email</label><input type="email" id="email" name="email" autocomplete="email" required>
    ${fields}
    <div class="row"><button type="submit">${seats > 0 ? "Register" : "Join the waitlist"}</button></div>
  </form>` : ""}</div>`);
}

export function ticketPage(e: EventRow, r: RegistrationRow, qr: string | null, pos: number | null, rsvpToken: string): string {
  const state = r.status === "confirmed" ? '<span class="status ok">Confirmed</span>'
    : r.status === "waitlisted" ? `<span class="status warn">Waitlist, number ${pos ?? "?"}</span>`
      : `<span class="status warn">${r.status === "released" ? "Place released" : "Cancelled"}</span>`;
  return layout(`Ticket: ${e.title}`, `${eventHeader(e)}
  <div class="card"><p>${esc(r.name)} · ${state}</p>
  ${qr ? `<img class="qr" src="${qr}" alt="Ticket QR code for ${esc(r.name)}"><p class="muted">Show this at the door. A screenshot works offline.</p>` : ""}
  ${r.status === "waitlisted" ? "<p>If a place opens up before the event, it is yours automatically and we will email your ticket.</p>" : ""}
  ${r.status === "confirmed" || r.status === "waitlisted" ? `<p><a href="/r/${esc(rsvpToken)}">Can't come? Release your place</a></p>` : ""}
  </div>`);
}

export function rsvpPage(e: EventRow, r: RegistrationRow, token: string): string {
  const action = `/api/public/rsvp/${esc(token)}`;
  let body: string;
  if (r.status === "confirmed") {
    body = r.rsvp === "yes"
      ? `<p class="status ok">You confirmed you're coming. See you there.</p>
         <form method="post" action="${action}"><input type="hidden" name="answer" value="no">
         <div class="row"><button class="secondary" type="submit">I can't come after all: release my place</button></div></form>`
      : `<p>Are you still coming?</p><div class="row">
         <form method="post" action="${action}"><input type="hidden" name="answer" value="yes"><button type="submit">Yes, I'm coming</button></form>
         <form method="post" action="${action}"><input type="hidden" name="answer" value="no"><button class="secondary" type="submit">No, release my place</button></form></div>`;
  } else if (r.status === "waitlisted") {
    body = `<p>You're on the waitlist.</p><form method="post" action="${action}"><input type="hidden" name="answer" value="no">
      <div class="row"><button class="secondary" type="submit">Leave the waitlist</button></div></form>`;
  } else {
    body = `<p class="status warn">${r.status === "released" ? "Your place was released." : "You're no longer registered."}</p>
      <p><a href="/e/${esc(e.slug)}">Register again</a> if places are available.</p>`;
  }
  return layout(`RSVP: ${e.title}`, `${eventHeader(e)}<div class="card"><p>${esc(r.name)}</p>${body}</div>`);
}
