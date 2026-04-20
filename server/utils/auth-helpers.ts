import type { Response } from 'express';
import type { AuthenticatedRequest, JWTPayload } from '../auth-service';

/**
 * Typed accessor for the authenticated user on a request.
 *
 * All authenticated routes are protected by the `requireAuth` middleware which
 * sets `req.user` before the handler runs. However, TypeScript cannot prove
 * this statically, so every handler would need a non-null assertion (`req.user!`)
 * or an explicit null-check boilerplate.
 *
 * This helper centralizes that check so route handlers stay concise:
 *
 *   ```ts
 *   const user = getAuthUser(req, res);
 *   if (!user) return; // 401 already sent by helper
 *   storage.getContacts(user.contractorId);
 *   ```
 *
 * If `req.user` is somehow absent (i.e. the route was accidentally left
 * unprotected), the helper sends a 401 and returns null so the handler can
 * bail out gracefully rather than throw at runtime.
 */
export function getAuthUser(req: AuthenticatedRequest, res: Response): JWTPayload | null {
  if (!req.user) {
    res.status(401).json({ message: 'Unauthorized' });
    return null;
  }
  return req.user;
}
