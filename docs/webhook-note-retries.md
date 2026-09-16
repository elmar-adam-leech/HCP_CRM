# Retried webhook notes

When posting to `POST /api/webhooks/:contractorId/leads`, send an optional
`submissionId` string that is stable across retries and unique for each inquiry
within that tenant and source:

```json
{
  "name": "Example Customer",
  "email": "customer@example.test",
  "source": "Website form",
  "submissionId": "form-submission-123",
  "notes": "Please call after 5pm"
}
```

- Re-delivering the same submission with the same notes does not append those
  notes again to the matched contact.
- A different submission ID appends its notes, even if the text is identical.
- Changed notes under the same submission ID are appended; earlier notes remain.
- Keep `source` stable across retries. Receipts are scoped to the tenant, source,
  submission ID, and exact note text.
- Without a submission ID, notes retain their previous append behavior. Identical
  payloads alone cannot distinguish retries from genuinely separate inquiries.
- Internal email ingestion can use its existing activity external ID instead.

This does not change contact matching, the recent-lead deduplication window, or
whether a new lead is created. It does not remove existing repeated notes:
historical notes have no reliable submission identity to reconstruct.

Receipt recording is atomic for a matched contact, including concurrent retries.
The existing initial contact match/create behavior is unchanged.