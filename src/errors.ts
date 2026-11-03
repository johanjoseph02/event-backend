export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const notFound = (what: string) => new AppError(404, "not_found", `${what} not found`);
export const conflict = (code: string, message: string, details?: unknown) =>
  new AppError(409, code, message, details);
export const invalid = (message: string, details?: unknown) =>
  new AppError(422, "invalid", message, details);
export const forbidden = (message = "not allowed") => new AppError(403, "forbidden", message);
export const unauthorized = () => new AppError(401, "unauthorized", "missing or invalid token");
