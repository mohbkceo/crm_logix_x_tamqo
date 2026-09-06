export class AppError extends Error {
  constructor(message, status = 400, code = "VALIDATION_ERROR") {
    super(message);
    this.status = status;
    this.code = code;
  }
}
export const assert = (condition, message, status = 400, code) => {
  if (!condition) throw new AppError(message, status, code);
};
