export class AppError extends Error {
  // `details` carries optional, client-safe context: field, action,
  // retryable, messageAr. It must never contain provider bodies or secrets.
  constructor(message, status = 400, code = "VALIDATION_ERROR", details) {
    super(message);
    this.status = status;
    this.code = code;
    if (details && typeof details === "object") this.details = details;
  }
}
export const assert = (condition, message, status = 400, code, details) => {
  if (!condition) throw new AppError(message, status, code, details);
};
