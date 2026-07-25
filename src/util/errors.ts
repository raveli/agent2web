/**
 * Error carrying a message that is safe (and useful) to show to an MCP client or
 * HTTP caller. Everything else is logged server-side and reported generically.
 */
export class UserError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = 'UserError';
  }
}

export function isUserError(err: unknown): err is UserError {
  return err instanceof UserError;
}

export function messageFor(err: unknown): string {
  if (isUserError(err)) return err.message;
  return 'Internal error. Check the server logs for details.';
}
