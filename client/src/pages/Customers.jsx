import { useState } from "react";
import { Link } from "react-router-dom";
import { Search, ArrowUpRight, Users, Pencil } from "lucide-react";
import { api, useApi, params, money, date } from "../api";
import { Can, P } from "../access";
import {
  PageHeader,
  DataTable,
  Pagination,
  Loading,
  ErrorBox,
  Badge,
  Field,
  Modal,
} from "../components";
function CustomerOrders({ customer, onClose }) {
  const [page, setPage] = useState(1),
    result = useApi("/orders?" + params({ customerId: customer._id, page }));
  return (
    <Modal title={customer.name} onClose={onClose} wide>
      <div className="modal-body">
        <div className="summary-strip">
          <div>
            <span>Normalized phone</span>
            <b>{customer.normalizedPhone}</b>
          </div>
          <div>
            <span>Lifetime revenue</span>
            <b>{money(customer.lifetimeRevenue)}</b>
          </div>
          <div>
            <span>Orders</span>
            <b>{customer.orders || 0}</b>
          </div>
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
                    key: "orderNumber",
                    label: "Order",
                    render: (o) => (
                      <Link className="order-id" to={"/orders/" + o._id}>
                        {o.orderNumber}
                      </Link>
                    ),
                  },
                  {
                    key: "businessType",
                    label: "Business",
                    render: (o) => <Badge>{o.businessType}</Badge>,
                  },
                  {
                    key: "productRevenue",
                    label: "Product value",
                    render: (o) => money(o.productRevenue),
                  },
                  {
                    key: "status",
                    label: "Status",
                    render: (o) => <Badge>{o.status}</Badge>,
                  },
                  {
                    key: "createdAt",
                    label: "Created",
                    render: (o) => date(o.createdAt),
                  },
                ]}
              />
              <Pagination {...result.data} onChange={setPage} />
            </>
          )
        )}
      </div>
    </Modal>
  );
}
export function Customers() {
  const [search, setSearch] = useState(""),
    [page, setPage] = useState(1),
    [selected, setSelected] = useState(null),
    [editing, setEditing] = useState(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    result = useApi("/customers?" + params({ search, page }));
  async function save(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api(`/customers/${editing._id}`, {
        method: "PATCH",
        body: {
          name: editing.name,
          phoneA: editing.phoneA,
          phoneB: editing.phoneB || "",
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
  return (
    <>
      <PageHeader
        eyebrow="WORKSPACE / CUSTOMERS"
        title="People behind the orders."
        description="One customer history, across Tamqo and Logix."
      />
      <div className="note">
        <Users size={16} />
        Algerian phone numbers are normalized so repeat customers keep one
        identity.
      </div>
      <div className="panel">
        <div className="list-toolbar">
          <div className="search-input">
            <Search size={17} />
            <input
              aria-label="Search customers"
              placeholder="Search by name or phone number…"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
            />
          </div>
          <span className="muted">{result.data?.total || 0} customers</span>
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
                    key: "name",
                    label: "Customer",
                    render: (c) => (
                      <div className="customer-cell">
                        <div className="avatar">
                          {c.name.slice(0, 1).toUpperCase()}
                        </div>
                        <div className="cell-stack">
                          <b>{c.name}</b>
                          <span>
                            {c.orders > 1
                              ? "Returning customer"
                              : "New customer"}
                          </span>
                        </div>
                      </div>
                    ),
                  },
                  { key: "phoneA", label: "Phone" },
                  { key: "normalizedPhone", label: "Normalized phone" },
                  { key: "orders", label: "Orders" },
                  {
                    key: "lifetimeRevenue",
                    label: "Lifetime revenue",
                    render: (c) => <b>{money(c.lifetimeRevenue)}</b>,
                  },
                  {
                    key: "firstOrder",
                    label: "First order",
                    render: (c) => date(c.firstOrder),
                  },
                  {
                    key: "lastOrder",
                    label: "Last order",
                    render: (c) => date(c.lastOrder),
                  },
                  {
                    key: "actions",
                    label: "Actions",
                    render: (c) => (
                      <div className="row-actions">
                        <button onClick={() => setSelected(c)}>
                          View orders
                          <ArrowUpRight size={14} />
                        </button>
                        <Can permission={P.customers.update}>
                          <button
                            className="icon-button"
                            title="Edit customer"
                            onClick={() => {
                              setError("");
                              setEditing(c);
                            }}
                          >
                            <Pencil size={14} />
                          </button>
                        </Can>
                      </div>
                    ),
                  },
                ]}
              />
              <Pagination {...result.data} onChange={setPage} />
            </>
          )
        )}
      </div>
      {selected && (
        <CustomerOrders customer={selected} onClose={() => setSelected(null)} />
      )}
      {editing && (
        <Modal title="Edit customer" onClose={() => setEditing(null)}>
          <form className="modal-body" onSubmit={save}>
            <ErrorBox error={error} />
            <Field label="Name">
              <input
                required
                minLength={2}
                maxLength={150}
                value={editing.name}
                onChange={(e) =>
                  setEditing({ ...editing, name: e.target.value })
                }
              />
            </Field>
            <Field label="Primary phone">
              <input
                required
                maxLength={30}
                value={editing.phoneA}
                onChange={(e) =>
                  setEditing({ ...editing, phoneA: e.target.value })
                }
              />
            </Field>
            <Field label="Secondary phone">
              <input
                maxLength={30}
                value={editing.phoneB || ""}
                onChange={(e) =>
                  setEditing({ ...editing, phoneB: e.target.value })
                }
              />
            </Field>
            <p className="muted">
              Existing order snapshots keep their historical customer details.
            </p>
            <div className="modal-actions">
              <button type="button" onClick={() => setEditing(null)}>
                Cancel
              </button>
              <button className="primary" disabled={busy}>
                {busy ? "Saving…" : "Save customer"}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
