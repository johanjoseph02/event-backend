-- Organisers authenticate with long random API tokens; only a SHA-256 of each is stored.
CREATE TABLE organizers (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email         text NOT NULL,
    name          text NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX organizers_email ON organizers (lower(email));

CREATE TABLE api_tokens (
    token_hash    bytea PRIMARY KEY,
    organizer_id  uuid NOT NULL REFERENCES organizers (id) ON DELETE CASCADE,
    label         text NOT NULL DEFAULT '',
    created_at    timestamptz NOT NULL DEFAULT now(),
    last_used_at  timestamptz
);

CREATE TABLE events (
    id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organizer_id            uuid NOT NULL REFERENCES organizers (id),
    slug                    text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
    title                   text NOT NULL,
    description             text NOT NULL DEFAULT '',
    venue                   text NOT NULL DEFAULT '',
    starts_at               timestamptz NOT NULL,
    ends_at                 timestamptz NOT NULL,
    capacity                integer NOT NULL CHECK (capacity > 0),
    waitlist                boolean NOT NULL DEFAULT true,
    registration_opens_at   timestamptz,
    registration_closes_at  timestamptz,
    rsvp_hours_before       integer NOT NULL DEFAULT 48 CHECK (rsvp_hours_before >= 0),
    release_unconfirmed     boolean NOT NULL DEFAULT false,
    rsvp_deadline_hours     integer NOT NULL DEFAULT 12 CHECK (rsvp_deadline_hours >= 0),
    form                    jsonb NOT NULL DEFAULT '[]',
    status                  text NOT NULL DEFAULT 'draft'
                            CHECK (status IN ('draft', 'published', 'cancelled')),
    confirmed_count         integer NOT NULL DEFAULT 0 CHECK (confirmed_count >= 0),
    -- Ed25519 key pair for signing tickets. The private key is encrypted with APP_SECRET.
    ticket_public_key       bytea NOT NULL,
    ticket_private_key_enc  bytea NOT NULL,
    rsvp_sent_at            timestamptz,
    rsvp_released_at        timestamptz,
    created_at              timestamptz NOT NULL DEFAULT now(),
    updated_at              timestamptz NOT NULL DEFAULT now(),
    CHECK (ends_at > starts_at),
    CHECK (confirmed_count <= capacity)
);

CREATE SEQUENCE waitlist_order;

CREATE TABLE registrations (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id          uuid NOT NULL REFERENCES events (id) ON DELETE CASCADE,
    email             text NOT NULL,
    name              text NOT NULL,
    answers           jsonb NOT NULL DEFAULT '{}',
    status            text NOT NULL
                      CHECK (status IN ('confirmed', 'waitlisted', 'cancelled', 'released')),
    waitlist_position bigint,
    rsvp              text NOT NULL DEFAULT 'pending' CHECK (rsvp IN ('pending', 'yes', 'no')),
    rsvp_requested_at timestamptz,
    ticket_version    integer NOT NULL DEFAULT 1,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),
    confirmed_at      timestamptz,
    cancelled_at      timestamptz
);
CREATE UNIQUE INDEX registrations_one_per_email ON registrations (event_id, lower(email));
CREATE INDEX registrations_waitlist ON registrations (event_id, waitlist_position)
    WHERE status = 'waitlisted';

-- Per-event door scanners get their own tokens: they can check people in and nothing else.
CREATE TABLE scanners (
    token_hash    bytea PRIMARY KEY,
    event_id      uuid NOT NULL REFERENCES events (id) ON DELETE CASCADE,
    label         text NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    revoked_at    timestamptz,
    UNIQUE (event_id, label)
);

CREATE TABLE checkins (
    registration_id  uuid PRIMARY KEY REFERENCES registrations (id) ON DELETE CASCADE,
    event_id         uuid NOT NULL REFERENCES events (id) ON DELETE CASCADE,
    scanned_at       timestamptz NOT NULL,
    received_at      timestamptz NOT NULL DEFAULT now(),
    scanner_label    text NOT NULL,
    client_scan_id   text
);

-- Every scan, accepted or not, for the door log and for spotting a shared screenshot.
CREATE TABLE scans (
    id               bigserial PRIMARY KEY,
    event_id         uuid NOT NULL REFERENCES events (id) ON DELETE CASCADE,
    registration_id  uuid,
    result           text NOT NULL,
    scanner_label    text NOT NULL,
    client_scan_id   text,
    scanned_at       timestamptz NOT NULL,
    received_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX scans_client_id ON scans (event_id, scanner_label, client_scan_id)
    WHERE client_scan_id IS NOT NULL;

-- Transactional outbox: written in the same transaction as the change it reports,
-- delivered by the worker, so an email is sent if and only if the change committed.
CREATE TABLE outbox (
    id               bigserial PRIMARY KEY,
    dedupe_key       text NOT NULL UNIQUE,
    kind             text NOT NULL,
    to_email         text NOT NULL,
    payload          jsonb NOT NULL,
    status           text NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'sent', 'failed')),
    attempts         integer NOT NULL DEFAULT 0,
    next_attempt_at  timestamptz NOT NULL DEFAULT now(),
    last_error       text,
    created_at       timestamptz NOT NULL DEFAULT now(),
    sent_at          timestamptz
);
CREATE INDEX outbox_due ON outbox (next_attempt_at) WHERE status = 'pending';

CREATE TABLE audit_log (
    id               bigserial PRIMARY KEY,
    at               timestamptz NOT NULL DEFAULT now(),
    actor            text NOT NULL,
    action           text NOT NULL,
    event_id         uuid,
    registration_id  uuid,
    data             jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX audit_event ON audit_log (event_id, at);
