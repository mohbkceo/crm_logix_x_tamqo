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
  order,
  own = P.orders.updateOwn,
  all = P.orders.updateAll,
) {
  requireBusinesses(user, orderBusinesses(order));
  assert(
    can(user, all) ||
      (can(user, own) && String(order.createdBy?.userId) === String(user._id)),
    "Order access denied",
    403,
  );
}
export function saleScope(user) {
  const viewAll = can(user, P.sales.viewAll);
  assert(
    viewAll || can(user, P.sales.viewOwn),
    "Sale view permission denied",
    403,
  );
  const businesses =
    user.role === "SUPER_ADMIN" ? BUSINESSES : user.businessAccess;
  return {
    business: { $in: businesses },
    ...(viewAll ? {} : { "createdBy.userId": user._id }),
  };
}
export function requireSaleOwnOrAll(user, sale, own, all) {
  requireBusinesses(user, [sale.business]);
  assert(
    can(user, all) ||
      (can(user, own) && String(sale.createdBy?.userId) === String(user._id)),
    "Sale access denied",
    403,
  );
}
function analyticsContext(user, scope) {
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
  return {
    allowed: user.role === "SUPER_ADMIN" ? BUSINESSES : user.businessAccess,
    own:
      !can(user, P.analytics.viewBusiness) &&
      !can(user, P.analytics.viewGlobal),
  };
}
export function analyticsScope(user, scope = "ALL") {
  const { own } = analyticsContext(user, scope);
  const filter = orderScope(user, own);
  if (!can(user, P.partnership.view))
    filter.businessType.$in = filter.businessType.$in.filter(
      (b) => b !== "PARTNERSHIP",
    );
  return filter;
}
export function saleAnalyticsScope(user, scope = "ALL") {
  const { allowed, own } = analyticsContext(user, scope);
  return {
    business: {
      $in:
        scope === "PARTNERSHIP"
          ? []
          : BUSINESSES.includes(scope)
            ? [scope]
            : allowed,
    },
    ...(own ? { "createdBy.userId": user._id } : {}),
  };
}
