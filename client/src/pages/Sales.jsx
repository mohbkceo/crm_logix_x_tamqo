import { useState } from "react";
import { CircleDollarSign, Pencil, Plus, Search, Trash2 } from "lucide-react";
import { P, Can, can, hasBusinessAccess, useUser } from "../access";
import {
  api,
  date,
  dateInput,
  human,
  money,
  params,
  useApi,
  useConfig,
} from "../api";
import {
  DataTable,
  ErrorBox,
  Field,
  Loading,
  Modal,
  PageHeader,
  Pagination,
  PeriodFilter,
} from "../components";

const businesses = ["LOGIX", "TAMQO"];

export function Sales() {
  const user = useUser();
  const { data: config } = useConfig();
  const employees = useApi("/employees");
  const availableBusinesses = businesses.filter((business) =>
    hasBusinessAccess(user, business),
  );
  const [filters, setFilters] = useState({
    period: "30d",
    start: dateInput(),
    end: dateInput(),
    search: "",
    business: "",
    addedBy: "",
    page: 1,
    sort: "saleDate",
    direction: "desc",
  });
  const [editing, setEditing] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const result = useApi("/sales?" + params(filters));
  const setFilter = (key, value) =>
    setFilters({ ...filters, [key]: value, page: 1 });
  const catalogFor = (business) =>
    business === "LOGIX" ? config?.products || [] : config?.plans || [];
  const owns = (sale) => String(sale.createdBy?.userId) === String(user._id);
  const mayEdit = (sale) =>
    can(user, P.sales.updateAll) ||
    (can(user, P.sales.updateOwn) && owns(sale));
  const mayDelete = (sale) =>
    can(user, P.sales.deleteAll) ||
    (can(user, P.sales.deleteOwn) && owns(sale));

  function addSale() {
    const business = availableBusinesses[0] || "";
    setError("");
    setEditing({
      fullName: "",
      phoneNumber: "",
      address: "",
      amount: "",
      quantity: 1,
      business,
      catalogItemId: "",
      saleDate: dateInput(),
    });
  }

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api(editing._id ? `/sales/${editing._id}` : "/sales", {
        method: editing._id ? "PATCH" : "POST",
        body: {
          fullName: editing.fullName,
          phoneNumber: editing.phoneNumber,
          address: editing.address || "",
          amount: Number(editing.amount),
          quantity: Number(editing.quantity),
          business: editing.business,
          catalogItemId: editing.catalogItemId,
          saleDate: editing.saleDate,
        },
      });
      setEditing(null);
      result.reload();
    } catch (exception) {
      setError(exception.message);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    setError("");
    try {
      await api(`/sales/${deleting._id}`, { method: "DELETE" });
      setDeleting(null);
      result.reload();
    } catch (exception) {
      setError(exception.message);
    } finally {
      setBusy(false);
    }
  }

  if (!availableBusinesses.length)
    return (
      <div className="panel modal-body">
        <h2>Business access has not been assigned</h2>
        <p>Ask your administrator to add Logix or Tamqo business access.</p>
      </div>
    );

  const editingCatalog = editing ? catalogFor(editing.business) : [];
  return (
    <>
      <PageHeader
        eyebrow="DIRECT SALES"
        title="Record sales outside ordering and shipping."
        description="Direct sales contribute to revenue and product performance without creating an order or shipment."
      >
        <Can permission={P.sales.create}>
          <button className="primary" onClick={addSale}>
            <Plus size={16} />
            Add sale
          </button>
        </Can>
      </PageHeader>
      <div className="note">
        <CircleDollarSign size={16} />
        These records are independent of order statuses, couriers, and delivery
        KPIs.
      </div>
      <div className="report-toolbar">
        <PeriodFilter
          value={filters}
          onChange={(value) => setFilters({ ...value, page: 1 })}
        />
      </div>
      <div className="panel">
        <div className="list-toolbar">
          <div className="search-input">
            <Search size={16} />
            <input
              aria-label="Search sales"
              placeholder="Search name, phone, address, or item…"
              value={filters.search}
              onChange={(event) => setFilter("search", event.target.value)}
            />
          </div>
          <select
            aria-label="Sale business filter"
            value={filters.business}
            onChange={(event) => setFilter("business", event.target.value)}
          >
            <option value="">All businesses</option>
            {availableBusinesses.map((business) => (
              <option key={business}>{business}</option>
            ))}
          </select>
          <select
            aria-label="Sale added-by filter"
            value={filters.addedBy}
            onChange={(event) => setFilter("addedBy", event.target.value)}
          >
            <option value="">Added By: All employees</option>
            {employees.data?.map((employee) => (
              <option key={employee._id} value={employee._id}>
                {employee.name}
              </option>
            ))}
          </select>
          <select
            aria-label="Sort sales"
            value={filters.sort}
            onChange={(event) => setFilter("sort", event.target.value)}
          >
            <option value="saleDate">Sale date</option>
            <option value="amount">Amount</option>
            <option value="quantity">Quantity</option>
            <option value="fullName">Full name</option>
            <option value="itemName">Catalog item</option>
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
                    key: "fullName",
                    label: "Customer",
                    render: (sale) => <b>{sale.fullName}</b>,
                  },
                  { key: "phoneNumber", label: "Phone" },
                  { key: "address", label: "Address" },
                  {
                    key: "business",
                    label: "Business",
                    render: (sale) => human(sale.business),
                  },
                  { key: "itemName", label: "Catalog item" },
                  { key: "quantity", label: "Quantity" },
                  {
                    key: "amount",
                    label: "Amount",
                    render: (sale) => money(sale.amount),
                  },
                  {
                    key: "saleDate",
                    label: "Sale date",
                    render: (sale) => date(sale.saleDate),
                  },
                  {
                    key: "createdBy",
                    label: "Added By",
                    render: (sale) =>
                      sale.createdBy?.name || "Legacy / Unknown",
                  },
                  {
                    key: "actions",
                    label: "Actions",
                    render: (sale) => (
                      <div className="row-actions">
                        {mayEdit(sale) && (
                          <button
                            className="icon-button"
                            title="Edit sale"
                            onClick={() => {
                              setError("");
                              setEditing({
                                ...sale,
                                saleDate: dateInput(sale.saleDate),
                              });
                            }}
                          >
                            <Pencil size={15} />
                          </button>
                        )}
                        {mayDelete(sale) && (
                          <button
                            className="icon-button danger-text"
                            title="Delete sale"
                            onClick={() => {
                              setError("");
                              setDeleting(sale);
                            }}
                          >
                            <Trash2 size={15} />
                          </button>
                        )}
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
          title={editing._id ? "Edit sale" : "Add sale"}
          onClose={() => setEditing(null)}
        >
          <form className="modal-body" onSubmit={submit}>
            <ErrorBox error={error} />
            <div className="form-grid flush">
              <Field label="Full name">
                <input
                  required
                  maxLength={150}
                  value={editing.fullName}
                  onChange={(event) =>
                    setEditing({ ...editing, fullName: event.target.value })
                  }
                />
              </Field>
              <Field label="Phone number">
                <input
                  required
                  maxLength={30}
                  value={editing.phoneNumber}
                  onChange={(event) =>
                    setEditing({ ...editing, phoneNumber: event.target.value })
                  }
                />
              </Field>
              <Field label="Business">
                <select
                  required
                  value={editing.business}
                  onChange={(event) =>
                    setEditing({
                      ...editing,
                      business: event.target.value,
                      catalogItemId: "",
                    })
                  }
                >
                  {availableBusinesses.map((business) => (
                    <option key={business}>{business}</option>
                  ))}
                </select>
              </Field>
              <Field
                label={
                  editing.business === "LOGIX" ? "Logix product" : "Tamqo plan"
                }
              >
                <select
                  required
                  value={editing.catalogItemId}
                  onChange={(event) =>
                    setEditing({
                      ...editing,
                      catalogItemId: event.target.value,
                    })
                  }
                >
                  <option value="">Choose catalog item</option>
                  {editingCatalog
                    .filter(
                      (item) =>
                        item.active || item._id === editing.catalogItemId,
                    )
                    .map((item) => (
                      <option key={item._id} value={item._id}>
                        {item.name}
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
                  onChange={(event) =>
                    setEditing({ ...editing, amount: event.target.value })
                  }
                />
              </Field>
              <Field label="Quantity">
                <input
                  required
                  type="number"
                  min="1"
                  step="1"
                  value={editing.quantity}
                  onChange={(event) =>
                    setEditing({ ...editing, quantity: event.target.value })
                  }
                />
              </Field>
              <Field label="Sale date">
                <input
                  required
                  type="date"
                  value={editing.saleDate}
                  onChange={(event) =>
                    setEditing({ ...editing, saleDate: event.target.value })
                  }
                />
              </Field>
            </div>
            <Field label="Address (optional)">
              <textarea
                maxLength={500}
                value={editing.address || ""}
                onChange={(event) =>
                  setEditing({ ...editing, address: event.target.value })
                }
              />
            </Field>
            <div className="modal-actions">
              <button type="button" onClick={() => setEditing(null)}>
                Cancel
              </button>
              <button className="primary" disabled={busy}>
                {busy ? "Saving…" : "Save sale"}
              </button>
            </div>
          </form>
        </Modal>
      )}
      {deleting && (
        <Modal title="Delete sale?" onClose={() => setDeleting(null)}>
          <div className="modal-body">
            <p>
              <b>{deleting.fullName}</b> — {deleting.itemName} (
              {money(deleting.amount)}) will be permanently removed.
            </p>
            <ErrorBox error={error} />
            <div className="modal-actions">
              <button onClick={() => setDeleting(null)}>Keep sale</button>
              <button className="danger" disabled={busy} onClick={remove}>
                Delete sale
              </button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
