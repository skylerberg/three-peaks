export type AppErrorStatus = 400 | 401 | 403 | 404 | 409 | 413 | 422 | 429 | 500;

export class AppError extends Error {
  constructor(
    public readonly statusCode: AppErrorStatus,
    message: string,
    public readonly extra?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'AppError';
  }
}

// Postgres unique_violation. Every insert that races a pre-check needs this:
// checking for the row first and inserting after is two statements with a gap.
export function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === '23505';
}

// Postgres foreign_key_violation: a delete a referencing row still refuses.
export function isForeignKeyViolation(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === '23503';
}
