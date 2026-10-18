export type ErrorCode = 'invalid' | 'unauthenticated' | 'forbidden' | 'not_found' | 'conflict' | 'unavailable';

/** Business-rule failure. The API layer maps `code` to an HTTP status. */
export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}
