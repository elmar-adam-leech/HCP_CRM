import { WebSocketServer, WebSocket } from 'ws';
import { Server } from 'http';
import { parse } from 'url';
import { IncomingMessage } from 'http';
import { AuthService } from './auth-service';
import { log } from './vite';
import { z } from 'zod';

// WebSocket message validation schemas
const wsMessageSchema = z.object({
  type: z.enum(['ping', 'subscribe', 'unsubscribe']),
  channel: z.string().optional(),
}).passthrough();

interface AuthenticatedWebSocket extends WebSocket {
  userId?: string;
  contractorId?: string;
  tokenVersion?: number;
  isAlive?: boolean;
}

let wss: WebSocketServer | null = null;
let heartbeatIntervalHandle: ReturnType<typeof setInterval> | null = null;

// Extract token from a raw HTTP upgrade request (cookies or query param).
// WebSocket upgrade requests are plain IncomingMessage objects — they don't go
// through Express middleware, so req.cookies is unavailable. We parse the
// Cookie header manually here instead of reusing AuthService.extractToken,
// which expects an Express Request. The Authorization-header path delegates
// to AuthService.extractTokenFromHeader to avoid duplicating that logic.
function extractToken(request: IncomingMessage): string | null {
  // Try cookie first (more secure for browser clients)
  const cookieHeader = request.headers.cookie;
  if (cookieHeader) {
    const cookies = cookieHeader.split(';').reduce((acc, cookie) => {
      const [key, value] = cookie.trim().split('=');
      acc[key] = value;
      return acc;
    }, {} as Record<string, string>);

    if (cookies.auth_token) {
      return cookies.auth_token;
    }
  }

  // Fall back to Authorization header (API clients that cannot set cookies)
  const headerToken = AuthService.extractTokenFromHeader(request.headers.authorization);
  if (headerToken) return headerToken;

  return null;
}

export function setupWebSocket(server: Server) {
  wss = new WebSocketServer({ noServer: true });

  wss.on('error', (err) => {
    log(`[WebSocket] Server error: ${err.message}`);
  });

  // Handle upgrade requests
  server.on('upgrade', (request, socket, head) => {
    const { pathname } = parse(request.url || '');

    if (pathname === '/ws') {
      // Extract token before doing any async work so we can close the socket
      // synchronously if no token was provided.
      const token = extractToken(request);

      if (!token) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      // Full async auth validation: checks JWT signature, JTI revocation,
      // user existence, tokenVersion, and contractor membership — identical to
      // requireAuth. A simple verifyToken() call (signature only) is NOT
      // sufficient because it would allow revoked tokens (post-logout),
      // invalidated sessions (post-logout-all), and removed memberships to
      // open a persistent real-time data channel.
      AuthService.validateTokenFull(token).then((decoded) => {
        if (!decoded) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }

        // Upgrade the connection
        wss!.handleUpgrade(request, socket, head, (ws: AuthenticatedWebSocket) => {
          ws.userId = decoded.userId;
          ws.contractorId = decoded.contractorId;
          // Store tokenVersion so the heartbeat revalidation can detect
          // logout-all (which increments tokenVersion) without a raw token.
          ws.tokenVersion = decoded.tokenVersion;
          ws.isAlive = true;

          wss!.emit('connection', ws, request);
        });
      }).catch(() => {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
      });
    }
    // Non-/ws paths: do nothing — Vite's HMR upgrade handler (registered earlier)
    // will process those connections. Destroying them here was breaking Vite HMR,
    // causing the page to reload every few seconds.
  });

  // Handle WebSocket connections
  wss.on('connection', (ws: AuthenticatedWebSocket) => {
    log(`[WebSocket] Client connected - User: ${ws.userId}, Contractor: ${ws.contractorId}`);

    // Send welcome message
    ws.send(JSON.stringify({ 
      type: 'connected',
      message: 'WebSocket connected successfully'
    }));

    // Heartbeat mechanism - respond to pings
    ws.on('pong', () => {
      ws.isAlive = true;
    });

    // Handle incoming messages with Zod validation
    ws.on('message', (message: string) => {
      try {
        const rawData = JSON.parse(message.toString());
        
        // Validate message structure
        const parseResult = wsMessageSchema.safeParse(rawData);
        if (!parseResult.success) {
          log(`[WebSocket] Invalid message schema: ${parseResult.error.message}`);
          ws.send(JSON.stringify({ type: 'error', message: 'Invalid message format' }));
          return;
        }
        
        const data = parseResult.data;
        
        // Handle ping from client
        if (data.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong' }));
        }
      } catch (error) {
        log(`[WebSocket] Invalid message format: ${error}`);
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
      }
    });

    ws.on('error', (error) => {
      log(`[WebSocket] Error: ${error.message}`);
    });

    ws.on('close', () => {
      log(`[WebSocket] Client disconnected - User: ${ws.userId}`);
    });
  });

  // Heartbeat interval - ping clients every 2 minutes and revalidate sessions.
  // SCALING NOTE: `wss.clients` is a Set local to this Node.js process. In a
  // multi-process or multi-pod deployment, each process only pings the connections
  // it owns. Clients connected to other processes are NOT reachable here. For
  // horizontal scaling, replace the in-process broadcast helpers (broadcastToContractor
  // etc.) with a Redis pub/sub fan-out: publish on the originating process, subscribe
  // and re-broadcast on all worker processes. The heartbeat loop itself is fine to keep
  // per-process — each process should independently health-check its own connections.
  const HEARTBEAT_INTERVAL_MS = 120_000; // 2 minutes
  heartbeatIntervalHandle = setInterval(() => {
    wss!.clients.forEach(async (ws: AuthenticatedWebSocket) => {
      if (ws.isAlive === false) {
        log(`[WebSocket] Terminating inactive connection - User: ${ws.userId}`);
        ws.terminate();
        return;
      }

      // Revalidate session on every heartbeat cycle.  This catches:
      //   - Explicit logout (tokenVersion incremented via logout-all)
      //   - Membership removal (userContractor row deleted)
      //   - User account deletion
      // Note: JTI revocation from a single-device logout is caught at connection
      // time via validateTokenFull; ongoing connections are covered by tokenVersion
      // because logout-all always increments it, and terminateUserConnections is
      // called by logout to cut them immediately.
      if (ws.userId && ws.contractorId && ws.tokenVersion !== undefined) {
        const valid = await AuthService.revalidateSession(ws.userId, ws.contractorId, ws.tokenVersion);
        if (!valid) {
          log(`[WebSocket] Terminating invalidated session - User: ${ws.userId}`);
          try {
            ws.send(JSON.stringify({ type: 'session_expired', message: 'Session expired or access revoked' }));
          } catch {
            // Ignore send errors when the socket is already closing
          }
          ws.terminate();
          return;
        }
      }

      ws.isAlive = false;
      ws.ping();
    });
  }, HEARTBEAT_INTERVAL_MS);

  wss.on('close', () => {
    if (heartbeatIntervalHandle) {
      clearInterval(heartbeatIntervalHandle);
      heartbeatIntervalHandle = null;
    }
  });

  log('[WebSocket] Server initialized on path /ws');
}

/**
 * Gracefully stop the WebSocket server.
 *
 * 1. Clears the heartbeat interval so no new pings are sent.
 * 2. Terminates all lingering client connections so `server.close()` can
 *    resolve without waiting on long-lived upgraded sockets.
 * 3. Closes the WebSocketServer itself.
 *
 * Call this before `pool.end()` during graceful shutdown.
 */
export function stopWebSocket(): Promise<void> {
  return new Promise((resolve) => {
    if (heartbeatIntervalHandle) {
      clearInterval(heartbeatIntervalHandle);
      heartbeatIntervalHandle = null;
    }

    if (!wss) {
      resolve();
      return;
    }

    // Terminate all open client connections so the HTTP server's close()
    // callback fires promptly instead of waiting for keep-alive timeouts.
    wss.clients.forEach((client) => {
      client.terminate();
    });

    wss.close(() => {
      wss = null;
      resolve();
    });
  });
}

// ─── Scaling Note ──────────────────────────────────────────────────────────
// The WebSocket server operates in single-process mode: `wss.clients` only
// contains connections on THIS Node.js process. If the app is ever scaled
// horizontally (multiple processes / pods), broadcasts will silently fail to
// reach clients connected to other processes.
//
// To fix this at scale, replace the in-process broadcast functions below with
// a Redis pub/sub fan-out (e.g. `ioredis` publish on the source process, and
// subscribe + re-broadcast on all worker processes). This requires zero changes
// to the broadcast call-sites — only the implementation here changes.
// ───────────────────────────────────────────────────────────────────────────

export interface WebSocketBroadcastPayload {
  type: string;
  [key: string]: unknown;
}

// Broadcast a message to all connected clients of a specific contractor
export function broadcastToContractor(contractorId: string, message: WebSocketBroadcastPayload) {
  if (!wss) {
    log('[WebSocket] Server not initialized, cannot broadcast');
    return;
  }

  let sentCount = 0;
  wss.clients.forEach((client: AuthenticatedWebSocket) => {
    if (client.contractorId === contractorId && client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(message));
      sentCount++;
    }
  });

  log(`[WebSocket] Broadcasted message to ${sentCount} clients for contractor ${contractorId}`);
}


/**
 * Immediately terminate all open WebSocket connections for a given user.
 *
 * Called by the logout and logout-all handlers so that a revoked or
 * invalidated session is cut off right away rather than waiting for the
 * next heartbeat cycle (up to 2 minutes later).
 *
 * A `session_expired` message is sent before termination so the client
 * SPA can handle the disconnection gracefully (e.g. redirect to login).
 */
export function terminateUserConnections(userId: string): void {
  if (!wss) return;
  wss.clients.forEach((client: AuthenticatedWebSocket) => {
    if (client.userId === userId && client.readyState === WebSocket.OPEN) {
      try {
        client.send(JSON.stringify({ type: 'session_expired', message: 'Session terminated' }));
      } catch {
        // Ignore send errors — we're terminating anyway
      }
      client.terminate();
    }
  });
}

export function getConnectedClientsCount(contractorId?: string): number {
  if (!wss) return 0;
  
  let count = 0;
  wss.clients.forEach((client: AuthenticatedWebSocket) => {
    if (!contractorId || client.contractorId === contractorId) {
      if (client.readyState === WebSocket.OPEN) {
        count++;
      }
    }
  });
  
  return count;
}
