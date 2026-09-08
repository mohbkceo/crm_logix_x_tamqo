import { Router } from "express";
import { Order, Sale } from "../models/index.js";
import { User } from "../models/security.js";
import {
  analyticsScope,
  orderScope,
  saleScope,
  P,
  can,
} from "../authorization.js";
import { orderFilter, objectId } from "../services/filters.js";
import { reportingRange } from "../domain/period.js";
import {
  buildReport,
  directSaleFilter,
  summarizePerformance,
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
  const salesFilter = directSaleFilter(
      {
        ...req.query,
        employee: req.params.userId || req.query.employee,
      },
      scope,
      req.user,
    ),
    recentRange = {
      start: reportingRange({ period: "month" }).start,
      end: reportingRange({ period: "today" }).end,
    };
  const [rows, sales, recent, recentSales] = await Promise.all([
    Order.find({
      ...filter,
      createdAt: { $gte: range.start, $lt: range.end },
    }).lean(),
    Sale.find({
      ...salesFilter,
      saleDate: { $gte: range.start, $lt: range.end },
    }).lean(),
    Order.find({
      ...filter,
      createdAt: { $gte: recentRange.start, $lt: recentRange.end },
    }).lean(),
    Sale.find({
      ...salesFilter,
      saleDate: { $gte: recentRange.start, $lt: recentRange.end },
    }).lean(),
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
      salesNow = recentSales.filter(
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
      directSalesToday: salesNow.filter(
        (sale) => sale.saleDate >= reportingRange({ period: "today" }).start,
      ).length,
      directSalesThisWeek: salesNow.filter(
        (sale) => sale.saleDate >= reportingRange({ period: "week" }).start,
      ).length,
      directSalesThisMonth: salesNow.length,
      tamqo: summarizePerformance(
        own.filter((o) => o.items.some((i) => i.business === "TAMQO")),
        ownSales.filter((sale) => sale.business === "TAMQO"),
        "TAMQO",
      ),
      logix: summarizePerformance(
        own.filter((o) => o.items.some((i) => i.business === "LOGIX")),
        ownSales.filter((sale) => sale.business === "LOGIX"),
        "LOGIX",
      ),
      partnership: summarizePerformance(
        own.filter((o) => o.businessType === "PARTNERSHIP"),
        [],
        "ALL",
      ),
    };
  });
  res.json({ items, range });
});
export async function employeeOptions(req, res) {
  const analyticsWide =
      can(req.user, P.analytics.viewBusiness) ||
      can(req.user, P.analytics.viewGlobal),
    orderWide =
      can(req.user, P.orders.viewAll) ||
      analyticsWide ||
      can(req.user, P.expenses.view),
    salesWide = can(req.user, P.sales.viewAll) || analyticsWide,
    [orderIds, saleIds] = await Promise.all([
      orderWide ? Order.distinct("createdBy.userId", orderScope(req.user)) : [],
      salesWide ? Sale.distinct("createdBy.userId", saleScope(req.user)) : [],
    ]),
    ids = [...new Set([...orderIds, ...saleIds].map(String))];
  res.json(
    await User.find({ _id: { $in: [req.user._id, ...ids] } })
      .select("name")
      .sort({ name: 1 }),
  );
}
