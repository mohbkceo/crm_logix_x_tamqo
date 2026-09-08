import {
  P,
  can,
  hasBusinessAccess,
  BUSINESSES,
} from "../../shared/permissions.js";
import { assert } from "./errors.js";
export { P, can, hasBusinessAccess };
export const requirePermission =
  (...permissions) =>
  (req, _res, next) => {
    assert(
      permissions.some((p) => can(req.user, p)),
      "Permission denied",
      403,
    );
    next();
  };
export function requireBusinesses(user, businesses) {
  assert(
    businesses.length > 0 &&
      businesses.every(
        (b) => BUSINESSES.includes(b) && hasBusinessAccess(user, b),
      ),
    "Business access denied",
    403,
  );
}
export function requireAnyBusiness(user, businesses) {
  assert(
    businesses.length > 0 &&
      businesses.some(
        (b) => BUSINESSES.includes(b) && hasBusinessAccess(user, b),
      ),
    "Business access denied",
    403,
  );
}
export const orderBusinesses = (order) => [
  ...new Set(order.items.map((i) => i.business)),
];
export function orderScope(user, own = false) {
  const allowed =
    user.role === "SUPER_ADMIN" ? BUSINESSES : user.businessAccess;
  const types = allowed.map((b) => `${b}_ONLY`);
  if (BUSINESSES.every((b) => allowed.includes(b))) types.push("PARTNERSHIP");
  return {
    businessType: { $in: types },
    ...(own ? { "createdBy.userId": user._id } : {}),
  };
}
export function requireOwnOrAll(
  user,
  resource,
  own = P.orders.updateOwn,
  all = P.orders.updateAll,
  businesses = orderBusinesses(resource),
  message = "Order access denied",
) {
  requireBusinesses(user, businesses);
  assert(
    can(user, all) ||
      (can(user, own) &&
        String(resource.createdBy?.userId) === String(user._id)),
    message,
    403,
  );
}
export function ownOrAllScope(user, own, all, message = "Access denied") {
  assert(can(user, own) || can(user, all), message, 403);
  return can(user, all) ? {} : { "createdBy.userId": user._id };
}
export function saleScope(user, own = false) {
  const allowed =
    user.role === "SUPER_ADMIN" ? BUSINESSES : user.businessAccess;
  return {
    business: { $in: allowed },
    ...(own ? { "createdBy.userId": user._id } : {}),
  };
}
export function analyticsScope(user, scope = "ALL") {
  assert(
    [
      P.analytics.viewOwn,
      P.analytics.viewBusiness,
      P.analytics.viewGlobal,
    ].some((p) => can(user, p)),
    "Analytics permission required",
    403,
  );
  if (scope === "PARTNERSHIP")
    assert(
      can(user, P.partnership.view) && hasBusinessAccess(user, "PARTNERSHIP"),
      "Partnership access denied",
      403,
    );
  else if (BUSINESSES.includes(scope)) requireBusinesses(user, [scope]);
  const own =
    !can(user, P.analytics.viewBusiness) && !can(user, P.analytics.viewGlobal);
  const filter = orderScope(user, own);
  if (!can(user, P.partnership.view))
    filter.businessType.$in = filter.businessType.$in.filter(
      (b) => b !== "PARTNERSHIP",
    );
  return filter;
}
