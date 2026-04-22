import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import { getUserContractorCached, getUserCached } from './services/cache';
import { db } from './db';
import { revokedTokens } from '@shared/schema';
import { eq, lt } from 'drizzle-orm';
import { logger } from './utils/logger';

const log = logger('AuthService');

// ---------------------------------------------------------------------------
// JTI revocation cache — 15-minute TTL, bounded to 10,000 entries (FIFO eviction)
// ---------------------------------------------------------------------------
const JTI_CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes
const JTI_CACHE_MAX_SIZE = 10_000;

interface JtiCacheEntry {
  isRevoked: boolean;
  cachedAt: number; // Date.now() at insertion time
}

class JtiCache {
  private cache = new Map<string, JtiCacheEntry>();

  get(jti: string): boolean | null {
    const entry = this.cache.get(jti);
    if (!entry) return null;
    if (Date.now() - entry.cachedAt > JTI_CACHE_TTL_MS) {
      this.cache.delete(jti);
      return null;
    }
    return entry.isRevoked;
  }

  set(jti: string, isRevoked: boolean): void {
    if (!this.cache.has(jti) && this.cache.size >= JTI_CACHE_MAX_SIZE) {
      // FIFO eviction: delete the oldest (first inserted) key only when
      // adding a brand-new entry (not when updating an existing one).
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) this.cache.delete(firstKey);
    }
    this.cache.set(jti, { isRevoked, cachedAt: Date.now() });
  }
}

const jtiCache = new JtiCache();

// JWT_SECRET must always be set to a non-default value — in every environment.
// Relying on NODE_ENV to gate this check is unsafe because misconfigured
// deployments commonly leave NODE_ENV=development while serving real traffic.
//
// To generate a strong secret:
//   node -e "log.info(require('crypto').randomBytes(64).toString('hex'))"
//
// Set it as the JWT_SECRET environment variable before starting the server.
const KNOWN_WEAK_SECRET = 'your-default-secret-key-replace-in-production';
const JWT_SECRET = (() => {
  const secret = process.env.JWT_SECRET;

  if (!secret || secret === KNOWN_WEAK_SECRET) {
    log.error('CRITICAL SECURITY ERROR: JWT_SECRET is missing or still set to the default placeholder.');
    log.error('Set a strong random value in the JWT_SECRET environment variable before starting the server.');
    log.error('Generate one with: node -e "log.info(require(\'crypto\').randomBytes(64).toString(\'hex\'))"');
    process.exit(1);
  }

  return secret;
})();

const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d'; // 7 days for sliding expiration

export interface JWTPayload {
  jti: string;       // Unique JWT ID — used for per-token revocation
  userId: string;
  username: string;
  name: string;
  email: string;
  role: string;
  contractorId: string;
  canManageIntegrations: boolean;
  allowedIntegrations?: string[] | null; // null = all integrations; array = specific ones
  tokenVersion: number; // Snapshot of users.tokenVersion at issue time
  iat?: number;
  exp?: number;
}

export interface AuthenticatedRequest extends Request {
  user?: JWTPayload;
  contractorId?: string; // Set by requireContractorAccess middleware for debugging
}

/**
 * Use `AuthedRequest` for route handlers that sit behind `requireAuth` middleware.
 * The middleware guarantees `req.user` is populated, so this type makes it non-optional,
 * eliminating the need for `req.user!` non-null assertions throughout route handlers.
 *
 * Use `AuthenticatedRequest` only for middleware that may run before `requireAuth`
 * (e.g. the auth middleware itself, optional-auth middleware, or webhook handlers).
 */
export type AuthedRequest = AuthenticatedRequest & { user: JWTPayload };

export class AuthService {
  
  /**
   * Generate a JWT token for a user
   */
  static generateToken(user: {
    id: string;
    username: string;
    name: string;
    email: string;
    role: string;
    contractorId: string;
    canManageIntegrations?: boolean;
    allowedIntegrations?: string[] | null;
    tokenVersion: number;
  }): string {
    const payload: Omit<JWTPayload, 'iat' | 'exp'> = {
      jti: crypto.randomUUID(), // Unique per-token ID for revocation tracking
      userId: user.id,
      username: user.username,
      name: user.name,
      email: user.email,
      role: user.role,
      contractorId: user.contractorId,
      canManageIntegrations: user.canManageIntegrations ?? false,
      allowedIntegrations: user.allowedIntegrations ?? null,
      tokenVersion: user.tokenVersion,
    };

    return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN } as jwt.SignOptions);
  }

  /**
   * Verify and decode a JWT token
   */
  static verifyToken(token: string): JWTPayload | null {
    try {
      const decoded = jwt.verify(token, JWT_SECRET) as JWTPayload;
      return decoded;
    } catch {
      // Expired or malformed tokens are expected during normal operation
      // (e.g. user returns after cookie expired). No structured log needed.
      return null;
    }
  }

  /**
   * Extract token from Authorization header.
   * Supports both "Bearer <token>" and bare "<token>" formats.
   *
   * Security note: extracting the token is only the first step. Always follow
   * this with `verifyToken` + a contractorId check to prevent cross-tenant
   * data leaks. A valid JWT signature alone does NOT prove the user has access
   * to the requested contractor's data — `requireContractorAccess` or an
   * explicit contractorId match must also be enforced at every resource boundary.
   */
  static extractTokenFromHeader(authHeader: string | undefined): string | null {
    if (!authHeader) return null;

    if (authHeader.startsWith('Bearer ')) {
      return authHeader.substring(7);
    }

    return authHeader;
  }

  /**
   * Extract token from cookies or Authorization header (Express Request).
   * Prefers the httpOnly `auth_token` cookie over the Authorization header
   * because cookies are not accessible to JavaScript and are therefore safer
   * against XSS-based token theft.
   *
   * For WebSocket upgrade requests (IncomingMessage, not Express Request), use
   * the standalone `extractToken` function in websocket.ts instead, which
   * manually parses the Cookie header and delegates the header path here.
   */
  static extractToken(req: Request): string | null {
    // Try cookie first (more secure for web apps)
    const cookieToken = req.cookies?.auth_token;
    if (cookieToken) return cookieToken;

    // Fall back to Authorization header (for API clients)
    const headerToken = this.extractTokenFromHeader(req.headers.authorization);
    if (headerToken) return headerToken;

    return null;
  }

  /**
   * Revoke a token by inserting its jti into the revoked_tokens table.
   */
  static async revokeToken(decoded: JWTPayload): Promise<void> {
    if (!decoded.jti || !decoded.exp) return;
    await db.insert(revokedTokens).values({
      jti: decoded.jti,
      userId: decoded.userId,
      expiresAt: new Date(decoded.exp * 1000),
    }).onConflictDoNothing();
    // Immediately mark as revoked in the in-memory cache so the current
    // session is blocked right away without waiting for the TTL to expire.
    jtiCache.set(decoded.jti, true);
  }

  /**
   * Delete expired rows from revoked_tokens. Called hourly from server/index.ts.
   *
   * Note: The tokenVersion field on the users table handles "sign out all devices"
   * invalidation without requiring a revoked_tokens row per session — only explicitly
   * revoked JTIs (e.g. from explicit logout) need a DB row. This cleanup only removes
   * expired rows; tokenVersion-based invalidations are checked at auth time in-memory.
   */
  static async cleanupExpiredRevokedTokens(): Promise<void> {
    try {
      const result = await db.delete(revokedTokens)
        .where(lt(revokedTokens.expiresAt, new Date()))
        .returning({ jti: revokedTokens.jti });
      if (result.length > 0) {
        log.info(`Pruned ${result.length} expired revoked_tokens row(s)`);
      }
    } catch (err) {
      log.error('Failed to clean up expired revoked tokens', err);
    }
  }

  /**
   * Determines whether the current request should receive a refreshed JWT cookie.
   *
   * Sliding-window expiration strategy:
   *   - All tokens are issued with a `JWT_EXPIRES_IN` lifetime (default 7 days).
   *   - On every authenticated request, `requireAuth` checks whether the token's age
   *     has surpassed 50% of its total lifetime (≥ 3.5 days for the default 7-day config).
   *   - If so, a brand-new 7-day token is issued and written back to the `auth_token`
   *     cookie in the response.
   *   - This keeps active users permanently logged in without requiring a full re-login,
   *     while inactive users whose last activity was >7 days ago are naturally logged out.
   *
   * @param decoded - The verified JWT payload (must contain `iat`).
   * @returns `true` if the token should be silently refreshed this request.
   */
  static shouldRefreshToken(decoded: JWTPayload): boolean {
    if (!decoded.iat) return false;
    
    const tokenAge = Date.now() / 1000 - decoded.iat; // Age in seconds
    // 50% threshold chosen to balance UX against security. At 50% of a 7-day token
    // (≥3.5 days), active users always have a fresh token without needing to re-login,
    // while inactive users whose last request was >7 days ago are naturally logged out.
    // Lowering this (e.g. 25%) increases token refresh DB writes; raising it (e.g. 75%)
    // reduces write load but shortens the effective "active session" window.
    const halfLifeSeconds = (7 * 24 * 60 * 60) / 2; // 3.5 days in seconds
    
    return tokenAge > halfLifeSeconds;
  }

  /**
   * Authentication middleware with automatic token refresh (sliding expiration)
   */
  static requireAuth = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const token = AuthService.extractToken(req);
      
      if (!token) {
        res.status(401).json({ message: 'No authentication token provided' });
        return;
      }

      const decoded = AuthService.verifyToken(token);
      if (!decoded) {
        res.status(401).json({ message: 'Invalid or expired token' });
        return;
      }

      // Check if token has been explicitly revoked (e.g., via logout).
      // The in-memory JTI cache (15-min TTL, max 10k entries) is checked first to
      // avoid a DB hit on every request. On a cache miss, the DB is queried and the
      // result is stored in the cache. When a token is actively revoked via
      // revokeToken(), the cache is written immediately so revocation is instant.
      if (decoded.jti) {
        const cached = jtiCache.get(decoded.jti);
        let isRevoked: boolean;
        if (cached !== null) {
          isRevoked = cached;
        } else {
          const rows = await db.select({ jti: revokedTokens.jti })
            .from(revokedTokens)
            .where(eq(revokedTokens.jti, decoded.jti))
            .limit(1);
          isRevoked = rows.length > 0;
          jtiCache.set(decoded.jti, isRevoked);
        }
        if (isRevoked) {
          res.status(401).json({ message: 'Session has been revoked' });
          return;
        }
      }

      // Verify user still exists (uses cache to avoid a raw DB hit per request)
      const user = await getUserCached(decoded.userId);
      if (!user) {
        res.status(401).json({ message: 'User no longer exists' });
        return;
      }

      // Check tokenVersion — protects against stolen devices via "sign out all"
      if (decoded.tokenVersion !== user.tokenVersion) {
        res.status(401).json({ message: 'Session invalidated — please log in again' });
        return;
      }

      // Verify user has access to the contractor in the token (supports multi-company access)
      // Use cached version to reduce database load
      const userContractor = await getUserContractorCached(decoded.userId, decoded.contractorId);
      if (!userContractor) {
        res.status(401).json({ message: 'Access denied to this company' });
        return;
      }

      // Attach user to request — overwrite stale JWT claims with fresh membership
      // values so that role/permission changes take effect immediately without
      // requiring a token refresh or re-login.
      req.user = {
        ...decoded,
        role: userContractor.role,
        canManageIntegrations: userContractor.canManageIntegrations,
        allowedIntegrations: userContractor.allowedIntegrations ?? null,
      };
      
      // Sliding expiration: Refresh token if it's more than halfway to expiration.
      // Always re-issue from the current membership record (not stale JWT claims)
      // so that role/permission changes are picked up at refresh time.
      if (AuthService.shouldRefreshToken(decoded)) {
        const newToken = AuthService.generateToken({
          id: decoded.userId,
          username: decoded.username,
          name: decoded.name,
          email: decoded.email,
          role: userContractor.role,
          contractorId: decoded.contractorId,
          canManageIntegrations: userContractor.canManageIntegrations,
          allowedIntegrations: userContractor.allowedIntegrations ?? null,
          tokenVersion: user.tokenVersion,
        });
        
        // Update the cookie with fresh token
        res.cookie('auth_token', newToken, {
          httpOnly: true,
          secure: process.env.NODE_ENV === 'production',
          sameSite: 'lax',
          maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days in milliseconds
          path: '/', // Explicit path for better cookie persistence
        });
      }
      
      next();
    } catch (error) {
      log.error('Authentication error:', error);
      res.status(401).json({ message: 'Authentication failed' });
    }
  };

  /**
   * Role-based access control (RBAC) middleware factory.
   *
   * Role hierarchy (most to least privileged):
   *   super_admin → admin → manager → user
   *
   * Usage:
   *   ```ts
   *   app.delete('/api/users/:id', requireAuth, requireAdmin, handler);
   *   // OR for multiple roles:
   *   app.patch('/api/...', requireAuth, requireManagerOrAdmin, handler);
   *   ```
   *
   * Pre-built role guards (exported at the bottom of this file):
   *   - `requireAdmin`          — allows 'admin' and 'super_admin'
   *   - `requireManagerOrAdmin` — allows 'manager', 'admin', and 'super_admin'
   *
   * Always place this middleware AFTER `requireAuth` — it assumes `req.user` is set.
   *
   * @param allowedRoles - Array of role strings permitted to proceed.
   */
  static requireRole = (allowedRoles: string[]) => {
    return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      if (!req.user) {
        res.status(401).json({ message: 'Unauthorized' });
        return;
      }

      if (!allowedRoles.includes(req.user.role)) {
        res.status(403).json({ 
          message: 'Access denied. Insufficient permissions.' 
        });
        return;
      }

      next();
    };
  };

  /**
   * Tenant isolation middleware - ensures user can only access their contractor's data
   */
  static requireContractorAccess = (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      res.status(401).json({ message: 'Unauthorized' });
      return;
    }

    if (!req.user.contractorId) {
      log.error('Security violation: User token missing contractorId', { userId: req.user.userId });
      res.status(403).json({ message: 'Invalid contractor access' });
      return;
    }

    // Add contractor validation to request for debugging
    req.contractorId = req.user.contractorId;
    next();
  };

  /**
   * Validate that a resource belongs to the user's contractor
   */
  static validateContractorAccess = (userContractorId: string, resourceContractorId: string | null | undefined): boolean => {
    if (!resourceContractorId) {
      log.error('Security violation: Resource missing contractorId');
      return false;
    }
    
    if (userContractorId !== resourceContractorId) {
      log.error('Security violation: Tenant ID mismatch', { 
        userContractorId, 
        resourceContractorId 
      });
      return false;
    }
    
    return true;
  };

  /**
   * Generate a secure random string for JWT secret
   */
  static generateSecretKey(): string {
    return crypto.randomBytes(64).toString('hex');
  }
}

// Convenience middleware exports
export const requireAuth = AuthService.requireAuth;
export const requireManagerOrAdmin = AuthService.requireRole(['manager', 'admin', 'super_admin']);
export const requireAdmin = AuthService.requireRole(['admin', 'super_admin']);
export const requireContractorAccess = AuthService.requireContractorAccess;
export const validateContractorAccess = AuthService.validateContractorAccess;

/**
 * Allows managers, admins, super_admins, and users with the `canManageIntegrations`
 * delegation flag. Use this for integration management routes where the UI exposes
 * functionality to both privileged roles and delegated integration admins.
 */
export const requireIntegrationManager = (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
  if (!req.user) {
    res.status(401).json({ message: 'Unauthorized' });
    return;
  }
  const role = req.user.role;
  const isManagerOrAdmin = role === 'manager' || role === 'admin' || role === 'super_admin';
  if (!isManagerOrAdmin && !req.user.canManageIntegrations) {
    res.status(403).json({ message: 'Access denied. Insufficient permissions.' });
    return;
  }
  next();
};
