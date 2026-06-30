---
name: Twilio inbound SMS routing via Messaging Service
description: Why inbound Twilio texts get dropped and the authoritative fix
---

# Twilio inbound SMS routing

When a contractor's Twilio number belongs to a **Messaging Service** (common for
A2P 10DLC compliant sending), Twilio **ignores the number-level SmsUrl** and
routes inbound SMS via the Service's own inbound setting.

**Rule:** to make inbound texts reach the CRM, set the Messaging Service's
`InboundRequestUrl` DIRECTLY to our tenant SMS webhook (`InboundMethod=POST`,
`UseInboundWebhookOnNumber=false`). Do NOT rely on `UseInboundWebhookOnNumber=true`
deferral to the number-level webhook.

**Why:** the deferral approach did not take effect on some accounts and inbound
texts were silently dropped (task #849; earlier #840 used the deferral). Setting
InboundRequestUrl is authoritative and account-independent.

**How to apply:** `server/twilio/webhook-config.ts` —
`configureMessagingServicesInbound` sets it; keep `InboundRequestUrl` EXACTLY equal
to the number-level `SmsUrl` so `verifyTwilioRequest` signature checks still pass
(Twilio signs the exact URL it POSTs to). Never touch outbound/A2P config. Outbound
SMS working tells you nothing about inbound — they use different config paths.
`inspectTwilioInboundRouting()` is the read-only diagnostic.
