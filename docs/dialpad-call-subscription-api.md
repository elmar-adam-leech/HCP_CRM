# Dialpad Call Event Subscription API Reference

Source: https://developers.dialpad.com/reference/webhook_call_event_subscriptioncreate
Source: https://developers.dialpad.com/docs/call-events

## Creating a Call Event Subscription

**Endpoint:** `POST https://dialpad.com/api/v2/subscriptions/call`

### Request Parameters

| Parameter | Type | Description |
|---|---|---|
| `call_states` | array of strings \| null | List of call states to subscribe to (e.g. `["hangup", "missed", "voicemail"]`). Use `["all"]` for all states. |
| `enabled` | boolean \| null | Whether the subscription is enabled. Defaults to `true`. |
| `endpoint_id` | int64 \| null | The webhook's ID (from creating a webhook via `POST /webhooks`). |
| `group_calls_only` | boolean \| null | Subscribe to group calls only. |
| `target_id` | int64 \| null | **The ID of the specific target** for which events should be sent. |
| `target_type` | string \| null (enum) | **The target type.** Values: `callcenter`, `callrouter`, `channel`, `coachinggroup`, `coachingteam`, `department`, `office`, `room`, `staffgroup`, `unknown`, `user` |

### Important Notes

- **`target_id` + `target_type` are effectively required** — without them, the subscription is created silently but Dialpad has no target to monitor, so no call events are ever sent.
- Use `target_type: "office"` with the office's ID to get **all calls company-wide** for that office.
- Use `target_type: "user"` with a user's ID to subscribe to a specific user's calls.
- The webhook endpoint field is called `endpoint_id` (not `webhook_id` which is used by SMS subscriptions).

### 200 Response

```json
{
  "call_states": ["all"],
  "enabled": true,
  "group_calls_only": false,
  "id": 12345,
  "target_id": 67890,
  "target_type": "office",
  "webhook": {
    "hook_url": "https://example.com/api/webhooks/dialpad/calls/tenant123",
    "id": 11111
  }
}
```

## Listing Offices

**Endpoint:** `GET https://dialpad.com/api/v2/offices`

Returns a paginated list of offices. Each office has:
- `id` / `office_id`: The office ID (use as `target_id`)
- `name`: Office name
- `state`: `active`, `cancelled`, `deleted`, `pending`, `suspended`
- `is_primary_office`: Boolean
- `phone_numbers`: Array of phone numbers assigned to the office

## Call Event Payload Fields

Key fields in the webhook payload:

| Field | Type | Description |
|---|---|---|
| `call_id` | int | Unique call identifier |
| `state` | string | Call state (see states below) |
| `direction` | string | `inbound` or `outbound` |
| `duration` | int | Duration in milliseconds |
| `total_duration` | int | Total duration including ring time (ms) |
| `external_number` | string (E.164) | The contact's phone number |
| `internal_number` | string (E.164) | The internal Dialpad number |
| `contact` | object | External party info: `{ phone, type, id, name, email }` |
| `target` | object | Internal party info: `{ phone, type, id, name, email, office_id }` |
| `recording_details` | list<object> | Recording details: `{ id, url, duration, start_time, recording_type }` |
| `voicemail_link` | string | URL to voicemail recording |
| `was_recorded` | bool | Whether the call was recorded |
| `is_transferred` | bool | Whether the call was transferred |
| `entry_point_target` | object | Where the call initially dialed (inbound) |
| `group_id` | string | Department/mainline/call queue ID |
| `date_started` | int (unix ms) | When the call started |
| `date_connected` | int (unix ms) | When both parties connected |
| `date_ended` | int (unix ms) | When the call ended |
| `date_rang` | int (unix ms) | When ringing was detected |

### Call States

| State | Description |
|---|---|
| `calling` | Outbound call started |
| `ringing` | Inbound call ringing |
| `connected` | Both parties answered |
| `hangup` | Call ended |
| `missed` | Call was missed |
| `voicemail` | Voicemail recording started |
| `voicemail_uploaded` | Voicemail recording completed |
| `recording` | Call recording finished processing |
| `transcription` | Voicemail transcribed |
| `all` | Include all call states |

### Important Terminology

- **contact**: The external party (customer). Always corresponds to `external_number`.
- **target**: The internal party (Dialpad user/department/office). Corresponds to `internal_number`.
- **call**: Better thought of as a "call leg" — one component of a call flow.

## Deleting a Call Subscription

**Endpoint:** `DELETE https://dialpad.com/api/v2/subscriptions/call/{subscription_id}`

## Listing Call Subscriptions

**Endpoint:** `GET https://dialpad.com/api/v2/subscriptions/call`
