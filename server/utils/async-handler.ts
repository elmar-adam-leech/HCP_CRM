import type { Request, Response, NextFunction } from "express";
import type { AuthenticatedRequest, AuthedRequest } from "../auth-service";

type AnyRequest = Request | AuthenticatedRequest | AuthedRequest;

/**
 * Wraps an async route handler and forwards any thrown errors to `next(err)`.
 *
 * Default type parameter is `AuthedRequest` — use this for all handlers that sit
 * behind `requireAuth` middleware, which is the vast majority of API routes.
 * For genuinely public (unauthenticated) routes, pass `Request` explicitly:
 *   `asyncHandler<Request>(async (req, res) => { ... })`
 */
export function asyncHandler<T extends AnyRequest = AuthedRequest>(
  fn: (req: T, res: Response, next: NextFunction) => Promise<void>
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    fn(req as T, res, next).catch(next);
  };
}
