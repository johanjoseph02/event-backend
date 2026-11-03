# Design

The backend makes five promises. Each one is a specific mechanism and a specific test.

## 1. Nobody is confirmed for a seat that does not exist

Registration opens, a link goes round a group chat, and hundreds of people press the
button in the same second. Every registration runs in one transaction that first takes a
row lock on its event (`SELECT ... FOR UPDATE`). Registrations for the same event queue on
that lock and see each other's results; registrations for different events never wait for
each other. The seat count lives on the event row (`confirmed_count`), and a `CHECK
(confirmed_count <= capacity)` constraint means that even a bug that tried to overbook
would be refused by the database.

Why a row lock rather than `SERIALIZABLE` isolation: serialisable transactions would also
be correct, but under a rush most of them would fail with serialisation errors and need
retrying, which turns a burst into a storm. A lock makes them wait in line instead. The
cost is that one event's registrations are processed one at a time: about 1,450 per second
on a laptop with a durable database (see [Load](#load)), which is several orders of
magnitude more than a student community's busiest launch.

Tests: `test/concurrency.test.ts` sends 300 simultaneous registrations for 50 seats, and
mixes 10 cancellations with 30 new registrations at the same time.

## 2. Submitting twice is safe; so is retrying anything

- The same email registering twice for an event returns the existing registration
  (`duplicate: true`), enforced by a unique index on `(event_id, lower(email))`.
- Every email is written to an **outbox** table in the same transaction as the change it
  reports, with a deduplication key such as `promoted:<registration>:<ticket version>`.
  The email exists if and only if the change committed, and a retried request cannot
  queue it twice.
- A scanner's check-ins carry a `client_scan_id`; syncing the same queue twice replays the
  first answer instead of recording a second scan.

## 3. A place given up is never wasted

Someone cancels, declines the RSVP or misses the RSVP deadline: in the same transaction
their seat goes to the first person on the waitlist (ordered by a global sequence, so
first come is first served), who is emailed their ticket. Raising the capacity promotes
people straight away.

**RSVP.** `rsvp_hours_before` the start (48 hours by default), every confirmed attendee who
has not already confirmed gets a "still coming?" email. If the organiser enabled
`release_unconfirmed`, places of people who were asked and stayed silent are released to the
waitlist `rsvp_deadline_hours` before the start. People promoted after the reminder went out
are never released, because they were never asked.

**Links in emails never change state on GET.** Corporate mail scanners and link previews
fetch every URL in an email. If "release my place" were a plain link, the scanner would
release it. The links open a page; the page's buttons POST.

## 4. A ticket can be checked at the door without a network

Each event gets its own Ed25519 key pair when it is created. The private key is stored
encrypted (AES-256-GCM under a key derived from `APP_SECRET`) and never leaves the server.
A ticket is 34 bytes (event id, registration id, ticket version) plus a 64-byte
signature, base64url-encoded into a 136-character string that fits a small QR code:

```
T1.<event id | registration id | version>.<Ed25519 signature>
```

The scanner app downloads the event's public key and the current version of every
confirmed ticket, then verifies signatures on the device with WebCrypto. A venue's
basement with no signal does not stop the door. Scans queue locally and sync when the
network returns.

Revocation without a network: reissuing a ticket (a screenshot was shared) or cancelling
a registration bumps its ticket version, so old QR codes stop matching the guest list.
A scanner that has been offline since before the change cannot know about it; this is the
one gap, and it closes as soon as the scanner syncs.

**Two doors, one ticket.** If two offline scanners both admitted the same ticket, the
server keeps the earliest scan as the check-in and tells the later one "already admitted
at <the other door>". Every scan, accepted or not, is kept in `scans` for the door log.

## 5. Each credential can do one job

| Credential | Can | Cannot |
|---|---|---|
| Organiser API token (`org_...`) | manage that organiser's events | touch other organisers' events |
| Scanner token (`scn_...`) | download one event's guest list, check people in | read emails, change registrations, see other events |
| Ticket link | view one ticket | anything else |
| RSVP link | confirm or release one place | anything else |

Tokens are 192 random bits; only their SHA-256 is stored, so a database leak does not leak
working tokens. Magic links carry an HMAC tag and are checked in constant time. Revoking a
scanner takes effect on its next request.

Other defences: per-IP rate limiting on registration and RSVP (in memory; one instance),
JSON and form bodies capped at 100 KB, attendee-supplied text defused against spreadsheet
formula injection in CSV exports, a strict content security policy, no framing.

## What the scanner holds

The offline bundle contains attendees' names, so the door can greet people. A scanner
device should be treated as holding the guest list: issue one token per device, and
revoke it after the event.

## Load

`npm run bench:race` starts the real server and a durable PostgreSQL (fsync on) and sends
every person's registration twice, as people do when a page is slow, over real HTTP.

| People | Seats | Concurrent requests | Requests | Throughput | p50 | p99 | Confirmed | Invariants |
|---:|---:|---:|---:|---:|---:|---:|---:|---|
| 2,000 | 500 | 200 | 4,000 | 1,447 / s | 141 ms | 311 ms | 500 | hold |
| 10,000 | 2,000 | 400 | 20,000 | 954 / s | 415 ms | 756 ms | 2,000 | hold |

Apple M1 Max, Node 25, PostgreSQL 16. Latency is mostly time spent queueing for the event's
lock, which is the point. Throughput falls as the waitlist grows because each waitlisted
registration counts the people ahead of it; with 8,000 people waiting that count is no
longer free. Raw results: `results/race.json`, `results/race-large.json`.
