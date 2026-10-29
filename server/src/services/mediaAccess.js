import { can, P } from "../authorization.js";

// Reuse report creation/resolution permissions and the existing Tracking scope.
export const canManageIssueMedia = (user, issue) =>
  can(user, P["tracking.issue"].resolve) ||
  (can(user, P["tracking.issue"].create) &&
    String(issue.reporter?.userId) === String(user._id));
