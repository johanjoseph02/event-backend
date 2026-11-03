import express, { type Request, type Response } from "express";
import { fileURLToPath } from "node:url";
import QRCode from "qrcode";
import { z } from "zod";
import type { Ctx } from "../context.ts";
import { linkToken, readLinkToken } from "../crypto.ts";
import { bundle, createScanner, listScanners, revokeScanner, scan, type Scanner, scannerFromToken } from "../domain/checkin.ts";
import {
  attendeeView, createEvent, EventInput, EventPatch, eventBySlug, getEvent, listEvents, ownedEvent, publicView,
  setStatus, stats, updateEvent,
} from "../domain/events.ts";
import { type Organizer, organizerFromToken } from "../domain/organizers.ts";
import {
  getRegistration, listRegistrations, position, register, reissue, rsvp, ticketToken, toCsv, withdraw,
} from "../domain/registrations.ts";
import { notFound, unauthorized } from "../errors.ts";
import { bearer, errorHandler, handle, rateLimit, requestLog, securityHeaders } from "./middleware.ts";
import { registrationPage, rsvpPage, ticketPage } from "./pages.ts";

const PUBLIC_DIR = fileURLToPath(new URL("../../public/", import.meta.url));
const JSQR = fileURLToPath(new URL("../../node_modules/jsqr/dist/jsQR.js", import.meta.url));

type OrgReq = Request & { organizer: Organizer };
type ScanReq = Request & { scanner: Scanner };

const param = (req: Request, name: string) => String(req.params[name] ?? "");

/** HTML form fields: name, email, and one ``a_<field id>`` per custom question. */
function fromForm(body: Record<string, string>) {
  const answers: Record<string, string> = {};
  for (const [k, v] of Object.entries(body)) if (k.startsWith("a_")) answers[k.slice(2)] = v;
  return { name: body.name, email: body.email, answers };
}

export function createApp(ctx: Ctx): express.Express {
  const app = express();
  app.disable("x-powered-by");
  if (ctx.config.TRUST_PROXY) app.set("trust proxy", 1);
  app.use(requestLog, securityHeaders);
  app.use(express.json({ limit: "100kb" }));
  app.use(express.urlencoded({ extended: false, limit: "100kb" }));

  const orgAuth: express.RequestHandler = (req, _res, next) => {
    const token = bearer(req);
    if (!token) return next(unauthorized());
    organizerFromToken(ctx, token).then((o) => { (req as OrgReq).organizer = o; next(); }, next);
  };
  const scannerAuth: express.RequestHandler = (req, _res, next) => {
    const token = bearer(req);
    if (!token) return next(unauthorized());
    scannerFromToken(ctx, token).then((s) => { (req as ScanReq).scanner = s; next(); }, next);
  };
  const org = (req: Request) => (req as OrgReq).organizer;
  const owned = (req: Request) => ownedEvent(ctx, org(req).id, param(req, "id"));

  app.get("/healthz", handle(async (_req, res) => {
    await ctx.db.query("SELECT 1");
    res.json({ ok: true });
  }));

  // ------------------------------------------------------------------ attendees

  app.get("/api/public/events/:slug", handle(async (req, res) => {
    const e = await eventBySlug(ctx, param(req, "slug"));
    if (e.status === "draft") throw notFound("event");
    res.json(attendeeView(e));
  }));

  const registerHandler = handle(async (req, res) => {
    const form = req.is("application/x-www-form-urlencoded");
    const input = form ? fromForm(req.body as Record<string, string>) : req.body;
    const out = await register(ctx, param(req, "slug"), input);
    const r = out.registration;
    const body = {
      id: r.id, status: r.status, duplicate: out.duplicate, waitlist_position: out.position,
      ticket_url: `/t/${encodeURIComponent(linkToken("ticket", r.id, ctx.master))}`,
    };
    if (form) {
      res.redirect(303, body.ticket_url);
      return;
    }
    res.status(out.duplicate ? 200 : 201).json(body);
  });
  const limited = rateLimit(ctx.config.REGISTRATION_RATE_PER_MIN);
  app.post("/api/public/events/:slug/registrations", limited, registerHandler);

  const fromLink = (purpose: "ticket" | "rsvp", token: string) => {
    const id = readLinkToken(purpose, token, ctx.master);
    if (!id) throw notFound("link");
    return id;
  };

  async function ticketState(token: string) {
    const reg = await getRegistration(ctx, fromLink("ticket", token));
    const event = await getEvent(ctx, reg.event_id);
    const ticket = reg.status === "confirmed" ? ticketToken(ctx, event, reg) : null;
    return { reg, event, ticket, position: await position(ctx.db, reg) };
  }

  app.get("/api/public/tickets/:token", handle(async (req, res) => {
    const { reg, event, ticket, position: pos } = await ticketState(param(req, "token"));
    res.json({ name: reg.name, status: reg.status, rsvp: reg.rsvp, waitlist_position: pos, event: attendeeView(event),
      ticket, qr: ticket ? await QRCode.toDataURL(ticket, { margin: 2, width: 360 }) : null });
  }));

  const Answer = z.object({ answer: z.enum(["yes", "no"]) });
  app.post("/api/public/rsvp/:token", limited, handle(async (req, res) => {
    const id = fromLink("rsvp", param(req, "token"));
    const reg = await rsvp(ctx, id, Answer.parse(req.body).answer);
    if (req.is("application/x-www-form-urlencoded")) {
      res.redirect(303, `/r/${encodeURIComponent(param(req, "token"))}`);
      return;
    }
    res.json({ status: reg.status, rsvp: reg.rsvp });
  }));

  // Server-rendered pages: a registration form, a ticket, an RSVP page. GET never changes
  // state, so mail scanners that prefetch links cannot release anyone's place.
  app.get("/e/:slug", handle(async (req, res) => {
    const e = await eventBySlug(ctx, param(req, "slug"));
    if (e.status === "draft") throw notFound("event");
    res.type("html").send(registrationPage(e));
  }));
  app.get("/t/:token", handle(async (req, res) => {
    const s = await ticketState(param(req, "token"));
    const qr = s.ticket ? await QRCode.toDataURL(s.ticket, { margin: 2, width: 360 }) : null;
    res.type("html").send(ticketPage(s.event, s.reg, qr, s.position, linkToken("rsvp", s.reg.id, ctx.master)));
  }));
  app.get("/r/:token", handle(async (req, res) => {
    const reg = await getRegistration(ctx, fromLink("rsvp", param(req, "token")));
    const event = await getEvent(ctx, reg.event_id);
    res.type("html").send(rsvpPage(event, reg, param(req, "token")));
  }));

  // ------------------------------------------------------------------ organisers

  const api = express.Router();
  api.use(orgAuth);

  api.get("/events", handle(async (req, res) => {
    res.json((await listEvents(ctx, org(req).id)).map(publicView));
  }));
  api.post("/events", handle(async (req, res) => {
    res.status(201).json(publicView(await createEvent(ctx, org(req).id, EventInput.parse(req.body))));
  }));
  api.get("/events/:id", handle(async (req, res) => { res.json(publicView(await owned(req))); }));
  api.patch("/events/:id", handle(async (req, res) => {
    res.json(publicView(await updateEvent(ctx, org(req).id, param(req, "id"), EventPatch.parse(req.body))));
  }));
  api.post("/events/:id/publish", handle(async (req, res) => {
    res.json(publicView(await setStatus(ctx, org(req).id, param(req, "id"), "published")));
  }));
  api.post("/events/:id/cancel", handle(async (req, res) => {
    res.json(publicView(await setStatus(ctx, org(req).id, param(req, "id"), "cancelled")));
  }));
  api.get("/events/:id/stats", handle(async (req, res) => {
    const e = await owned(req);
    res.json({ capacity: e.capacity, ...(await stats(ctx, e.id)) });
  }));
  api.get("/events/:id/registrations", handle(async (req, res) => {
    const e = await owned(req);
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const rows = await listRegistrations(ctx, e.id, status);
    if (req.query.format === "csv") {
      res.type("text/csv").attachment(`${e.slug}-registrations.csv`).send(toCsv(rows, e.form.map((f) => f.id)));
      return;
    }
    res.json(rows);
  }));
  api.post("/events/:id/registrations/:rid/cancel", handle(async (req, res) => {
    const e = await owned(req);
    const reg = await getRegistration(ctx, param(req, "rid"));
    if (reg.event_id !== e.id) throw notFound("registration");
    res.json(await withdraw(ctx, reg.id, `organizer:${org(req).id}`));
  }));
  api.post("/events/:id/registrations/:rid/reissue", handle(async (req, res) => {
    const e = await owned(req);
    res.json(await reissue(ctx, e.id, param(req, "rid"), `organizer:${org(req).id}`));
  }));
  const Label = z.object({ label: z.string().trim().min(1).max(60) });
  api.get("/events/:id/scanners", handle(async (req, res) => { res.json(await listScanners(ctx, (await owned(req)).id)); }));
  api.post("/events/:id/scanners", handle(async (req, res) => {
    const e = await owned(req);
    res.status(201).json(await createScanner(ctx, e.id, Label.parse(req.body).label, `organizer:${org(req).id}`));
  }));
  api.delete("/events/:id/scanners/:label", handle(async (req, res) => {
    const e = await owned(req);
    await revokeScanner(ctx, e.id, param(req, "label"));
    res.status(204).end();
  }));
  api.get("/events/:id/audit", handle(async (req, res) => {
    const e = await owned(req);
    const { rows } = await ctx.db.query(
      "SELECT at, actor, action, registration_id, data FROM audit_log WHERE event_id = $1 ORDER BY at DESC, id DESC LIMIT 500",
      [e.id]);
    res.json(rows);
  }));
  // ------------------------------------------------------------------ door scanners

  const Scan = z.object({
    token: z.string().min(1).max(400),
    client_scan_id: z.string().min(1).max(100).optional(),
    scanned_at: z.coerce.date().optional(),
  });
  const scanApi = express.Router();
  scanApi.use(scannerAuth);
  scanApi.get("/bundle", handle(async (req, res) => { res.json(await bundle(ctx, (req as ScanReq).scanner)); }));
  scanApi.post("/checkins", handle(async (req, res) => {
    res.json(await scan(ctx, (req as ScanReq).scanner, Scan.parse(req.body)));
  }));
  scanApi.post("/checkins/batch", handle(async (req, res) => {
    const scans = z.array(Scan).max(1000).parse(req.body);
    const out = [];
    for (const s of [...scans].sort((a, b) => +(a.scanned_at ?? 0) - +(b.scanned_at ?? 0))) {
      out.push({ client_scan_id: s.client_scan_id, ...(await scan(ctx, (req as ScanReq).scanner, s)) });
    }
    res.json(out);
  }));
  app.use("/api/scanner", scanApi);
  // Organiser routes last: their auth runs for anything else under /api.
  app.use("/api", api);

  app.get("/vendor/jsQR.js", (_req, res) => res.sendFile(JSQR));
  app.get("/scanner", (_req, res) => res.sendFile(`${PUBLIC_DIR}scanner.html`));
  app.use(express.static(PUBLIC_DIR, { index: false, maxAge: "1h" }));

  app.use((_req: Request, res: Response) => { res.status(404).json({ error: { code: "not_found", message: "no such route" } }); });
  app.use(errorHandler);
  return app;
}
