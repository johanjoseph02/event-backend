# API

JSON in and out. Errors are `{"error": {"code", "message", "details"}}` with a meaningful
HTTP status (401, 404, 409 for state conflicts such as `full` or `closed`, 422 for
validation, 429 for rate limits).

## Attendees (no authentication)

| Method | Path | |
|---|---|---|
| `GET` | `/api/public/events/:slug` | public event details, form and seats left |
| `POST` | `/api/public/events/:slug/registrations` | `{name, email, answers}` → `201 {id, status, waitlist_position, ticket_url}`; `200` with `duplicate: true` for a repeat |
| `GET` | `/api/public/tickets/:ticketLink` | status, waitlist position, signed ticket and its QR as a data URL |
| `POST` | `/api/public/rsvp/:rsvpLink` | `{answer: "yes" \| "no"}`; "no" releases the place to the waitlist |

Pages: `/e/:slug` (registration form), `/t/:ticketLink` (ticket), `/r/:rsvpLink`
(confirm or release), `/scanner` (door scanner app). The registration and RSVP endpoints
also accept HTML form posts and redirect back to the page.

## Organisers (`Authorization: Bearer org_...`)

| Method | Path | |
|---|---|---|
| `GET` / `POST` | `/api/events` | list, create (draft) |
| `GET` / `PATCH` | `/api/events/:id` | read, update (raising capacity promotes from the waitlist) |
| `POST` | `/api/events/:id/publish` | open registration |
| `POST` | `/api/events/:id/cancel` | cancel the event; everyone is emailed |
| `GET` | `/api/events/:id/stats` | confirmed, waitlisted, cancelled, released, RSVPs, checked in, show rate, scan results |
| `GET` | `/api/events/:id/registrations` | `?status=` to filter, `?format=csv` to export with form answers |
| `POST` | `/api/events/:id/registrations/:rid/cancel` | cancel on someone's behalf |
| `POST` | `/api/events/:id/registrations/:rid/reissue` | new QR code; the old one stops working |
| `GET` / `POST` | `/api/events/:id/scanners` | list, create `{label}` → `{token}` (shown once) |
| `DELETE` | `/api/events/:id/scanners/:label` | revoke |
| `GET` | `/api/events/:id/audit` | the last 500 changes, with who made them |

Creating an event:

```json
{
  "slug": "graphql-workshop", "title": "Hands-on GraphQL Workshop",
  "starts_at": "2030-03-10T12:30:00Z", "ends_at": "2030-03-10T15:30:00Z",
  "venue": "Tech Park, Room 401", "capacity": 60, "waitlist": true,
  "rsvp_hours_before": 48, "release_unconfirmed": true, "rsvp_deadline_hours": 12,
  "form": [
    {"id": "year", "label": "Year of study", "type": "select", "options": ["1st", "2nd", "3rd", "4th"], "required": true},
    {"id": "coc", "label": "I agree to the code of conduct", "type": "checkbox", "required": true}
  ]
}
```

## Door scanners (`Authorization: Bearer scn_...`)

| Method | Path | |
|---|---|---|
| `GET` | `/api/scanner/bundle` | event, public key, current version of every confirmed ticket |
| `POST` | `/api/scanner/checkins` | `{token, client_scan_id?, scanned_at?}` → `{result, name, checked_in_at, first_scanner}` |
| `POST` | `/api/scanner/checkins/batch` | up to 1,000 queued scans, applied in `scanned_at` order |

`result` is one of `ok`, `already`, `invalid`, `wrong_event`, `not_confirmed`, `revoked`.
