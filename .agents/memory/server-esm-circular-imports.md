---
name: Server ESM circular imports
description: Production startup constraint for the esbuild-bundled ESM server.
---

Avoid static bidirectional imports between server service modules. If two services need each other, keep one direction static and load the reverse dependency lazily inside the function that uses it.

**Why:** Esbuild can translate a static cycle into async ESM module initialization that never resolves. Node then exits with status 13 before the server entry reaches its own startup logging or opens the health-check port, while development mode may still run normally.

**How to apply:** When production repeatedly exits 13 before the first startup step, compare recent server imports for a new A → B → A cycle. Confirm the fix by rebuilding and starting the production bundle on a free port, not only by running the development workflow.