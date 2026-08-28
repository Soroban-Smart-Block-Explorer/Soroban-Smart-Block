/**
 * Base error class for all Soroban Explorer API errors.
 * Contains the HTTP status code and the parsed response body.
 */
export class SorobanExplorerError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = "SorobanExplorerError";
    this.status = status;
    this.body = body;
  }
}

/** The requested resource was not found (HTTP 404). */
export class NotFoundError extends SorobanExplorerError {
  constructor(message: string, body: unknown) {
    super(message, 404, body);
    this.name = "NotFoundError";
  }
}

/**
 * The request was rate-limited (HTTP 429).
 * `retryAfter` is the number of seconds to wait before retrying.
 */
export class RateLimitError extends SorobanExplorerError {
  readonly retryAfter: number;

  constructor(message: string, body: unknown, retryAfter: number) {
    super(message, 429, body);
    this.name = "RateLimitError";
    this.retryAfter = retryAfter;
  }
}

/** The request was rejected due to invalid input (HTTP 400 or 422). */
export class ValidationError extends SorobanExplorerError {
  constructor(message: string, status: number, body: unknown) {
    super(message, status, body);
    this.name = "ValidationError";
  }
}

/** The request requires authentication (HTTP 401). */
export class UnauthorizedError extends SorobanExplorerError {
  constructor(message: string, body: unknown) {
    super(message, 401, body);
    this.name = "UnauthorizedError";
  }
}
