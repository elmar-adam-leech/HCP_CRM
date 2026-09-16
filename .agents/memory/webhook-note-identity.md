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