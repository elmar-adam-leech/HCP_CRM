import type { Request, Response } from "express";
import { storage } from "../storage";
import { CredentialService } from "../credential-service";
import type { Contractor } from "@shared/schema";
import { logger } from "./logger";

const log = logger('WebhookAuth');

/**
 * Options for `validateWebhookAuth`.
 *
 * @property keyResolver - Optional override for how to retrieve the stored API
 *   key. When omitted, the function reads `CredentialService.getCredential(id,
 *   'webhook', 'api_key')`. Provide a custom resolver when the webhook stores
 *   its key under a different service/credential name (e.g. Dialpad's key is
 *   stored under `'dialpad' / 'webhook_api_key'`).
 * @property allowQueryKey - When true, the API key may also be supplied as the
 *   `key` query parameter instead of (or in addition to) the `x-api-key`
 *   header. Use this for providers like Dialpad that do not support custom
 *   callback headers and require the key to be embedded in the URL.
 */
export interface WebhookAuthOptions {
  keyResolver?: (contractorId: string) => Promise<string | null>;
  allowQueryKey?: boolean;
}

/**
 * Validates the contractor lookup and API key for all inbound webhook requests.
 *
 * Returns the contractor object if auth passes.
 * Returns null and writes the error response if auth fails — callers should
 * immediately `return` when they receive null:
 *
 *   const auth = await validateWebhookAuth(req, res, contractorId, 'my-prefix');
 *   if (!auth) return;
 *   const { contractor } = auth;
 *
 * To use a custom credential path (e.g. for the Dialpad webhook which stores
 * its key at `('dialpad', 'webhook_api_key')` instead of `('webhook', 'api_key')`),
 * pass a `keyResolver` in the options argument.
 */
export async function validateWebhookAuth(
  req: Request,
  res: Response,
  contractorId: string,
  logPrefix: string,
  options?: WebhookAuthOptions
): Promise<{ contractor: Contractor } | null> {
  const contractor = await storage.getContractor(contractorId);
  if (!contractor) {
    log.error(`[${logPrefix}] Invalid contractor ID: ${contractorId}`);
    res.status(404).json({
      error: "Contractor not found",
      message: "The specified contractor ID does not exist",
    });
    return null;
  }

  const apiKey = (req.headers['x-api-key'] as string | undefined)
    ?? (options?.allowQueryKey ? (req.query['key'] as string | undefined) : undefined);

  if (!apiKey) {
    res.status(401).json({
      error: "Missing API key",
      message: "Include your API key in the 'X-API-Key' header",
    });
    return null;
  }

  let storedApiKey: string | null;
  if (options?.keyResolver) {
    storedApiKey = await options.keyResolver(contractorId);
  } else {
    try {
      storedApiKey = await CredentialService.getCredential(contractorId, 'webhook', 'api_key');
    } catch {
      storedApiKey = null;
    }
  }

  // If no key has been configured yet, reject and instruct the contractor
  // to generate their key via the authenticated settings panel.
  // Never auto-generate a key in response to an unauthenticated request.
  if (!storedApiKey) {
    res.status(401).json({
      error: "Webhook not configured",
      message: "No webhook API key has been set up for this contractor. Log in and generate your key from Settings > Webhooks.",
    });
    return null;
  }

  if (storedApiKey !== apiKey) {
    res.status(401).json({
      error: "Invalid API key",
      message: "The provided API key is not valid for this contractor",
    });
    return null;
  }

  return { contractor };
}

/**
 * Normalises the request body from external webhook senders.
 *
 * Different senders wrap the payload in different ways:
 *   - Some send `{ data: { ... } }` (e.g. Zapier, Make)
 *   - Some send `[ { ... } ]` (array of a single object)
 *   - Most send the object directly
 *
 * This helper always returns a plain object regardless of the wrapper format.
 */
export function parseWebhookPayload(req: Request): Record<string, unknown> {
  let data: unknown = req.body.data ?? req.body;
  if (Array.isArray(data) && data.length > 0) {
    data = data[0];
  }
  return (data as Record<string, unknown>) ?? {};
}
