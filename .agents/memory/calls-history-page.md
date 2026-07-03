---
name: Calls history page
description: How the dedicated Calls section lists and links call activities (backend + frontend contract)
---

# Calls history

The Calls section is a projection over the `activities` table where `type='call'`,
NOT a separate table. There is no dedicated "calls" table — calls are activities.

- **Listing**: `GET /api/calls` → `{ calls, nextCursor }`. Backed by
  `getCallActivities(contractorId, {direction, assignment, limit, cursor})`.
  Includes UNASSIGNED calls (`contactId IS NULL`) — these are real inbound calls
  that matched no contact (Twilio creates them with from/to in metadata; Dialpad
  unmatched calls are NOT persisted, so they never appear).
- **otherPartyNumber** is derived server-side from `metadata` (jsonb): outbound →
  `to_number`, inbound → `from_number`, then fallbacks
  `customerNumber`/`contactPhone`/`external_number`, then linked contact's first phone.
- **Pagination** is keyset `(createdAt, id)` DESC via `encodeActivityCursor`/`decodeCursor`.
- **Linking**: `POST /api/calls/:id/link {contactId}` is REGULAR-USER allowed
  (unlike `PUT /api/activities/:id` which is manager/admin-only) because it is the
  last step of create-contact-from-call. Only links calls that are currently
  unassigned (409 otherwise); marks contact+lead contacted; broadcasts.
- **Create-from-call flow** (frontend, sequential, reuses existing endpoints for
  their side effects): `POST /api/contacts` (handle 409 → `duplicateContactId`,
  link to existing, skip stage) → optional `POST /api/estimates` or `POST /api/jobs`
  for chosen stage → `POST /api/calls/:id/link`. Each step surfaces its own error.
- **Recording playback**: reuse the resolveCallRecording logic (Twilio SID `RE…` →
  `/api/twilio/recordings/:id`; Dialpad → `/api/dialpad/recordings/:id`; never play
  a dialpad.com/r/ share URL inline). Do NOT change ingestion or the recording proxy.
