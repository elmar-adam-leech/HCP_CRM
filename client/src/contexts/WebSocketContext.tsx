/**
 * WebSocketContext — real-time event bus for server-pushed updates.
 *
 * The server broadcasts the following WebSocket event types to all tabs
 * belonging to the same contractor (multi-tab safe via `broadcastToContractor`):
 *
 *   Contact / Lead events:
 *     new_lead             — a new lead/contact was created
 *     lead_updated         — a lead's fields were changed
 *     lead_status_changed  — a lead's status changed (e.g. new → contacted)
 *
 *   Messaging events:
 *     new_message          — an inbound or outbound message was recorded
 *     message_update       — an existing message's status changed (delivered/failed)
 *     message_updated      — alias of message_update used by some code paths
 *
 *   Job events:
 *     new_job / job_created   — a job was created
 *     job_updated             — a job's fields were changed
 *     job_deleted             — a job was deleted
 *     job_status_changed      — a job's status changed
 *
 *   Workflow events:
 *     workflow_started     — a workflow execution began
 *     workflow_completed   — a workflow execution finished successfully
 *     workflow_failed      — a workflow execution failed
 *
 *   Sync events:
 *     sync_status          — sync state changed (start, progress, complete, error)
 *
 *   Other:
 *     new_activity         — an activity log entry was created
 *     new_notification     — a new notification was created
 *     call_started         — an outbound call was initiated
 *
 * Subscribe / unsubscribe pattern for consumers:
 *   ```ts
 *   const { subscribe } = useWebSocketContext();
 *   useEffect(() => {
 *     const unsubscribe = subscribe((msg) => {
 *       if (msg.type === 'new_message') { ... }
 *     });
 *     return unsubscribe; // clean up on unmount
 *   }, [subscribe]);
 *   ```
 *
 * Known limitation — no client-side heartbeat/ping:
 *   The browser's WebSocket connection can silently drop on some networks (especially
 *   mobile or behind load balancers with idle-timeout). The current implementation
 *   relies entirely on the server closing the socket to trigger reconnection logic.
 *   If silent drops become an issue, add a `setInterval` ping every ~30 s and
 *   reconnect if no pong is received within 5 s.
 */
import { createContext, useContext, useEffect, useRef, useState, useCallback, ReactNode } from 'react';

export interface WebSocketMessage {
  type: string;
  data?: unknown;
  // Optional fields sent on message-related events (new_message, message_update, etc.)
  contactId?: string;
  contactType?: string;
  [key: string]: unknown;
}

type MessageCallback = (message: WebSocketMessage) => void;

interface WebSocketContextValue {
  isConnected: boolean;
  subscribe: (callback: MessageCallback) => () => void;
}

const WebSocketContext = createContext<WebSocketContextValue | null>(null);

export function useWebSocketContext() {
  const context = useContext(WebSocketContext);
  if (!context) {
    throw new Error('useWebSocketContext must be used within WebSocketProvider');
  }
  return context;
}

interface WebSocketProviderProps {
  children: ReactNode;
}

export function WebSocketProvider({ children }: WebSocketProviderProps) {
  const [isConnected, setIsConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const subscribersRef = useRef<Set<MessageCallback>>(new Set());
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const intentionalCloseRef = useRef(false);

  const connect = () => {
    // Don't create multiple connections
    if (wsRef.current?.readyState === WebSocket.OPEN || 
        wsRef.current?.readyState === WebSocket.CONNECTING) {
      return;
    }

    try {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const host = window.location.host;
      const wsUrl = `${protocol}//${host}/ws`;
      
      if (import.meta.env.DEV) console.log('[WebSocket] Connecting...');
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        if (import.meta.env.DEV) console.log('[WebSocket] Connected');
        setIsConnected(true);
        reconnectAttemptsRef.current = 0;
      };

      ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          if (!message || typeof message.type !== 'string') {
            if (import.meta.env.DEV) console.warn('[WebSocket] Ignoring message without valid type:', message);
            return;
          }
          if (import.meta.env.DEV) console.log('[WebSocket] Message received:', message);
          
          subscribersRef.current.forEach(callback => {
            try {
              callback(message);
            } catch (error) {
              const msg = error instanceof Error ? error.message : String(error);
              const stack = error instanceof Error ? error.stack : undefined;
              if (import.meta.env.DEV) console.error(`[WebSocket] Subscriber callback error: ${msg}`, stack || error);
            }
          });
        } catch (error) {
          if (import.meta.env.DEV) console.error('[WebSocket] Failed to parse message:', error);
        }
      };

      ws.onerror = (error) => {
        if (import.meta.env.DEV) console.error('[WebSocket] Error:', error);
      };

      ws.onclose = () => {
        if (import.meta.env.DEV) console.log('[WebSocket] Disconnected');
        setIsConnected(false);
        wsRef.current = null;

        // Auto-reconnect with exponential backoff (unless intentionally closed)
        if (!intentionalCloseRef.current) {
          const attempts = reconnectAttemptsRef.current;
          const delay = Math.min(1000 * Math.pow(2, attempts), 30000); // Max 30 seconds
          
          if (import.meta.env.DEV) console.log(`[WebSocket] Reconnecting in ${delay}ms (attempt ${attempts + 1})...`);
          reconnectTimeoutRef.current = setTimeout(() => {
            reconnectAttemptsRef.current++;
            connect();
          }, delay);
        }
      };
    } catch (error) {
      if (import.meta.env.DEV) console.error('[WebSocket] Connection error:', error);
    }
  };

  const disconnect = () => {
    intentionalCloseRef.current = true;
    
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    
    setIsConnected(false);
  };

  // Subscribe function that returns unsubscribe function (memoized for stability)
  const subscribe = useCallback((callback: MessageCallback) => {
    subscribersRef.current.add(callback);
    
    // Return unsubscribe function
    return () => {
      subscribersRef.current.delete(callback);
    };
  }, []); // Empty deps - function never changes

  // Connect on mount, disconnect on unmount
  useEffect(() => {
    connect();
    
    return () => {
      disconnect();
    };
  }, []); // Empty dependency array - connect once on mount

  const value: WebSocketContextValue = {
    isConnected,
    subscribe,
  };

  return (
    <WebSocketContext.Provider value={value}>
      {children}
    </WebSocketContext.Provider>
  );
}
