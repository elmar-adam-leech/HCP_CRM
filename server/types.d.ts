import type { JWTPayload } from './auth-service';

declare global {
  namespace Express {
    interface Request {
      user?: JWTPayload;
    }
  }
}
