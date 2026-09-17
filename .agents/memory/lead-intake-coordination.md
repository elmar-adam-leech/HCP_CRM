---
name: Lead intake coordination
description: Why lead identity coordination differs from communication matching and submission receipts
---

Keep two-field person matching scoped to trusted lead intake, separate from communication matching and public-booking authority.

**Why:** A person match is not proof of booking ownership. A provider retry identifies an inquiry, not merely a person, and must remain distinguishable from a later legitimate inquiry.

**How to apply:** Preserve both identity scopes when extending intake channels. Do not infer a person's name from an email local-part or use notification senders as independent evidence.

Coordinate persistence across all arrivals for a contractor, including sparse submissions with provider IDs; do not borrow coordination sessions from the pool required for the protected writes.

**Why:** Pair-only locks miss different field pairs resolving to the same existing person. Lock waiters occupying the application pool can prevent the lock holder from obtaining a connection to finish.

**How to apply:** Keep external API calls outside coordination, bound coordination connections separately, and discard a session if advisory unlock fails.