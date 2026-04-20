/**
 * Lightweight structured logger for the server.
 *
 * Wraps `console` to enforce a consistent log format:
 *   [Timestamp] [MODULE] message  (optional: error object)
 *
 * This is intentionally thin — no third-party dependency, no async I/O.
 * If log aggregation (Datadog, Sentry, etc.) is added in the future, update
 * the transport here once rather than hunting down every console.* call.
 *
 * Usage:
 *   import { logger } from '../utils/logger';
 *   const log = logger('ContactRoutes');
 *   log.info('Contact created', { id: contact.id });
 *   log.error('DB write failed', error);
 */

type LogLevel = 'info' | 'warn' | 'error' | 'debug';

interface Logger {
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
  debug(message: string, meta?: unknown): void;
}

function formatMessage(module: string, level: LogLevel, message: string): string {
  const ts = new Date().toISOString();
  return `${ts} [${level.toUpperCase()}] [${module}] ${message}`;
}

/**
 * Create a module-scoped logger.
 * @param module  Short identifier for the calling module, e.g. 'WorkflowEngine' or 'ContactRoutes'.
 */
export function logger(module: string): Logger {
  return {
    info(message, meta) {
      if (meta !== undefined) {
        console.log(formatMessage(module, 'info', message), meta);
      } else {
        console.log(formatMessage(module, 'info', message));
      }
    },
    warn(message, meta) {
      if (meta !== undefined) {
        console.warn(formatMessage(module, 'warn', message), meta);
      } else {
        console.warn(formatMessage(module, 'warn', message));
      }
    },
    error(message, meta) {
      if (meta !== undefined) {
        console.error(formatMessage(module, 'error', message), meta);
      } else {
        console.error(formatMessage(module, 'error', message));
      }
    },
    debug(message, meta) {
      if (process.env.NODE_ENV !== 'production') {
        if (meta !== undefined) {
          console.log(formatMessage(module, 'debug', message), meta);
        } else {
          console.log(formatMessage(module, 'debug', message));
        }
      }
    },
  };
}
