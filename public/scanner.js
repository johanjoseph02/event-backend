// Door scanner: verifies tickets on the device (Ed25519, WebCrypto) against a cached
// guest list, so the door keeps moving when the venue's network does not. Every scan is
// queued and synced; the server's answer wins (for example, "already admitted at the
// other door").

const $ = (id) => document.getElementById(id);
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};

let token = new URLSearchParams(location.hash.slice(1)).get("token") || store.get("scanner-token", "");
let bundle = store.get("scanner-bundle", null);
let queue = store.get("scanner-queue", []);
let admittedHere = new Set(store.get("scanner-admitted", []));
let key = null;
let lastText = "";
let lastAt = 0;

const b64u = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const uuid = (b) => { const h = hex(b); return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`; };

function parse(t) {
  const parts = t.trim().split(".");
  if (parts.length !== 3 || parts[0] !== "T1") return null;
  try {
    const payload = b64u(parts[1]);
    const sig = b64u(parts[2]);
    if (payload.length !== 34 || sig.length !== 64) return null;
    return { eventId: uuid(payload.slice(0, 16)), registrationId: uuid(payload.slice(16, 32)),
      version: (payload[32] << 8) | payload[33], payload, sig };
  } catch { return null; }
}

async function importKey() {
  key = bundle ? await crypto.subtle.importKey("raw", b64u(bundle.public_key), { name: "Ed25519" }, false, ["verify"]) : null;
}

async function api(path, opts = {}) {
  const r = await fetch(path, { ...opts, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...(opts.headers || {}) } });
  if (r.status === 401) throw Object.assign(new Error("This scanner token is no longer valid."), { auth: true });
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json();
}

function show(kind, title, detail = "") {
  const el = $("result");
  el.className = kind;
  el.innerHTML = "";
  el.append(title);
  if (detail) { const s = document.createElement("small"); s.textContent = detail; el.append(s); }
  if (kind !== "idle" && navigator.vibrate) navigator.vibrate(kind === "ok" ? 60 : [80, 60, 80]);
}

function render() {
  $("title").textContent = bundle ? bundle.event.title : "Door scanner";
  const checked = bundle ? bundle.tickets.filter((t) => t.checked_in_at || admittedHere.has(t.id)).length : 0;
  $("admitted").textContent = checked;
  $("expected").textContent = bundle ? bundle.tickets.length : 0;
  $("queued").textContent = queue.length;
  $("synced").textContent = bundle ? `Guest list from ${new Date(bundle.generated_at).toLocaleTimeString()} · ${bundle.scanner}` : "";
  $("net").textContent = navigator.onLine ? "online" : "offline";
  $("net").className = `pill ${navigator.onLine ? "on" : ""}`;
}

async function refresh() {
  bundle = await api("/api/scanner/bundle");
  store.set("scanner-bundle", bundle);
  admittedHere = new Set();
  store.set("scanner-admitted", []);
  await importKey();
  render();
}

async function sync() {
  if (!queue.length || !navigator.onLine) return;
  const batch = queue.slice(0, 200);
  try {
    const results = await api("/api/scanner/checkins/batch", { method: "POST", body: JSON.stringify(batch) });
    const done = new Set(batch.map((b) => b.client_scan_id));
    queue = queue.filter((q) => !done.has(q.client_scan_id));
    store.set("scanner-queue", queue);
    // Tell the door if the server disagrees with what we showed offline.
    const clash = results.find((r) => r.result === "already" && r.first_scanner && r.first_scanner !== bundle?.scanner);
    if (clash) show("warn", `Note: ${clash.name ?? "a guest"} was also admitted at ${clash.first_scanner}`);
  } catch (e) {
    if (e.auth) { show("bad", e.message); }
  }
  render();
}

async function check(text) {
  const t = parse(text);
  if (!t) return show("bad", "Not a ticket");
  if (!bundle || !key) return show("bad", "No guest list yet", "Connect once to download it");
  if (t.eventId !== bundle.event.id) return show("bad", "Wrong event", "This ticket is for a different event");
  const valid = await crypto.subtle.verify({ name: "Ed25519" }, key, t.sig, t.payload);
  if (!valid) return show("bad", "Invalid ticket", "The signature does not match");
  const entry = bundle.tickets.find((x) => x.id === t.registrationId);
  if (!entry) return show("bad", "Not on the guest list", "Cancelled, released or still on the waitlist");
  if (entry.v !== t.version) return show("bad", "Old ticket", "A newer ticket was issued for this person");
  const scan = { token: text.trim(), client_scan_id: crypto.randomUUID(), scanned_at: new Date().toISOString() };
  queue.push(scan);
  store.set("scanner-queue", queue);
  if (entry.checked_in_at || admittedHere.has(entry.id)) {
    show("warn", `Already admitted: ${entry.name}`, entry.checked_in_at ? `at ${new Date(entry.checked_in_at).toLocaleTimeString()}` : "on this device");
  } else {
    admittedHere.add(entry.id);
    store.set("scanner-admitted", [...admittedHere]);
    show("ok", `Welcome, ${entry.name}`);
  }
  render();
  sync();
}

async function camera() {
  const video = $("video");
  try {
    video.srcObject = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
    await video.play();
  } catch {
    video.hidden = true;
    show("idle", "No camera available: type or paste ticket codes below");
    return;
  }
  const detector = "BarcodeDetector" in window ? new BarcodeDetector({ formats: ["qr_code"] }) : null;
  const canvas = document.createElement("canvas");
  const g = canvas.getContext("2d", { willReadFrequently: true });
  const tick = async () => {
    if (video.readyState >= 2) {
      let text = null;
      if (detector) {
        const found = await detector.detect(video).catch(() => []);
        text = found[0]?.rawValue ?? null;
      } else if (window.jsQR) {
        canvas.width = video.videoWidth; canvas.height = video.videoHeight;
        g.drawImage(video, 0, 0);
        text = window.jsQR(g.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height)?.data ?? null;
      }
      // The same code held in front of the camera is one scan, not twenty.
      if (text && (text !== lastText || Date.now() - lastAt > 4000)) {
        lastText = text; lastAt = Date.now();
        await check(text);
      }
    }
    requestAnimationFrame(tick);
  };
  tick();
}

async function start() {
  $("setup").hidden = true;
  $("scan").hidden = false;
  await importKey();
  render();
  try { await refresh(); } catch (e) { if (e.auth) { show("bad", e.message); } }
  sync();
  camera();
}

$("save").addEventListener("click", () => {
  token = $("token").value.trim();
  if (!token) return;
  store.set("scanner-token", token);
  start();
});
$("check").addEventListener("click", () => { check($("manual").value); $("manual").value = ""; });
$("refresh").addEventListener("click", () => refresh().catch((e) => show("bad", e.message)));
$("forget").addEventListener("click", () => { for (const k of ["scanner-token", "scanner-bundle", "scanner-queue", "scanner-admitted"]) store.del(k); location.reload(); });
window.addEventListener("online", () => { render(); sync(); });
window.addEventListener("offline", render);
setInterval(sync, 15000);
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/scanner-sw.js").catch(() => {});

if (token) { store.set("scanner-token", token); history.replaceState(null, "", location.pathname); start(); }
else $("setup").hidden = false;
