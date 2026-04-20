/**
 * Shared error utilities for consistent error handling across the server.
 *
 * Usage pattern for catch blocks:
 *   ```ts
 *   } catch (error) {
 *     logger.error('[Module]', 'Something failed', error);
 *     res.status(500).json({ message: getErrorMessage(error) });
 *   }
 *   ```
 *
 * Why `unknown` instead of `any` in catch blocks:
 *   TypeScript 4.0+ catches are `unknown` by default in strict mode. Using `any`
 *   suppresses type safety and allows accidentally accessing non-existent properties.
 *   `getErrorMessage` safely narrows the type before extracting the message string.
 */

/**
 * Safely extracts a human-readable message from any thrown value.
 * Handles Error instances, plain objects with a `message` property, and primitives.
 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (
    error !== null &&
    typeof error === 'object' &&
    'message' in error &&
    typeof (error as Record<string, unknown>).message === 'string'
  ) {
    return (error as Record<string, unknown>).message as string;
  }
  return 'An unknown error occurred';
}

/**
 * Type guard: returns true if the value is an Error instance.
 * Useful when you need the full Error object (stack trace, name, etc.)
 */
export function isError(error: unknown): error is Error {
  return error instanceof Error;
}
