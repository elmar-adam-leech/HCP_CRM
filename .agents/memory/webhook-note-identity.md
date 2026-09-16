---
name: Webhook note identity
description: Why note retry suppression requires an explicit submission identity
---

Do not deduplicate contact notes using note text or raw payload hashes alone.
Do not backfill historical receipts by guessing which inquiry produced a note.

**Why:** Separate genuine inquiries can have identical bodies and notes. There
is no reliable way to distinguish them from retries without a stable submission
identifier. Historical notes lack that evidence.

**How to apply:** Keep unidentified submissions additive. Require a unique,
stable provider submission identifier before suppressing repeated note delivery;
keep this policy separate from lead/contact matching rules.

Initial contact creation and note suppression require different identity scopes:
creation must ignore note content, while note receipts include it.

**Why:** A provider can resend the same identified inquiry with revised notes.
That must reuse the contact without suppressing the revised note. Database
uniqueness was preferred over holding a pooled connection lock across ingestion,
which also performs external integration work.

**How to apply:** Preserve this distinction when changing retry handling. Do not
interpret contact convergence as a guarantee that lead creation or downstream
workflow side effects execute exactly once.