import { Router } from "express";
import { Order, Sale } from "../models/index.js";
import { User } from "../models/security.js";
import { analyticsScope, orderScope, P, can } from "../authorization.js";
import { orderFilter, objectId } from "../services/filters.js";
import { reportingRange } from "../domain/period.js";
import {
  analyticsSaleFilter,
  buildReport,
  summarize,
  summarizeWithSales,
} from "../services/analyticsService.js";
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
  const saleFilter = analyticsSaleFilter(
    { ...req.query, employee: req.params.userId || req.query.employee },
    scope,
    req.user,
  );
  const recentRange = {
    $gte: reportingRange({ period: "month" }).start,
    $lt: reportingRange({ period: "today" }).end,
  };
  const [rows, recent, sales, recentSales] = await Promise.all([
    Order.find({
      ...filter,
      createdAt: { $gte: range.start, $lt: range.end },
    }).lean(),
    Order.find({ ...filter, createdAt: recentRange }).lean(),
    Sale.find({
      ...saleFilter,
      saleDate: { $gte: range.start, $lt: range.end },
    }).lean(),
    Sale.find({ ...saleFilter, saleDate: recentRange }).lean(),
  ]);
  const ids = [
    ...new Set(
      [...rows, ...sales].map((row) =>
        String(row.createdBy?.userId || "legacy"),
      ),
    ),
  ];
  const items = ids.map((userId) => {
    const own = rows.filter(
        (o) => String(o.createdBy?.userId || "legacy") === userId,
      ),
      ownSales = sales.filter(
        (sale) => String(sale.createdBy?.userId || "legacy") === userId,
      ),
      report = buildReport(own, [], own, scope, range, ownSales),
      now = recent.filter(
        (o) => String(o.createdBy?.userId || "legacy") === userId,
      ),
      nowSales = recentSales.filter(
        (sale) => String(sale.createdBy?.userId || "legacy") === userId,
      );
    return {
      userId,
      name:
        own[0]?.createdBy?.name ||
        ownSales[0]?.createdBy?.name ||
        "Legacy / Unknown",
      ...report,
      ordersToday: now.filter(
        (o) => o.createdAt >= reportingRange({ period: "today" }).start,
      ).length,
      ordersThisWeek: now.filter(
        (o) => o.createdAt >= reportingRange({ period: "week" }).start,
      ).length,
      ordersThisMonth: now.length,
      directSalesToday: nowSales.filter(
        (sale) => sale.saleDate >= reportingRange({ period: "today" }).start,
      ).length,
      directSalesThisWeek: nowSales.filter(
        (sale) => sale.saleDate >= reportingRange({ period: "week" }).start,
      ).length,
      directSalesThisMonth: nowSales.length,
      tamqo: summarizeWithSales(
        own.filter((o) => o.items.some((i) => i.business === "TAMQO")),
        "TAMQO",
        ownSales.filter((sale) => sale.business === "TAMQO"),
      ),
      logix: summarizeWithSales(
        own.filter((o) => o.items.some((i) => i.business === "LOGIX")),
        "LOGIX",
        ownSales.filter((sale) => sale.business === "LOGIX"),
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
  const wideOrders =
    can(req.user, P.orders.viewAll) ||
    can(req.user, P.analytics.viewBusiness) ||
    can(req.user, P.analytics.viewGlobal) ||
    can(req.user, P.expenses.view);
  const wideSales =
    can(req.user, P.sales.viewAll) ||
    can(req.user, P.analytics.viewBusiness) ||
    can(req.user, P.analytics.viewGlobal);
  const saleBusinesses =
    req.user.role === "SUPER_ADMIN"
      ? ["LOGIX", "TAMQO"]
      : req.user.businessAccess;
  const [orderIds, saleIds] = await Promise.all([
    wideOrders ? Order.distinct("createdBy.userId", orderScope(req.user)) : [],
    wideSales
      ? Sale.distinct("createdBy.userId", {
          business: { $in: saleBusinesses },
        })
      : [],
  ]);
  const ids = [...new Set([...orderIds, ...saleIds].map(String))];
  res.json(
    await User.find({ _id: { $in: [req.user._id, ...ids] } })
      .select("name")
      .sort({ name: 1 }),
  );
}
