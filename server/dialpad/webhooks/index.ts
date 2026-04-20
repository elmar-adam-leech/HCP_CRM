/**
 * Dialpad webhooks module barrel.
 *
 * The implementation is split across four sibling files by concern:
 *   - lifecycle.ts          : webhook CRUD (create/delete/list)
 *   - sms-subscriptions.ts  : SMS subscription CRUD
 *   - call-subscriptions.ts : call subscription CRUD + reregister
 *   - orchestrator.ts       : combined "register everything" flow
 *
 * External callers should keep importing from `server/dialpad/webhooks` —
 * this barrel preserves the original public surface.
 */

export { createWebhook, deleteWebhook, listWebhooks } from './lifecycle';
export { createSmsSubscription, listSmsSubscriptions, deleteSmsSubscription } from './sms-subscriptions';
export { createCallSubscription, reregisterCallSubscriptions, listCallSubscriptions } from './call-subscriptions';
export { createWebhookWithSubscription } from './orchestrator';
