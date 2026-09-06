import { P, Can, hasBusinessAccess, useUser } from "../access";
import { useState } from "react";
import { Link, useParams, Navigate } from "react-router-dom";
import { Plus, Search, ArrowLeft, Receipt, Pencil, Trash2 } from "lucide-react";
import {
  BarChart,
  Bar,
  CartesianGrid,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import {
  api,
  useApi,
  useConfig,
  params,
  money,
  date,
  dateInput,
  human,
} from "../api";
import {
  PageHeader,
  Panel,
  DataTable,
  Pagination,
  Loading,
  ErrorBox,
  Field,
  Modal,
  PeriodFilter,
  Metric,
  Empty,
} from "../components";
export function Expenses() {
  const employees = useApi("/employees"),
    user = useUser();
  const { business } = useParams(),
    { data: config } = useConfig(),
    [filters, setFilters] = useState({
      period: "30d",
      start: dateInput(),
      end: dateInput(),
      search: "",
      page: 1,
      category: "",
      paymentMethod: "",
      sort: "expenseDate",
      direction: "desc",
    }),
    [editing, setEditing] = useState(null),
    [deleting, setDeleting] = useState(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const valid = ["tamqo", "logix"].includes(business),
    upper = business.toUpperCase(),
    result = useApi("/expenses?" + params({ ...filters, business: upper }));
  if (!valid) return <Navigate to="/" replace />;
  if (!hasBusinessAccess(user, upper))
    return (
      <div className="panel modal-body">
        <h2>Business access has not been assigned</h2>
        <p>Ask your administrator to add {upper} to your business access.</p>
      </div>
    );
  const categories = config["expense-categories"].filter(
      (c) => c.business === upper,
    ),
    setFilter = (key, value) =>
      setFilters({ ...filters, [key]: value, page: 1 });
  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api(editing._id ? "/expenses/" + editing._id : "/expenses", {
        method: editing._id ? "PATCH" : "POST",
        body: {
          ...editing,
          date: editing.expenseDate,
          categoryId: editing.categoryId || undefined,
          business: upper,
          amount: Number(editing.amount),
        },
      });
      setEditing(null);
      result.reload();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    setBusy(true);
    try {
      await api("/expenses/" + deleting._id, { method: "DELETE" });
      setDeleting(null);
      result.reload();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  const s = result.data?.summary;
  return (
    <>
      <Link className="back-link" to={`/${business}`}>
        <ArrowLeft size={15} />
        Back to {human(business)}
      </Link>
      <PageHeader
        eyebrow={`${upper} / EXPENSE MANAGER`}
        title="Know where your money goes."
        description={`Track ${human(business)} operating expenses separately from sales.`}
      >
        <Can permission={P.expenses.create}>
          <button
            className="primary"
            onClick={() => {
              setError("");
              setEditing({
                title: "",
                categoryId: categories.find((c) => c.active)?._id || "",
                amount: 0,
                expenseDate: dateInput(),
                paymentMethod: "CASH",
                note: "",
              });
            }}
          >
            <Plus size={16} />
            Add expense
          </button>
        </Can>
      </PageHeader>
      <div className="note">
        <Receipt size={16} />
        Expenses are operating records. They do not change order revenue or
        calculate product margins.
      </div>
      <div className="report-toolbar">
        <PeriodFilter
          value={filters}
          onChange={(v) => setFilters({ ...v, page: 1 })}
        />
      </div>
      {s && (
        <>
          <div className="metrics-grid expense-metrics">
            {[
              ["Total expenses", "totalExpenses", "money"],
              ["This month", "expensesThisMonth", "money"],
              ["Average expense", "averageExpense", "money"],
              ["Expense count", "expenseCount", "number"],
            ].map(([label, key, format]) => (
              <Metric
                key={key}
                label={label}
                value={s[key]}
                format={format}
                change={key === "totalExpenses" ? s.expenseGrowth : undefined}
                caption="Within the selected filters"
              />
            ))}
          </div>
          <div className="two-columns">
            <Panel title="Expenses by employee">
              <DataTable
                rows={s.byEmployee}
                columns={[
                  { key: "name", label: "Added By" },
                  {
                    key: "amount",
                    label: "Amount",
                    render: (r) => money(r.amount),
                  },
                ]}
              />
            </Panel>
            <Panel title="Monthly expenses">
              {s.byMonth.length ? (
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart
                    data={s.byMonth}
                    margin={{ top: 20, right: 20, bottom: 10, left: 10 }}
                  >
                    <CartesianGrid vertical={false} stroke="#eef0ed" />
                    <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                    <YAxis tick={{ fontSize: 11 }} />
                    <Tooltip formatter={(v) => money(v)} />
                    <Bar
                      dataKey="amount"
                      fill="#6c9180"
                      radius={[4, 4, 0, 0]}
                    />
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <Empty title="No expenses in this period" />
              )}
            </Panel>
          </div>
          <div className="summary-strip standalone">
            <div>
              <span>Today in selected range</span>
              <b>{money(s.expensesToday)}</b>
            </div>
            <div>
              <span>This year in selected range</span>
              <b>{money(s.expensesThisYear)}</b>
            </div>
            <div>
              <span>Highest expense</span>
              <b>{money(s.highestExpense)}</b>
            </div>
          </div>
        </>
      )}
      <div className="panel">
        <div className="list-toolbar">
          <div className="search-input">
            <Search size={16} />
            <input
              aria-label="Search expenses"
              placeholder="Search expenses…"
              value={filters.search}
              onChange={(e) => setFilter("search", e.target.value)}
            />
          </div>
          <select
            aria-label="Added By"
            value={filters.addedBy || ""}
            onChange={(e) => setFilter("addedBy", e.target.value)}
          >
            <option value="">Added By: All employees</option>
            {employees.data?.map((u) => (
              <option key={u._id} value={u._id}>
                {u.name}
              </option>
            ))}
          </select>
          <select
            aria-label="Expense category filter"
            value={filters.category}
            onChange={(e) => setFilter("category", e.target.value)}
          >
            <option value="">All categories</option>
            {categories.map((c) => (
              <option key={c._id} value={c._id}>
                {c.name}
              </option>
            ))}
          </select>
          <select
            aria-label="Expense payment filter"
            value={filters.paymentMethod}
            onChange={(e) => setFilter("paymentMethod", e.target.value)}
          >
            <option value="">All payments</option>
            {["CASH", "BANK", "CARD", "ONLINE"].map((p) => (
              <option key={p}>{p}</option>
            ))}
          </select>
          <select
            aria-label="Sort expenses"
            value={filters.sort}
            onChange={(e) => setFilter("sort", e.target.value)}
          >
            <option value="expenseDate">Date</option>
            <option value="amount">Amount</option>
            <option value="title">Title</option>
          </select>
          <button
            onClick={() =>
              setFilter(
                "direction",
                filters.direction === "asc" ? "desc" : "asc",
              )
            }
          >
            {filters.direction === "asc" ? "Ascending" : "Descending"}
          </button>
        </div>
        <ErrorBox error={result.error} />
        {result.loading ? (
          <Loading />
        ) : (
          result.data && (
            <>
              <DataTable
                rows={result.data.items}
                columns={[
                  {
                    key: "title",
                    label: "Expense",
                    render: (e) => <b>{e.title}</b>,
                  },
                  { key: "description", label: "Description" },
                  {
                    key: "createdBy",
                    label: "Added By",
                    render: (e) => e.createdBy?.name || "Legacy / Unknown",
                  },
                  {
                    key: "createdAt",
                    label: "Created At",
                    render: (e) => date(e.createdAt),
                  },
                  {
                    key: "amount",
                    label: "Amount",
                    render: (e) => money(e.amount),
                  },
                  {
                    key: "expenseDate",
                    label: "Date",
                    render: (e) => date(e.expenseDate),
                  },
                  { key: "paymentMethod", label: "Payment" },
                  { key: "note", label: "Note" },
                  {
                    key: "actions",
                    label: "Actions",
                    render: (e) => (
                      <div className="row-actions">
                        <Can permission={P.expenses.update}>
                          <button
                            className="icon-button"
                            title="Edit expense"
                            onClick={() => {
                              setError("");
                              setEditing({
                                ...e,
                                expenseDate: dateInput(e.expenseDate),
                              });
                            }}
                          >
                            <Pencil size={15} />
                          </button>
                        </Can>
                        <Can permission={P.expenses.delete}>
                          <button
                            className="icon-button danger-text"
                            title="Delete expense"
                            onClick={() => {
                              setError("");
                              setDeleting(e);
                            }}
                          >
                            <Trash2 size={15} />
                          </button>
                        </Can>
                      </div>
                    ),
                  },
                ]}
              />
              <Pagination
                {...result.data}
                onChange={(page) => setFilters({ ...filters, page })}
              />
            </>
          )
        )}
      </div>
      {editing && (
        <Modal
          title={editing._id ? "Edit expense" : "Add expense"}
          onClose={() => setEditing(null)}
        >
          <form className="modal-body" onSubmit={submit}>
            <ErrorBox error={error} />
            <Field label="Title">
              <input
                required
                maxLength={200}
                value={editing.title}
                onChange={(e) =>
                  setEditing({ ...editing, title: e.target.value })
                }
              />
            </Field>
            <div className="form-grid flush">
              <Field label="Category">
                <select
                  value={editing.categoryId || ""}
                  onChange={(e) =>
                    setEditing({ ...editing, categoryId: e.target.value })
                  }
                >
                  <option value="">Choose category</option>
                  {categories
                    .filter((c) => c.active || c._id === editing.categoryId)
                    .map((c) => (
                      <option key={c._id} value={c._id}>
                        {c.name}
                      </option>
                    ))}
                </select>
              </Field>
              <Field label="Amount (DA)">
                <input
                  required
                  type="number"
                  min="0"
                  step="0.01"
                  value={editing.amount}
                  onChange={(e) =>
                    setEditing({ ...editing, amount: e.target.value })
                  }
                />
              </Field>
              <Field label="Expense date">
                <input
                  required
                  type="date"
                  value={editing.expenseDate}
                  onChange={(e) =>
                    setEditing({ ...editing, expenseDate: e.target.value })
                  }
                />
              </Field>
              <Field label="Payment method">
                <select
                  value={editing.paymentMethod}
                  onChange={(e) =>
                    setEditing({ ...editing, paymentMethod: e.target.value })
                  }
                >
                  {["CASH", "BANK", "CARD", "ONLINE"].map((p) => (
                    <option key={p}>{p}</option>
                  ))}
                </select>
              </Field>
            </div>
            <Field label="Description">
              <textarea
                value={editing.description || ""}
                onChange={(e) =>
                  setEditing({ ...editing, description: e.target.value })
                }
              />
            </Field>
            <div className="modal-actions">
              <button type="button" onClick={() => setEditing(null)}>
                Cancel
              </button>
              <button className="primary" disabled={busy}>
                {busy ? "Saving…" : "Save expense"}
              </button>
            </div>
          </form>
        </Modal>
      )}
      {deleting && (
        <Modal title="Delete expense?" onClose={() => setDeleting(null)}>
          <div className="modal-body">
            <p>
              <b>{deleting.title}</b> ({money(deleting.amount)}) will be
              permanently removed from expense reporting.
            </p>
            <ErrorBox error={error} />
            <div className="modal-actions">
              <button onClick={() => setDeleting(null)}>Keep expense</button>
              <button className="danger" disabled={busy} onClick={remove}>
                Delete expense
              </button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
