import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.ts";
import { testEnv } from "./helpers.ts";

const env = await testEnv();
const app = createApp(env.ctx);
const auth = { Authorization: `Bearer ${env.token}` };

const eventBody = (slug: string, capacity = 2) => ({
  slug, title: "Alexa Skills Night", venue: "Main auditorium", capacity,
  starts_at: "2030-03-10T12:30:00Z", ends_at: "2030-03-10T15:00:00Z",
  form: [{ id: "year", label: "Year of study", type: "select", options: ["1", "2", "3", "4"], required: true }],
});

async function liveEvent(slug: string, capacity = 2) {
  const created = await request(app).post("/api/events").set(auth).send(eventBody(slug, capacity));
  expect(created.status).toBe(201);
  expect(created.body).not.toHaveProperty("ticket_private_key_enc");
  await request(app).post(`/api/events/${created.body.id}/publish`).set(auth).expect(200);
  return created.body.id as string;
}

describe("HTTP API", () => {
  it("guards organiser routes", async () => {
    await request(app).get("/api/events").expect(401);
    await request(app).get("/api/events").set({ Authorization: "Bearer org_nope" }).expect(401);
    await request(app).get("/api/events").set(auth).expect(200);
    await request(app).post("/api/events").set(auth).send({ slug: "Bad Slug" }).expect(422);
  });

  it("runs the whole flow: publish, register, ticket, check in, export", async () => {
    const id = await liveEvent("skills-night");
    await request(app).post("/api/events").set(auth).send(eventBody("skills-night")).expect(409);

    const pub = await request(app).get("/api/public/events/skills-night").expect(200);
    expect(pub.body).toMatchObject({ seats_left: 2, form: [{ id: "year" }] });

    await request(app).post("/api/public/events/skills-night/registrations")
      .send({ name: "Ravi", email: "ravi@example.org" }).expect(422);
    const reg = await request(app).post("/api/public/events/skills-night/registrations")
      .send({ name: "Ravi", email: "ravi@example.org", answers: { year: "2" } }).expect(201);
    expect(reg.body).toMatchObject({ status: "confirmed", duplicate: false });
    const dup = await request(app).post("/api/public/events/skills-night/registrations")
      .send({ name: "Ravi", email: "RAVI@example.org", answers: { year: "2" } }).expect(200);
    expect(dup.body.duplicate).toBe(true);

    // a plain HTML form post redirects to the ticket page
    const form = await request(app).post("/api/public/events/skills-night/registrations").type("form")
      .send({ name: "=cmd|' /C calc'!A0", email: "meera@example.org", a_year: "3" }).expect(303);
    expect(form.headers.location).toMatch(/^\/t\//);
    const ticketPage = await request(app).get(form.headers.location!).expect(200);
    expect(ticketPage.text).toContain("Confirmed");
    expect(ticketPage.text).toContain('alt="Ticket QR code');

    const ticket = await request(app).get(`/api/public/tickets/${reg.body.ticket_url.slice(3)}`).expect(200);
    expect(ticket.body.ticket).toMatch(/^T1\./);

    const scanner = await request(app).post(`/api/events/${id}/scanners`).set(auth).send({ label: "gate" }).expect(201);
    const door = { Authorization: `Bearer ${scanner.body.token}` };
    await request(app).get("/api/scanner/bundle").expect(401);
    await request(app).get("/api/events").set(door).expect(401); // a scanner token is not an organiser token
    const bundle = await request(app).get("/api/scanner/bundle").set(door).expect(200);
    expect(bundle.body.tickets).toHaveLength(2);
    const ok = await request(app).post("/api/scanner/checkins").set(door).send({ token: ticket.body.ticket }).expect(200);
    expect(ok.body).toMatchObject({ result: "ok", name: "Ravi" });
    const batch = await request(app).post("/api/scanner/checkins/batch").set(door).send([
      { token: ticket.body.ticket, client_scan_id: "x1", scanned_at: "2030-03-10T12:31:00Z" },
      { token: "junk", client_scan_id: "x2" },
    ]).expect(200);
    expect(batch.body.map((b: { result: string }) => b.result).sort()).toEqual(["already", "invalid"]);

    const stats = await request(app).get(`/api/events/${id}/stats`).set(auth).expect(200);
    expect(stats.body).toMatchObject({ capacity: 2, confirmed: 2, checked_in: 1, show_rate: 0.5 });

    const csv = await request(app).get(`/api/events/${id}/registrations?format=csv`).set(auth).expect(200);
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.text).toContain('"year"');
    expect(csv.text).toContain(`"'=cmd|' /C calc'!A0"`); // formula defused

    await request(app).delete(`/api/events/${id}/scanners/gate`).set(auth).expect(204);
    await request(app).get("/api/scanner/bundle").set(door).expect(401);
  });

  it("never changes state on GET, so link prefetchers cannot release a place", async () => {
    await liveEvent("prefetch-test", 1);
    const reg = await request(app).post("/api/public/events/prefetch-test/registrations")
      .send({ name: "Anu", email: "anu@example.org", answers: { year: "1" } }).expect(201);
    const ticketToken = reg.body.ticket_url.slice(3);
    const page = await request(app).get(`/t/${ticketToken}`).expect(200);
    const rsvpLink = /href="(\/r\/[^"]+)"/.exec(page.text)![1]!;
    for (let i = 0; i < 3; i++) await request(app).get(rsvpLink).expect(200);
    const still = await request(app).get(`/api/public/tickets/${ticketToken}`).expect(200);
    expect(still.body.status).toBe("confirmed");

    await request(app).post(`/api/public/rsvp${rsvpLink.slice(2)}`).type("form").send({ answer: "no" }).expect(303);
    const gone = await request(app).get(`/api/public/tickets/${ticketToken}`).expect(200);
    expect(gone.body).toMatchObject({ status: "cancelled", ticket: null });
  });

  it("serves the registration page and the scanner app, and 404s cleanly", async () => {
    await liveEvent("page-test");
    const page = await request(app).get("/e/page-test").expect(200);
    expect(page.text).toContain('name="a_year"');
    expect(page.headers["content-security-policy"]).toContain("default-src 'self'");
    await request(app).get("/scanner").expect(200);
    await request(app).get("/vendor/jsQR.js").expect(200);
    await request(app).get("/t/forged.token").expect(404);
    await request(app).get("/api/public/events/nope").expect(404);
    await request(app).get("/nothing-here").expect(404);
    await request(app).post("/api/public/events/page-test/registrations").set("content-type", "application/json")
      .send("{not json").expect(400);
  });
});
