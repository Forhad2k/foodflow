/** Business-rule or HTTP-level error. Mapped to a stable JSON error by the error-handling middleware. */
export class DomainError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly httpStatus = 409,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
  }
  /** Alias so callers/tests can read `.status` like on most HTTP errors. */
  get status(): number {
    return this.httpStatus;
  }
}

export const unauthorized = (message = 'Unauthorized') => new DomainError('UNAUTHORIZED', message, 401);
export const forbidden = (message = 'Forbidden') => new DomainError('FORBIDDEN', message, 403);
export const notFound = (message = 'Not found') => new DomainError('NOT_FOUND', message, 404);
export const conflict = (message = 'Conflict') => new DomainError('CONFLICT', message, 409);
