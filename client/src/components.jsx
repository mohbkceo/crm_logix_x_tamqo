import { useEffect, useRef, useId, cloneElement } from "react";
import {
  AlertCircle,
  ArrowDownLeft,
  ArrowUpRight,
  Inbox,
  LoaderCircle,
  X,
  ChevronLeft,
  ChevronRight,
  ArrowRight,
} from "lucide-react";
import { Link } from "react-router-dom";
import { money, number, human } from "./api";
export function Badge({ children, tone = "" }) {
  return (
    <span className={`badge ${tone || String(children).toLowerCase()}`}>
      {human(children)}
    </span>
  );
}
export function ErrorBox({ error }) {
  return error ? (
    <div className="error" role="alert">
      <AlertCircle size={17} />
      <span>{error}</span>
    </div>
  ) : null;
}
export function Loading() {
  return (
    <div className="loading" role="status">
      <LoaderCircle size={20} className="spin" />
      Loading workspace data…
    </div>
  );
}
export function Empty({
  title = "Nothing here yet",
  text = "Records will appear here as your business grows.",
  action,
}) {
  return (
    <div className="empty">
      <div className="empty-icon">
        <Inbox size={25} />
      </div>
      <h3>{title}</h3>
      <p>{text}</p>
      {action}
    </div>
  );
}
export function Field({ label, children, hint }) {
  const id = useId();
  return (
    <label className="field">
      <span id={id}>{label}</span>
      {cloneElement(children, {
        "aria-labelledby": id,
        ...(hint ? { "aria-describedby": id + "-hint" } : {}),
      })}
      {hint && <small id={id + "-hint"}>{hint}</small>}
    </label>
  );
}
export function Select({ options, ...props }) {
  return (
    <select {...props}>
      {options.map((o) =>
        typeof o === "string" ? (
          <option key={o} value={o}>
            {human(o)}
          </option>
        ) : (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ),
      )}
    </select>
  );
}
export function PeriodFilter({ value, onChange }) {
  return (
    <div className="period-filter">
      <Select
        aria-label="Reporting period"
        value={value.period}
        onChange={(e) => onChange({ ...value, period: e.target.value })}
        options={[
          { value: "today", label: "Today" },
          { value: "yesterday", label: "Yesterday" },
          { value: "7d", label: "Last 7 days" },
          { value: "30d", label: "Last 30 days" },
          { value: "month", label: "This month" },
          { value: "lastMonth", label: "Last month" },
          { value: "year", label: "This year" },
          { value: "custom", label: "Custom range" },
        ]}
      />
      {value.period === "custom" && (
        <>
          <input
            aria-label="Start date"
            type="date"
            value={value.start || ""}
            onChange={(e) => onChange({ ...value, start: e.target.value })}
          />
          <span>to</span>
          <input
            aria-label="End date"
            type="date"
            value={value.end || ""}
            onChange={(e) => onChange({ ...value, end: e.target.value })}
          />
        </>
      )}
    </div>
  );
}
export function Metric({
  label,
  value,
  format = "number",
  change,
  caption,
  icon: Icon,
}) {
  return (
    <div className="metric">
      <div className="metric-label">
        {label}
        {Icon && <Icon size={16} />}
      </div>
      <div className="metric-value">
        {format === "money"
          ? money(value)
          : format === "percent"
            ? `${number(value)}%`
            : number(value)}
      </div>
      <div className="metric-foot">
        {change !== undefined ? (
          <>
            <span className={`change ${change < 0 ? "negative" : ""}`}>
              {change == null ? (
                "New"
              ) : change < 0 ? (
                <ArrowDownLeft size={12} />
              ) : (
                <ArrowUpRight size={12} />
              )}{" "}
              {change == null ? "" : `${Math.abs(change)}%`}
            </span>
            <span>vs. previous period</span>
          </>
        ) : (
          caption || "Selected reporting period"
        )}
      </div>
    </div>
  );
}
export function Panel({ title, subtitle, children, action, className = "" }) {
  return (
    <section className={`panel ${className}`}>
      <div className="panel-head">
        <div>
          <h2>{title}</h2>
          {subtitle && <p>{subtitle}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}
export function DataTable({
  columns,
  rows,
  empty = "No records match this view.",
  rowKey = "_id",
}) {
  if (!rows?.length)
    return (
      <Empty
        title={empty}
        text="Try another period or add your first record."
      />
    );
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key}>{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={row[rowKey] || i}>
              {columns.map((c) => (
                <td key={c.key}>
                  {c.render ? c.render(row) : (row[c.key] ?? "—")}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
export function Pagination({ page, limit, total, onChange }) {
  return (
    <div className="pagination">
      <span>
        {total
          ? `${(page - 1) * limit + 1}–${Math.min(page * limit, total)} of ${number(total)}`
          : "0 records"}
      </span>
      <div>
        <button
          aria-label="Previous page"
          disabled={page === 1}
          onClick={() => onChange(page - 1)}
        >
          <ChevronLeft size={16} />
        </button>
        <span>
          Page {page} of {Math.max(1, Math.ceil(total / limit))}
        </span>
        <button
          aria-label="Next page"
          disabled={page * limit >= total}
          onClick={() => onChange(page + 1)}
        >
          <ChevronRight size={16} />
        </button>
      </div>
    </div>
  );
}
export function Modal({ title, children, onClose, wide = false }) {
  const dialog = useRef();
  useEffect(() => {
    dialog.current.showModal();
    return () => dialog.current?.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      className={wide ? "wide" : ""}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <header>
        <h2>{title}</h2>
        <button
          className="icon-button"
          aria-label="Close dialog"
          onClick={onClose}
        >
          <X size={20} />
        </button>
      </header>
      {children}
    </dialog>
  );
}
export function PageHeader({ eyebrow, title, description, children }) {
  return (
    <div className="page-heading">
      <div>
        <div className="eyebrow">{eyebrow}</div>
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      <div className="page-actions">{children}</div>
    </div>
  );
}
export function ViewLink({ to, children = "View all" }) {
  return (
    <Link className="text-link" to={to}>
      {children}
      <ArrowRight size={14} />
    </Link>
  );
}
export const revenueColumns = [
  { key: "name", label: "Name" },
  { key: "totalOrders", label: "Orders", render: (r) => number(r.totalOrders) },
  { key: "netSales", label: "Net sales", render: (r) => money(r.netSales) },
  { key: "totalCustomers", label: "Customers" },
  {
    key: "averageOrderValue",
    label: "Avg. order",
    render: (r) => money(r.averageOrderValue),
  },
  {
    key: "confirmationRate",
    label: "Confirmed",
    render: (r) => `${r.confirmationRate}%`,
  },
  {
    key: "deliverySuccessRate",
    label: "Delivered",
    render: (r) => `${r.deliverySuccessRate}%`,
  },
  {
    key: "cancellationRate",
    label: "Cancelled",
    render: (r) => `${r.cancellationRate}%`,
  },
  { key: "returnRate", label: "Returned", render: (r) => `${r.returnRate}%` },
];
