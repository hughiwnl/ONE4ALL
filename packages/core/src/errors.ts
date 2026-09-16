/**
 * Application-level errors thrown by core services. The HTTP layer maps them
 * to status codes; other transports (CLI, future gRPC/mobile API) can map them
 * however they like.
 */
export class AppError extends Error {
  /** Structural marker so checks work across bundle boundaries (see isAppError). */
  readonly isAppError = true as const;

  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number = 400,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super('validation_error', message, 400, details);
    this.name = 'ValidationError';
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required') {
    super('unauthorized', message, 401);
    this.name = 'UnauthorizedError';
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'You do not have access to this resource') {
    super('forbidden', message, 403);
    this.name = 'ForbiddenError';
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string) {
    super('not_found', `${resource} not found`, 404);
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends AppError {
  constructor(message: string, details?: unknown) {
    super('conflict', message, 409, details);
    this.name = 'ConflictError';
  }
}

export class PayloadTooLargeError extends AppError {
  constructor(message: string) {
    super('payload_too_large', message, 413);
    this.name = 'PayloadTooLargeError';
  }
}

/**
 * Structural check rather than `instanceof`: Next.js compiles each route into
 * its own bundle, so the same class can exist twice in one process.
 */
export function isAppError(error: unknown): error is AppError {
  if (error instanceof AppError) return true;
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { isAppError?: unknown }).isAppError === true &&
    typeof (error as { code?: unknown }).code === 'string' &&
    typeof (error as { status?: unknown }).status === 'number'
  );
}
