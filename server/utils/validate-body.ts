import { z } from "zod";
import type { Request, Response } from "express";

/**
 * Parse a query-string parameter as an integer.
 *
 * Returns `fallback` when the value is absent or undefined.
 * Returns `fallback` (and optionally caps at `max`) for a valid integer.
 * Returns `null` for any non-numeric string — callers should reject the
 * request with a 400 in that case.
 *
 * @param value   The raw query-string value (may be undefined).
 * @param fallback Default to use when value is absent.
 * @param max      Optional upper bound. Values above this are clamped to `max`.
 */
export function parseIntParam(
  value: string | undefined,
  fallback: number,
  max?: number
): number | null {
  if (value === undefined || value === "") return fallback;
  const parsed = parseInt(value, 10);
  if (isNaN(parsed)) return null;
  return max !== undefined ? Math.min(parsed, max) : parsed;
}

/**
 * Validate `req.body` against `schema`.
 *
 * Returns the typed payload on success; writes a 400 JSON response and returns
 * null on failure. Callers must immediately `return` when they receive null.
 */
export function parseBody<T>(
  schema: z.ZodType<T, z.ZodTypeDef, any>,
  req: Request,
  res: Response
): T | null {
  const result = schema.safeParse(req.body);
  if (!result.success) {
    res.status(400).json({ message: "Invalid request data", errors: result.error.errors });
    return null;
  }
  return result.data;
}

/**
 * Validate an already-extracted `data` object against `schema`.
 *
 * Useful in webhook handlers where the raw body has been normalised by
 * `parseWebhookPayload` before validation (e.g. unwrapping `{ data: ... }` or
 * array wrappers from Zapier/Make integrations).
 *
 * Returns the typed payload on success; writes a 400 JSON response and returns
 * null on failure.
 */
export function parseData<T>(
  schema: z.ZodType<T, z.ZodTypeDef, any>,
  data: unknown,
  res: Response,
  errorMessage = "Missing or invalid required fields"
): T | null {
  const result = schema.safeParse(data);
  if (!result.success) {
    res.status(400).json({
      error: errorMessage,
      message: result.error.issues[0]?.message ?? errorMessage,
      errors: result.error.errors,
    });
    return null;
  }
  return result.data;
}
