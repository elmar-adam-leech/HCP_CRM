---
name: Email review ownership
description: Why saved parsing failures remain reviewable but are not automatically rebound after inbox replacement
---

Keep unresolved email inquiries available for staff review after disconnecting their inbox. Do not silently replay those inquiries using a replacement inbox.

**Why:** Disconnecting integration access should not erase a potential customer inquiry. But a replacement inbox can have different sender rules, spam overrides and extraction settings, so automatic reassignment could process old inquiries under unrelated rules.

**How to apply:** Preserve tenant and original-inbox ownership for retries. A future reconnect/reassignment feature needs explicit ownership verification and deliberate rule selection, not just a matching email address.