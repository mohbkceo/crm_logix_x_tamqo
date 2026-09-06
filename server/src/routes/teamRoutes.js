import { Router } from "express";
import { Order } from "../models/index.js";
import { User } from "../models/security.js";
import { analyticsScope, orderScope, P, can } from "../authorization.js";
import { orderFilter, objectId } from "../services/filters.js";
import { reportingRange } from "../domain/period.js";
import { buildReport, summarize } from "../services/analyticsService.js";
export const teamRoutes = Router();
teamRoutes.get("/employees{/:userId}", async (req, res) => {
  const scope = req.query.scope || "ALL",
    access = analyticsScope(req.user, scope),
    range = reportingRange(req.query);
  const filter = {
    $and: [access, orderFilter({ ...req.query, period: undefined })],
  };
  if (["LOGIX", "TAMQO"].includes(scope)) filter["items.business"] = scope;
  if (scope === "PARTNERSHIP") filter.businessType = "PARTNERSHIP";
  if (req.params.userId)
    filter["createdBy.userId"] = objectId(req.params.userId);
  const rows = await Order.find({
    ...filter,
    createdAt: { $gte: range.start, $lt: range.end },
  }).lean();
  const recent = await Order.find({
    ...filter,
    createdAt: {
      $gte: reportingRange({ period: "month" }).start,
      $lt: reportingRange({ period: "today" }).end,
    },
  }).lean();
  const ids = [
    ...new Set(rows.map((o) => String(o.createdBy?.userId || "legacy"))),
  ];
  const items = ids.map((userId) => {
    const own = rows.filter(
        (o) => String(o.createdBy?.userId || "legacy") === userId,
      ),
      report = buildReport(own, [], own, scope, range),
      now = recent.filter(
        (o) => String(o.createdBy?.userId || "legacy") === userId,
      );
    return {
      userId,
      name: own[0].createdBy?.name || "Legacy / Unknown",
      ...report,
      ordersToday: now.filter(
        (o) => o.createdAt >= reportingRange({ period: "today" }).start,
      ).length,
      ordersThisWeek: now.filter(
        (o) => o.createdAt >= reportingRange({ period: "week" }).start,
      ).length,
      ordersThisMonth: now.length,
      tamqo: summarize(
        own.filter((o) => o.items.some((i) => i.business === "TAMQO")),
        "TAMQO",
      ),
      logix: summarize(
        own.filter((o) => o.items.some((i) => i.business === "LOGIX")),
        "LOGIX",
      ),
      partnership: summarize(
        own.filter((o) => o.businessType === "PARTNERSHIP"),
        "ALL",
      ),
    };
  });
  res.json({ items, range });
});
export async function employeeOptions(req, res) {
  const wide =
    can(req.user, P.orders.viewAll) ||
    can(req.user, P.analytics.viewBusiness) ||
    can(req.user, P.analytics.viewGlobal) ||
    can(req.user, P.expenses.view);
  const ids = wide
    ? await Order.distinct("createdBy.userId", orderScope(req.user))
    : [];
  res.json(
    await User.find({ _id: { $in: [req.user._id, ...ids] } })
      .select("name")
      .sort({ name: 1 }),
  );
}
