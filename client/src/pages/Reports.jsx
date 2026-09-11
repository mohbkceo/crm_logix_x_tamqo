import { P, Can } from "../access";
import { api } from "../api";
import { useState } from "react";
import { Link } from "react-router-dom";
import {
  ArrowUpRight,
  ShoppingBag,
  Wallet,
  PackageCheck,
  Box,
  SlidersHorizontal,
  Download,
  ArrowRight,
  Receipt,
  Info,
} from "lucide-react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  BarChart,
  Bar,
} from "recharts";
import {
  useApi,
  params,
  money,
  number,
  human,
  useConfig,
  dateInput,
} from "../api";
import {
  PageHeader,
  PeriodFilter,
  Metric,
  Panel,
  DataTable,
  Loading,
  ErrorBox,
  Empty,
  revenueColumns,
  Field,
  ViewLink,
} from "../components";
const sections = [
  "Overview",
  "Order performance",
  "Customers",
  "Products & plans",
  "Sources",
  "Geography",
  "Payments",
  "Delivery",
  "Timing",
];
function MetricRows({ metrics, keys, format }) {
  return (
    <div className="metric-rows">
      {keys.map((k) => (
        <div key={k}>
          <span>{human(k.replace(/([A-Z])/g, " $1"))}</span>
          <b>
            {format === "money"
              ? money(metrics[k])
              : format === "hours"
                ? `${number(metrics[k])} h`
                : k.toLowerCase().includes("rate")
                  ? `${number(metrics[k])}%`
                  : typeof metrics[k] === "string"
                    ? metrics[k]
                    : number(metrics[k])}
          </b>
        </div>
      ))}
    </div>
  );
}
function Trend({ rows }) {
  return rows.length ? (
    <ResponsiveContainer width="100%" height={250}>
      <AreaChart
        data={rows}
        margin={{ top: 15, right: 15, left: 5, bottom: 0 }}
      >
        <defs>
          <linearGradient id="sales-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#27272a" stopOpacity={0.17} />
            <stop offset="100%" stopColor="#27272a" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid
          strokeDasharray="3 4"
          vertical={false}
          stroke="#e4e4e7"
        />
        <XAxis
          dataKey="name"
          tickFormatter={(v) => v.slice(5)}
          axisLine={false}
          tickLine={false}
          tick={{ fontSize: 11, fill: "#71717a" }}
        />
        <YAxis
          tickFormatter={(v) => (v >= 1000 ? `${v / 1000}k` : v)}
          width={45}
          axisLine={false}
          tickLine={false}
          tick={{ fontSize: 11, fill: "#71717a" }}
        />
        <Tooltip formatter={(v) => money(v)} />
        <Area
          type="monotone"
          dataKey="grossSales"
          name="Gross sales"
          stroke="#a1a1aa"
          fill="none"
          strokeWidth={2}
          strokeDasharray="4 4"
        />
        <Area
          type="monotone"
          dataKey="netSales"
          name="Net sales"
          stroke="#27272a"
          fill="url(#sales-fill)"
          strokeWidth={2.5}
        />
      </AreaChart>
    </ResponsiveContainer>
  ) : (
    <Empty
      title="Your sales story starts here"
      text="Create and confirm orders to see performance over time."
      action={
        <Link className="text-link" to="/orders/new">
          Create your first order
          <ArrowRight size={14} />
        </Link>
      }
    />
  );
}
export function Reports({ scope }) {
  const employees = useApi("/employees");
  const [period, setPeriod] = useState({
      period: "30d",
      start: dateInput(),
      end: dateInput(),
    }),
    [tab, setTab] = useState("Overview"),
    [filters, setFilters] = useState({}),
    [showFilters, setShowFilters] = useState(false),
    [definitions, setDefinitions] = useState(false);
  const { data: configuration } = useConfig();
  const report = useApi(
    `/analytics/${scope}?${params({ ...period, ...filters })}`,
  );
  const data = report.data,
    m = data?.metrics;
  const title =
    scope === "all"
      ? "Business overview"
      : scope === "partnership"
        ? "Better, together."
        : `${scope === "tamqo" ? "Tamqo" : "Logix"} analytics`;
  const cards =
    scope === "partnership"
      ? [
          ["Partnership orders", "totalOrders", "number", ShoppingBag],
          ["Partnership net sales", "netSales", "money", Wallet],
          ["Delivered orders", "deliveredOrders", "number", PackageCheck],
          ["Average order value", "averageOrderValue", "money", Box],
          ["Tamqo revenue", "tamqoRevenueThroughPartnership", "money"],
          ["Logix revenue", "logixRevenueThroughPartnership", "money"],
          ["Confirmation rate", "confirmationRate", "percent"],
          ["Delivery success", "deliverySuccessRate", "percent"],
        ]
      : [
          ["Total orders", "totalOrders", "number", ShoppingBag],
          ["Net sales", "netSales", "money", Wallet],
          ["Delivered orders", "deliveredOrders", "number", PackageCheck],
          ["Units sold", "totalUnitsSold", "number", Box],
          ["Average order value", "averageOrderValue", "money"],
          ["Confirmation rate", "confirmationRate", "percent"],
          [
            scope === "tamqo" ? "Renewal rate" : "Delivery success",
            scope === "tamqo" ? "renewalRate" : "deliverySuccessRate",
            "percent",
          ],
          [
            data?.balance ? "Current Balance" : "Pending sales",
            data?.balance ? "currentBalance" : "pendingSalesValue",
            "money",
          ],
        ];
  async function exportReport() {
    if (!data) return;
    const exported = await api(
      `/analytics/${scope}?${params({ ...period, ...filters, export: "true" })}`,
    );
    const blob = new Blob([JSON.stringify(exported, null, 2)], {
        type: "application/json",
      }),
      url = URL.createObjectURL(blob),
      a = document.createElement("a");
    a.href = url;
    a.download = `${scope}-report-${dateInput()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }
  return (
    <>
      <PageHeader
        eyebrow={
          scope === "all"
            ? "YOUR BUSINESS, AT A GLANCE"
            : `BUSINESSES / ${scope.toUpperCase()}`
        }
        title={title}
        description={
          scope === "all"
            ? "A clear view of your orders, revenue, and what comes next."
            : scope === "partnership"
              ? "Combined orders. Separate contributions. Shared growth."
              : `Performance across ${human(scope)} orders and its share of partnership orders.`
        }
      >
        <Can permission={P.analytics.export}>
          <button onClick={exportReport} disabled={!data}>
            <Download size={15} />
            Export report
          </button>
        </Can>
        {["tamqo", "logix"].includes(scope) && (
          <Can permission={P.expenses.view}>
            <Link className="primary" to={`/${scope}/expenses`}>
              <Receipt size={15} />
              Expenses
            </Link>
          </Can>
        )}
      </PageHeader>
      <div className="report-toolbar">
        <PeriodFilter value={period} onChange={setPeriod} />
        <select
          aria-label="Placed By"
          value={filters.employee || ""}
          onChange={(e) => setFilters({ ...filters, employee: e.target.value })}
        >
          <option value="">Placed By: All employees</option>
          {employees.data?.map((u) => (
            <option key={u._id} value={u._id}>
              {u.name}
            </option>
          ))}
        </select>
        <div className="toolbar-right">
          <span className="muted">Compared with previous equal period</span>
          <button
            className={showFilters ? "selected" : ""}
            onClick={() => setShowFilters(!showFilters)}
          >
            <SlidersHorizontal size={15} />
            Filters
          </button>
        </div>
      </div>
      {data && (
        <div className="two-columns">
          <Panel title="Revenue by employee">
            <DataTable rows={data.employees || []} columns={revenueColumns} />
          </Panel>
          <Panel title="Delivery agencies">
            <DataTable rows={data.agencies || []} columns={revenueColumns} />
          </Panel>
        </div>
      )}
      {showFilters && (
        <div className="filter-grid panel">
          <Field label="Source">
            <select
              value={filters.source || ""}
              onChange={(e) =>
                setFilters({ ...filters, source: e.target.value })
              }
            >
              <option value="">All sources</option>
              {configuration?.sources.map((s) => (
                <option value={s._id} key={s._id}>
                  {s.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Wilaya">
            <select
              value={filters.wilaya || ""}
              onChange={(e) =>
                setFilters({ ...filters, wilaya: e.target.value })
              }
            >
              <option value="">All Wilayas</option>
              {configuration?.wilayas.map((s) => (
                <option value={s._id} key={s._id}>
                  {s.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Payment">
            <select
              value={filters.payment || ""}
              onChange={(e) =>
                setFilters({ ...filters, payment: e.target.value })
              }
            >
              <option value="">All payments</option>
              {["COD", "ONLINE", "MIXED"].map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </Field>
          <button onClick={() => setFilters({})}>Clear filters</button>
        </div>
      )}
      <ErrorBox error={report.error} />
      {report.loading ? (
        <Loading />
      ) : (
        data && (
          <>
            <div className="metrics-grid">
              {cards.map(([label, key, format, Icon]) => (
                <Metric
                  key={key}
                  label={label}
                  value={m[key]}
                  format={format}
                  icon={Icon}
                />
              ))}
            </div>
            <div className="tabs">
              {sections.map((s) => (
                <button
                  key={s}
                  className={tab === s ? "active" : ""}
                  onClick={() => setTab(s)}
                >
                  {s}
                </button>
              ))}
            </div>
            {tab === "Overview" && (
              <>
                {data.balance && (
                  <Panel
                    title="Current Balance"
                    subtitle="All-time financial position · independent of the selected report dates"
                    action={<Wallet size={18} />}
                  >
                    <MetricRows
                      metrics={{
                        ...data.balance,
                        orderRevenue: data.balance.realizedOrderRevenue,
                        directSales: data.balance.directSalesRevenue,
                        expenses: data.balance.totalExpenses,
                      }}
                      format="money"
                      keys={[
                        "currentBalance",
                        "totalRevenue",
                        "directSales",
                        "orderRevenue",
                        "expenses",
                      ]}
                    />
                  </Panel>
                )}
                <div className="overview-charts">
                  <Panel
                    title="Sales performance"
                    subtitle="Product revenue · delivery charges excluded"
                    action={
                      <div className="legend">
                        <span>
                          <i />
                          Net sales
                        </span>
                        <span>
                          <i className="light" />
                          Gross sales
                        </span>
                      </div>
                    }
                  >
                    <div className="chart-summary">
                      <strong>{money(m.grossSales)}</strong>
                      <span
                        className={`change ${m.salesGrowth < 0 ? "negative" : ""}`}
                      >
                        <ArrowUpRight size={13} />
                        {m.salesGrowth === null ? "New" : `${m.salesGrowth}%`}
                      </span>
                      <span className="muted">gross sales</span>
                    </div>
                    <Trend rows={data.trend} />
                  </Panel>
                  <Panel
                    title="Order pipeline"
                    subtitle="What needs your attention"
                    action={<ShoppingBag size={17} className="muted" />}
                  >
                    <div className="pipeline-total">
                      <strong>{number(m.pendingOrders)}</strong>
                      <span>orders in progress</span>
                    </div>
                    <div className="pipeline-list">
                      {[
                        [
                          "Awaiting confirmation",
                          "ordersAwaitingConfirmation",
                          "NEW",
                        ],
                        [
                          "Awaiting fulfillment",
                          "ordersAwaitingFulfillment",
                          "CONFIRMED",
                        ],
                        [
                          "Awaiting delivery",
                          "ordersAwaitingDelivery",
                          "SHIPPED",
                        ],
                        [
                          "Failed delivery",
                          "failedDeliveryOrders",
                          "FAILED_DELIVERY",
                        ],
                      ].map(([label, key, status], i) => (
                        <Link to={`/orders?status=${status}`} key={key}>
                          <span>
                            <i
                              style={{
                                background: [
                                  "#a1a1aa",
                                  "#71717a",
                                  "#52525b",
                                  "#b91c1c",
                                ][i],
                              }}
                            />
                            {label}
                          </span>
                          <b>
                            {m[key]}
                            <ArrowRight size={13} />
                          </b>
                        </Link>
                      ))}
                    </div>
                    <Link className="pipeline-link" to="/orders">
                      Manage orders
                      <ArrowUpRight size={14} />
                    </Link>
                  </Panel>
                </div>
                {scope === "partnership" && (
                  <Panel
                    title="Partnership contributions"
                    subtitle="Shares use realized product revenue only; shipping is excluded."
                  >
                    <div className="share-bar">
                      <span style={{ width: `${m.tamqoRevenueShare || 50}%` }}>
                        Tamqo {m.tamqoRevenueShare}%
                      </span>
                      <span style={{ width: `${m.logixRevenueShare || 50}%` }}>
                        Logix {m.logixRevenueShare}%
                      </span>
                    </div>
                    <MetricRows
                      metrics={m}
                      keys={[
                        "tamqoUnitsSoldThroughPartnership",
                        "logixUnitsSoldThroughPartnership",
                      ]}
                    />
                  </Panel>
                )}
                <div className="two-columns">
                  <Panel
                    title="Top sources"
                    subtitle="Where your customers find you"
                    action={
                      <button
                        className="text-link"
                        onClick={() => setTab("Sources")}
                      >
                        Details
                        <ArrowRight size={14} />
                      </button>
                    }
                  >
                    <DataTable
                      rows={data.sources.slice(0, 5)}
                      columns={revenueColumns.slice(0, 4)}
                    />
                  </Panel>
                  <Panel
                    title="Best-selling products & plans"
                    subtitle="Realized sales in this period"
                    action={
                      <button
                        className="text-link"
                        onClick={() => setTab("Products & plans")}
                      >
                        Details
                        <ArrowRight size={14} />
                      </button>
                    }
                  >
                    <DataTable
                      rows={data.products.slice(0, 5)}
                      columns={[
                        { key: "name", label: "Product / plan" },
                        { key: "units", label: "Units" },
                        {
                          key: "revenue",
                          label: "Revenue",
                          render: (r) => money(r.revenue),
                        },
                      ]}
                    />
                  </Panel>
                </div>
                <Panel
                  title="Sales at a glance"
                  subtitle="Keep gross sales, realized sales and exceptions distinct."
                >
                  <div className="summary-strip">
                    {[
                      ["Gross sales", "grossSales"],
                      ["Pending value", "pendingSalesValue"],
                      ["Cancelled value", "cancelledOrderValue"],
                      ["Returned value", "returnedOrderValue"],
                      ["Failed delivery value", "failedDeliveryOrderValue"],
                    ].map(([label, key]) => (
                      <div key={key}>
                        <span>{label}</span>
                        <b>{money(m[key])}</b>
                      </div>
                    ))}
                  </div>
                </Panel>
              </>
            )}
            {tab === "Order performance" && (
              <div className="two-columns">
                <Panel title="Orders & conversion">
                  <MetricRows
                    metrics={m}
                    keys={[
                      "totalOrders",
                      "confirmedOrders",
                      "deliveredOrders",
                      "cancelledOrders",
                      "returnedOrders",
                      "pendingOrders",
                      "failedDeliveryOrders",
                      "confirmationRate",
                      "deliverySuccessRate",
                      "cancellationRate",
                      "returnRate",
                      "failedDeliveryRate",
                      "orderCompletionRate",
                      "pendingRate",
                      "ordersCreatedToday",
                    ]}
                  />
                </Panel>
                <Panel title="Order value & volume">
                  <MetricRows
                    metrics={m}
                    keys={[
                      "grossSales",
                      "netSales",
                      "averageOrderValue",
                      "highestOrderValue",
                      "lowestOrderValue",
                      "medianOrderValue",
                      "pendingSalesValue",
                      "cancelledOrderValue",
                      "returnedOrderValue",
                      "failedDeliveryOrderValue",
                    ]}
                    format="money"
                  />
                  <MetricRows
                    metrics={m}
                    keys={[
                      "totalUnitsSold",
                      "totalUnitsOrdered",
                      "averageUnitsPerOrder",
                      "multiUnitOrderRate",
                    ]}
                  />
                </Panel>
              </div>
            )}
            {tab === "Customers" && (
              <>
                <Panel
                  title="Customer relationships"
                  subtitle="Returning customers purchased before this period; repeat customers have multiple scoped orders."
                >
                  <MetricRows
                    metrics={m}
                    keys={[
                      "totalCustomers",
                      "newCustomers",
                      "returningCustomers",
                      "repeatPurchaseRate",
                      "ordersPerCustomer",
                      "repeatOrderInterval",
                    ]}
                  />
                  <MetricRows
                    metrics={m}
                    keys={[
                      "revenuePerCustomer",
                      "customerLifetimeRevenue",
                      "recurringCustomerRevenue",
                    ]}
                    format="money"
                  />
                </Panel>
                <Panel
                  title="Top customers"
                  action={<ViewLink to="/customers" />}
                >
                  <DataTable
                    rows={data.topCustomers}
                    columns={[
                      { key: "name", label: "Customer" },
                      { key: "phone", label: "Phone" },
                      { key: "totalOrders", label: "Period orders" },
                      { key: "lifetimeOrders", label: "Lifetime orders" },
                      {
                        key: "revenue",
                        label: "Period revenue",
                        render: (r) => money(r.revenue),
                      },
                      {
                        key: "customerLifetimeRevenue",
                        label: "Lifetime revenue",
                        render: (r) => money(r.customerLifetimeRevenue),
                      },
                    ]}
                  />
                </Panel>
              </>
            )}
            {tab === "Products & plans" && (
              <>
                <Panel title="Product & plan performance">
                  <DataTable
                    rows={data.products}
                    columns={[
                      { key: "name", label: "Product / plan" },
                      { key: "business", label: "Business" },
                      { key: "units", label: "Units sold" },
                      {
                        key: "revenue",
                        label: "Revenue",
                        render: (r) => money(r.revenue),
                      },
                      {
                        key: "averageSellingPrice",
                        label: "Avg. selling price",
                        render: (r) => money(r.averageSellingPrice),
                      },
                      {
                        key: "revenueShare",
                        label: "Revenue share",
                        render: (r) => `${r.revenueShare}%`,
                      },
                      {
                        key: "unitShare",
                        label: "Unit share",
                        render: (r) => `${r.unitShare}%`,
                      },
                    ]}
                  />
                </Panel>
                <Panel title="Catalog insights">
                  <MetricRows
                    metrics={m}
                    keys={[
                      "mostPopularPlan",
                      "highestRevenuePlan",
                      "mostSoldProduct",
                      "highestRevenueProduct",
                      "renewals",
                      "renewalRate",
                      "averageSubscriptionDuration",
                      "averageQuantityPerOrder",
                      "multiUnitOrderRate",
                    ]}
                  />
                  <MetricRows
                    metrics={m}
                    keys={["renewalRevenue", "recurringCustomerRevenue"]}
                    format="money"
                  />
                </Panel>
              </>
            )}
            {tab === "Sources" && (
              <>
                <Panel title="Acquisition sources">
                  <DataTable
                    rows={data.sources}
                    columns={[
                      ...revenueColumns,
                      { key: "totalUnitsSold", label: "Units" },
                    ]}
                  />
                </Panel>
                <Panel title="Leading sources">
                  <MetricRows
                    metrics={m}
                    keys={[
                      "bestSourceByRevenue",
                      "bestSourceByDeliveryRate",
                      "bestSourceByConfirmationRate",
                    ]}
                  />
                </Panel>
              </>
            )}
            {tab === "Geography" && (
              <>
                <Panel title="Performance by Wilaya">
                  <DataTable
                    rows={data.wilayas}
                    columns={[
                      ...revenueColumns,
                      {
                        key: "deliveryRevenue",
                        label: "Delivery revenue",
                        render: (r) => money(r.deliveryRevenue),
                      },
                    ]}
                  />
                </Panel>
                <Panel title="Performance by Commune">
                  <DataTable rows={data.communes} columns={revenueColumns} />
                </Panel>
                <Panel title="Location insights">
                  <MetricRows
                    metrics={m}
                    keys={["topWilaya", "worstWilayaByFailedDeliveries"]}
                  />
                </Panel>
              </>
            )}
            {tab === "Payments" && (
              <>
                <div className="note">
                  <Info size={16} />
                  Collection and outstanding balances include the whole order
                  and shipping. They cannot be added across business reports.
                </div>
                <Panel title="Revenue by payment method">
                  <DataTable
                    rows={data.payments}
                    columns={revenueColumns.slice(0, 5)}
                  />
                </Panel>
                <Panel title="Payment collection">
                  <MetricRows
                    metrics={m}
                    keys={[
                      "codOrders",
                      "prepaidOrders",
                      "prepaymentRate",
                      "paymentSuccessRate",
                      "outstandingPayments",
                    ]}
                  />
                  <MetricRows
                    metrics={m}
                    keys={[
                      "codRevenue",
                      "prepaidRevenue",
                      "amountCollected",
                      "amountOutstanding",
                    ]}
                    format="money"
                  />
                </Panel>
              </>
            )}
            {tab === "Delivery" && (
              <>
                <div className="note">
                  <Info size={16} />
                  Delivery charges are shown as whole-order context, separate
                  from product sales.
                </div>
                <Panel title="Delivery breakdown">
                  <DataTable
                    rows={data.delivery}
                    columns={revenueColumns.slice(0, 5)}
                  />
                </Panel>
                <Panel title="Delivery charges & preferences">
                  <MetricRows
                    metrics={m}
                    keys={[
                      "homeDeliveryOrders",
                      "deskDeliveryOrders",
                      "homeDeliveryRate",
                      "deskDeliveryRate",
                      "freeDeliveryOrders",
                    ]}
                  />
                  <MetricRows
                    metrics={m}
                    keys={[
                      "totalDeliveryCharged",
                      "averageDeliveryCharge",
                      "deliveryRevenue",
                    ]}
                    format="money"
                  />
                </Panel>
              </>
            )}
            {tab === "Timing" && (
              <Panel
                title="Order lifecycle"
                subtitle="Average hours between recorded transitions; orders without both timestamps are excluded."
              >
                <MetricRows
                  metrics={m}
                  keys={[
                    "averageConfirmationTime",
                    "averageFulfillmentTime",
                    "averageDeliveryTime",
                    "averageOrderLifecycle",
                  ]}
                  format="hours"
                />
                {m.totalOrders > 0 && (
                  <ResponsiveContainer width="100%" height={240}>
                    <BarChart
                      data={[
                        "averageConfirmationTime",
                        "averageFulfillmentTime",
                        "averageDeliveryTime",
                        "averageOrderLifecycle",
                      ].map((k) => ({
                        name: human(
                          k.replace("average", "").replace(/([A-Z])/g, " $1"),
                        ),
                        hours: m[k],
                      }))}
                    >
                      <CartesianGrid vertical={false} stroke="#e4e4e7" />
                      <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                      <YAxis />
                      <Tooltip />
                      <Bar
                        dataKey="hours"
                        fill="#27272a"
                        radius={[4, 4, 0, 0]}
                      />
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </Panel>
            )}
            <button
              className="definition-toggle"
              onClick={() => setDefinitions(!definitions)}
            >
              <Info size={14} />
              {definitions ? "Hide" : "View"} metric definitions
            </button>
            {definitions && (
              <Panel title="How these numbers are calculated">
                <div className="definitions">
                  {Object.entries(data.definitions).map(([key, value]) => (
                    <p key={key}>
                      <b>{human(key.replace(/([A-Z])/g, " $1"))}</b>
                      {value}
                    </p>
                  ))}
                </div>
              </Panel>
            )}
          </>
        )
      )}
    </>
  );
}
