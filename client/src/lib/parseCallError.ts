export type CallErrorCode = 'rate_limit' | 'conflict' | 'permission_denied' | 'unknown';

export interface ParsedCallError {
  code: CallErrorCode;
  userMessage: string;
  retryAfterSeconds: number;
}

const DEFAULT_MESSAGE = "Couldn't start the call. Please try again or check your Dialpad connection.";

/**
 * Parse the Error thrown by apiRequest for a failed /api/calls/initiate call.
 *
 * apiRequest throws Error with message of the form "<status>: <body>", where
 * <body> is the JSON our server returned: { error, code, retryAfterSeconds }.
 * If parsing fails for any reason we fall back to a generic message + 5s
 * cooldown so the UI still degrades gracefully.
 */
export function parseCallError(error: unknown): ParsedCallError {
  const fallback: ParsedCallError = {
    code: 'unknown',
    userMessage: DEFAULT_MESSAGE,
    retryAfterSeconds: 5,
  };

  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  if (!message) return fallback;

  const colon = message.indexOf(': ');
  const body = colon >= 0 ? message.slice(colon + 2) : message;

  try {
    const parsed = JSON.parse(body);
    const code: CallErrorCode =
      parsed?.code === 'rate_limit' || parsed?.code === 'conflict' || parsed?.code === 'permission_denied'
        ? parsed.code
        : 'unknown';
    const retry = Number(parsed?.retryAfterSeconds);
    return {
      code,
      userMessage: typeof parsed?.error === 'string' && parsed.error.trim() !== '' ? parsed.error : DEFAULT_MESSAGE,
      retryAfterSeconds: Number.isFinite(retry) && retry >= 0 ? retry : 5,
    };
  } catch {
    return fallback;
  }
}
