import { useEffect, useState } from "react";
import {
  Link,
  useNavigate,
  useLocation,
  useParams,
  useSearchParams,
} from "react-router-dom";
import {
  Plus,
  Search,
  SlidersHorizontal,
  ArrowLeft,
  ArrowRight,
  Package,
  MapPin,
  User,
  Truck,
  CreditCard,
  Check,
  RefreshCw,
  ExternalLink,
  Trash2,
  Save,
  History,
  AlertCircle,
} from "lucide-react";
import {
  api,
  useApi,
  useConfig,
  params,
  money,
  human,
  date,
  dateInput,
} from "../api";
import {
  PageHeader,
  Panel,
  DataTable,
  Pagination,
  Loading,
  ErrorBox,
  Field,
  Badge,
  PeriodFilter,
  Modal,
} from "../components";
import { P, Can, useUser, can, hasBusinessAccess } from "../access";
const statuses = [
  "NEW",
  "CONFIRMED",
  "PREPARING",
  "READY_TO_SHIP",
  "SHIPPED",
  "OUT_FOR_DELIVERY",
  "DELIVERED",
  "FAILED_DELIVERY",
  "RETURNING",
  "RETURNED",
  "CANCELLED",
];
export function Orders() {
  const employees = useApi("/employees");
  const { data: config } = useConfig(),
    [searchParams] = useSearchParams(),
    [filters, setFilters] = useState({
      search: "",
      status: searchParams.get("status") || "",
      page: 1,
    }),
    [advanced, setAdvanced] = useState(false);
  const result = useApi("/orders?" + params(filters));
  const change = (key, value) =>
    setFilters((f) => ({ ...f, [key]: value, page: 1 }));
  return (
    <>
      <PageHeader
        eyebrow="WORKSPACE / ORDERS"
        title="Every order, in one place."
        description="From first message to final delivery. Keep things moving."
      >
        <Can permission={P.orders.create}>
          <Link className="primary" to="/orders/new">
            <Plus size={16} />
            Create order
          </Link>
        </Can>
      </PageHeader>
      <div className="panel">
        <div className="list-toolbar">
          <div className="search-input">
            <Search size={17} />
            <input
              aria-label="Search orders"
              placeholder="Search orders, customers, or phone…"
              value={filters.search}
              onChange={(e) => change("search", e.target.value)}
            />
          </div>
          <select
            aria-label="Business filter"
            value={filters.business || ""}
            onChange={(e) => change("business", e.target.value)}
          >
            <option value="">All businesses</option>
            <option value="TAMQO_ONLY">Tamqo only</option>
            <option value="LOGIX_ONLY">Logix only</option>
            <option value="PARTNERSHIP">Partnership</option>
          </select>
          <select
            aria-label="Order status filter"
            value={filters.status}
            onChange={(e) => change("status", e.target.value)}
          >
            <option value="">All statuses</option>
            {statuses.map((s) => (
              <option key={s} value={s}>
                {human(s)}
              </option>
            ))}
          </select>
          <select
            aria-label="Placed By"
            value={filters.employee || ""}
            onChange={(e) => change("employee", e.target.value)}
          >
            <option value="">Placed By: All employees</option>
            {employees.data?.map((u) => (
              <option key={u._id} value={u._id}>
                {u.name}
              </option>
            ))}
          </select>
          <button onClick={() => setAdvanced(!advanced)}>
            <SlidersHorizontal size={15} />
            More filters
          </button>
        </div>
        {advanced && (
          <div className="filter-grid">
            <Field label="Source">
              <select
                value={filters.source || ""}
                onChange={(e) => change("source", e.target.value)}
              >
                <option value="">All sources</option>
                {config.sources.map((s) => (
                  <option key={s._id} value={s._id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Wilaya">
              <select
                value={filters.wilaya || ""}
                onChange={(e) => change("wilaya", e.target.value)}
              >
                <option value="">All Wilayas</option>
                {config.wilayas.map((s) => (
                  <option key={s._id} value={s._id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Product / plan">
              <select
                value={filters.catalog || ""}
                onChange={(e) => change("catalog", e.target.value)}
              >
                <option value="">All catalog items</option>
                {[...config.plans, ...config.products].map((s) => (
                  <option key={s._id} value={s._id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </Field>
            {[
              ["payment", "Payment", ["COD", "ONLINE", "MIXED"]],
              ["deliveryType", "Delivery", ["HOME", "STOP_DESK"]],
            ].map(([key, label, options]) => (
              <Field label={label} key={key}>
                <select
                  value={filters[key] || ""}
                  onChange={(e) => change(key, e.target.value)}
                >
                  <option value="">All</option>
                  {options.map((o) => (
                    <option value={o} key={o}>
                      {human(o)}
                    </option>
                  ))}
                </select>
              </Field>
            ))}
            {[
              ["commune", "Commune"],
              ["phone", "Phone"],
              ["customer", "Customer"],
              ["tracking", "Tracking"],
            ].map(([key, label]) => (
              <Field label={label} key={key}>
                <input
                  value={filters[key] || ""}
                  onChange={(e) => change(key, e.target.value)}
                />
              </Field>
            ))}
            <Field label="Created date">
              <select
                value={filters.period || ""}
                onChange={(e) =>
                  setFilters({
                    ...filters,
                    period: e.target.value,
                    start: filters.start || dateInput(),
                    end: filters.end || dateInput(),
                    page: 1,
                  })
                }
              >
                <option value="">All time</option>
                <option value="today">Today</option>
                <option value="7d">Last 7 days</option>
                <option value="30d">Last 30 days</option>
                <option value="month">This month</option>
                <option value="year">This year</option>
                <option value="custom">Custom range</option>
              </select>
            </Field>
            {filters.period === "custom" && (
              <>
                <Field label="Start date">
                  <input
                    type="date"
                    value={filters.start}
                    onChange={(e) => change("start", e.target.value)}
                  />
                </Field>
                <Field label="End date">
                  <input
                    type="date"
                    value={filters.end}
                    onChange={(e) => change("end", e.target.value)}
                  />
                </Field>
              </>
            )}
            <button
              onClick={() => setFilters({ search: "", status: "", page: 1 })}
            >
              Clear filters
            </button>
          </div>
        )}
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
                      <Link className="order-id" to={`/orders/${o._id}`}>
                        {o.orderNumber}
                      </Link>
                    ),
                  },
                  {
                    key: "customer",
                    label: "Customer",
                    render: (o) => (
                      <div className="cell-stack">
                        <b>{o.customer.name}</b>
                        <span>{o.customer.phoneA}</span>
                      </div>
                    ),
                  },
                  {
                    key: "businessType",
                    label: "Business",
                    render: (o) => <Badge>{o.businessType}</Badge>,
                  },
                  {
                    key: "items",
                    label: "Products / plans",
                    render: (o) => (
                      <div className="cell-stack">
                        {o.items.map((i, n) => (
                          <span key={n}>
                            {i.quantity} × {i.name}
                          </span>
                        ))}
                      </div>
                    ),
                  },
                  {
                    key: "totalOrderValue",
                    label: "Total",
                    render: (o) => (
                      <b className="nowrap">{money(o.totalOrderValue)}</b>
                    ),
                  },
                  {
                    key: "source",
                    label: "Source",
                    render: (o) => o.source.name,
                  },
                  {
                    key: "location",
                    label: "Wilaya",
                    render: (o) => o.location.wilayaName,
                  },
                  {
                    key: "payment",
                    label: "Payment",
                    render: (o) => <Badge>{o.payment.method}</Badge>,
                  },
                  {
                    key: "placedBy",
                    label: "Placed By",
                    render: (o) => o.createdBy?.name || "Legacy / Unknown",
                  },
                  {
                    key: "delivery",
                    label: "Delivery",
                    render: (o) => human(o.delivery.type),
                  },
                  {
                    key: "status",
                    label: "Status",
                    render: (o) => <Badge>{o.status}</Badge>,
                  },
                  {
                    key: "tracking",
                    label: "Tracking",
                    render: (o) => o.shipment?.tracking || "—",
                  },
                  {
                    key: "createdAt",
                    label: "Created",
                    render: (o) => date(o.createdAt),
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
    </>
  );
}
const blankForm = () => ({
  customer: { name: "", phoneA: "", phoneB: "" },
  location: { wilayaId: "", commune: "", address: "" },
  note: "",
  sourceId: "",
  items: [],
  delivery: { type: "HOME", exchange: false },
  deliveryCharged: 0,
  payment: { method: "COD", amountPaidOnline: 0 },
});
export function OrderForm() {
  const user = useUser();
  const agencies = useApi("/delivery-agencies");
  const [rates, setRates] = useState([]);
  const { id } = useParams(),
    navigate = useNavigate(),
    { data: config } = useConfig(),
    [form, setForm] = useState(blankForm),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [original, setOriginal] = useState(null),
    [editDialog, setEditDialog] = useState(false),
    [providerConfirmed, setProviderConfirmed] = useState(false),
    [loaded, setLoaded] = useState(!id);
  useEffect(() => {
    if (id) {
      let active = true;
      api("/orders/" + id)
        .then((o) => {
          if (!active) return;
          setOriginal(o);
          setForm({ ...o, sourceId: o.source.id });
          setLoaded(true);
        })
        .catch((e) => setError(e.message));
      return () => {
        active = false;
      };
    } else
      setForm((f) => ({
        ...f,
        sourceId:
          config.sources.find((s) => s.active && s.isDefault)?._id || "",
      }));
  }, [id, config]);
  const eligible = (agencies.data || []).filter(
    (a) =>
      (a.active || a._id === form.delivery.agencyId) &&
      form.items.length > 0 &&
      form.items.every((i) => a.businesses.includes(i.business)),
  );
  useEffect(() => {
    let active = true;
    if (!form.delivery.agencyId) {
      setRates([]);
      return;
    }
    api("/delivery-agencies/" + form.delivery.agencyId + "/rates")
      .then((rows) => {
        if (active) setRates(rows);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [form.delivery.agencyId]);
  function set(key, value) {
    setForm((f) => ({ ...f, [key]: value }));
  }
  function shipping(wilayaId, type) {
    const w = rates.find((w) => w.wilayaId === wilayaId && w.active);
    return w ? (type === "HOME" ? w.homePrice : w.deskPrice) : 0;
  }
  function addItem(business) {
    const catalog = (
      business === "TAMQO" ? config.plans : config.products
    ).find((p) => p.active);
    if (!catalog) {
      setError(
        `Add an active ${business === "TAMQO" ? "plan" : "product"} in Settings first.`,
      );
      return;
    }
    setForm((f) => ({
      ...f,
      items: [
        ...f.items,
        {
          business,
          catalogItemId: catalog._id,
          unitPrice: catalog.price,
          quantity: 1,
          isRenewal: false,
        },
      ],
    }));
  }
  function toggleBusiness(business, checked) {
    if (checked) addItem(business);
    else
      set(
        "items",
        form.items.filter((i) => i.business !== business),
      );
  }
  function editItem(index, values) {
    set(
      "items",
      form.items.map((i, n) => (n === index ? { ...i, ...values } : i)),
    );
  }
  const subtotal = (business) =>
      form.items
        .filter((i) => i.business === business)
        .reduce((s, i) => s + Number(i.unitPrice) * Number(i.quantity), 0),
    productTotal = subtotal("TAMQO") + subtotal("LOGIX"),
    total =
      Math.round((productTotal + Number(form.deliveryCharged)) * 100) / 100,
    paid =
      form.payment.method === "ONLINE"
        ? total
        : form.payment.method === "COD"
          ? 0
          : Number(form.payment.amountPaidOnline),
    balance = Math.round((total - paid) * 100) / 100;
  const courierFields = (value, current = false) =>
    JSON.stringify({
      customer: [
        value.customer.name,
        value.customer.phoneA,
        value.customer.phoneB || "",
      ],
      location: [
        current
          ? config.wilayas.find((w) => w._id === value.location.wilayaId)
              ?.agencyId || value.location.agencyId
          : value.location.agencyId,
        value.location.commune,
        value.location.address,
      ],
      source: current
        ? config.sources.find((s) => s._id === value.sourceId)?.name ||
          value.source?.name
        : value.source?.name,
      note: value.note || "",
      delivery: [value.delivery.type, Boolean(value.delivery.exchange)],
      collect: current ? balance : value.payment.amountToCollect,
      products: value.items.map((item) => [
        current
          ? [...config.plans, ...config.products].find(
              (p) => p._id === item.catalogItemId,
            )?.name || item.name
          : item.name,
        item.quantity,
      ]),
    });
  const courierFieldsChanged = Boolean(
    original && courierFields(original) !== courierFields(form, true),
  );
  async function save(body) {
    setError("");
    setBusy(true);
    try {
      const order = await api(id ? `/orders/${id}` : "/orders", {
        method: id ? "PATCH" : "POST",
        body,
      });
      navigate("/orders/" + order._id, {
        state: { shipmentSync: order.shipmentSync },
      });
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function submit(e) {
    e.preventDefault();
    setError("");
    if (!eligible.some((a) => a._id === form.delivery.agencyId)) {
      setError("Select an eligible delivery agency.");
      return;
    }
    if (
      id &&
      original?.shipment &&
      (original.delivery.agencyId !== form.delivery.agencyId ||
        (original.deliveryAgency?.integrationType === "API" &&
          courierFieldsChanged))
    ) {
      setProviderConfirmed(false);
      setEditDialog(true);
      return;
    }
    await save({
      ...form,
      payment: { method: form.payment.method, amountPaidOnline: paid },
    });
  }
  const agencyChange = Boolean(
    original?.shipment && original.delivery.agencyId !== form.delivery.agencyId,
  );
  const manualProviderStep = agencyChange
    ? !original?.deliveryAgency?.capabilities?.deleteShipment ||
      original?.deliveryAgency?.integrationType === "MANUAL"
    : original?.deliveryAgency?.integrationType === "API" &&
      !original?.deliveryAgency?.capabilities?.updateShipment;
  if (!loaded)
    return (
      <>
        <ErrorBox error={error} />
        <Loading />
      </>
    );
  return (
    <>
      <Link className="back-link" to={id ? `/orders/${id}` : "/orders"}>
        <ArrowLeft size={15} />
        Back to {id ? "order" : "orders"}
      </Link>
      <PageHeader
        eyebrow="ORDERS / NEW DETAILS"
        title={id ? "Edit order" : "Create an order"}
        description="Add the customer, choose the products, and we’ll take care of the totals."
      />
      <form onSubmit={submit}>
        <div className="order-form-layout">
          <div>
            <Panel
              title="Customer"
              subtitle="Who are we preparing this order for?"
              action={<User size={18} />}
            >
              <div className="form-grid">
                <Field label="Customer name *">
                  <input
                    required
                    minLength={2}
                    maxLength={150}
                    value={form.customer.name}
                    onChange={(e) =>
                      set("customer", {
                        ...form.customer,
                        name: e.target.value,
                      })
                    }
                    placeholder="Full name"
                  />
                </Field>
                <Field label="Phone A *">
                  <input
                    required
                    type="tel"
                    value={form.customer.phoneA}
                    onChange={(e) =>
                      set("customer", {
                        ...form.customer,
                        phoneA: e.target.value,
                      })
                    }
                    placeholder="0550 00 00 00"
                  />
                </Field>
                <Field label="Phone B">
                  <input
                    type="tel"
                    value={form.customer.phoneB}
                    onChange={(e) =>
                      set("customer", {
                        ...form.customer,
                        phoneB: e.target.value,
                      })
                    }
                    placeholder="Optional second number"
                  />
                </Field>
                <Field label="Wilaya *">
                  <select
                    required
                    value={form.location.wilayaId}
                    onChange={(e) => {
                      set("location", {
                        ...form.location,
                        wilayaId: e.target.value,
                      });
                      set(
                        "deliveryCharged",
                        shipping(e.target.value, form.delivery.type),
                      );
                    }}
                  >
                    <option value="">Choose a Wilaya</option>
                    {config.wilayas
                      .filter(
                        (w) => w.active || w._id === form.location.wilayaId,
                      )
                      .map((w) => (
                        <option key={w._id} value={w._id}>
                          {w.name}
                        </option>
                      ))}
                  </select>
                </Field>
                <Field label="Commune *">
                  <input
                    required
                    value={form.location.commune}
                    onChange={(e) =>
                      set("location", {
                        ...form.location,
                        commune: e.target.value,
                      })
                    }
                    placeholder="Commune"
                  />
                </Field>
                <Field label="Address *">
                  <input
                    required
                    minLength={3}
                    value={form.location.address}
                    onChange={(e) =>
                      set("location", {
                        ...form.location,
                        address: e.target.value,
                      })
                    }
                    placeholder="Street, building, and directions"
                  />
                </Field>
                <div className="span-2">
                  <Field label="Order note">
                    <textarea
                      rows={2}
                      maxLength={2000}
                      value={form.note}
                      onChange={(e) => set("note", e.target.value)}
                      placeholder="Anything the team or courier should know"
                    />
                  </Field>
                </div>
              </div>
            </Panel>
            <Panel
              title="Business & items"
              subtitle="Select both businesses to create a partnership order."
              action={<Package size={18} />}
            >
              <div className="business-selection">
                {["TAMQO", "LOGIX"]
                  .filter((b) => hasBusinessAccess(user, b))
                  .map((b) => (
                    <label
                      key={b}
                      className={
                        form.items.some((i) => i.business === b)
                          ? "checked"
                          : ""
                      }
                    >
                      <input
                        type="checkbox"
                        checked={form.items.some((i) => i.business === b)}
                        onChange={(e) => toggleBusiness(b, e.target.checked)}
                      />
                      <span className={`business-icon ${b.toLowerCase()}`}>
                        {b === "TAMQO" ? "t" : "l"}
                      </span>
                      <div>
                        <strong>{human(b)}</strong>
                        <small>
                          {b === "TAMQO"
                            ? "AI Auto Poster Bot"
                            : "NFC products"}
                        </small>
                      </div>
                    </label>
                  ))}
              </div>
              <div className="form-padding">
                <Field label="Order source *">
                  <select
                    required
                    value={form.sourceId}
                    onChange={(e) => set("sourceId", e.target.value)}
                  >
                    <option value="">Choose source</option>
                    {config.sources
                      .filter((s) => s.active || s._id === form.sourceId)
                      .map((s) => (
                        <option key={s._id} value={s._id}>
                          {s.name}
                        </option>
                      ))}
                  </select>
                </Field>
              </div>
              {["TAMQO", "LOGIX"].map(
                (b) =>
                  form.items.some((i) => i.business === b) && (
                    <div className="item-section" key={b}>
                      <div className="item-section-head">
                        <h3>
                          {human(b)} {b === "TAMQO" ? "plans" : "products"}
                        </h3>
                        <button
                          type="button"
                          className="text-link"
                          onClick={() => addItem(b)}
                        >
                          <Plus size={14} />
                          Add item
                        </button>
                      </div>
                      {form.items.map(
                        (item, index) =>
                          item.business === b && (
                            <div className="item-row" key={index}>
                              <Field label={b === "TAMQO" ? "Plan" : "Product"}>
                                <select
                                  required
                                  value={item.catalogItemId}
                                  onChange={(e) => {
                                    const p = (
                                      b === "TAMQO"
                                        ? config.plans
                                        : config.products
                                    ).find((p) => p._id === e.target.value);
                                    editItem(index, {
                                      catalogItemId: p._id,
                                      unitPrice: p.price,
                                    });
                                  }}
                                >
                                  {(b === "TAMQO"
                                    ? config.plans
                                    : config.products
                                  )
                                    .filter(
                                      (p) =>
                                        p.active ||
                                        p._id === item.catalogItemId,
                                    )
                                    .map((p) => (
                                      <option key={p._id} value={p._id}>
                                        {p.name}
                                      </option>
                                    ))}
                                </select>
                              </Field>
                              <Field label="Unit price (DA)">
                                <input
                                  required
                                  type="number"
                                  min="0"
                                  step="0.01"
                                  value={item.unitPrice}
                                  onChange={(e) =>
                                    editItem(index, {
                                      unitPrice: Number(e.target.value),
                                    })
                                  }
                                />
                              </Field>
                              <Field label="Quantity">
                                <input
                                  required
                                  type="number"
                                  min="1"
                                  max="10000"
                                  step="1"
                                  value={item.quantity}
                                  onChange={(e) =>
                                    editItem(index, {
                                      quantity: Number(e.target.value),
                                    })
                                  }
                                />
                              </Field>
                              <div className="item-subtotal">
                                <small>Subtotal</small>
                                <b>{money(item.unitPrice * item.quantity)}</b>
                              </div>
                              <button
                                type="button"
                                className="icon-button"
                                aria-label={`Remove ${b} item ${index + 1}`}
                                onClick={() =>
                                  set(
                                    "items",
                                    form.items.filter((_, n) => n !== index),
                                  )
                                }
                              >
                                <Trash2 size={15} />
                              </button>
                              {b === "TAMQO" && (
                                <label className="renewal">
                                  <input
                                    type="checkbox"
                                    checked={item.isRenewal || false}
                                    onChange={(e) =>
                                      editItem(index, {
                                        isRenewal: e.target.checked,
                                      })
                                    }
                                  />
                                  Subscription renewal
                                </label>
                              )}
                            </div>
                          ),
                      )}
                    </div>
                  ),
              )}
            </Panel>
            <Panel
              title="Delivery & payment"
              subtitle="Rates depend on the delivery agency, Wilaya and delivery type."
              action={<Truck size={18} />}
            >
              <div className="form-grid">
                <Field label="Delivery agency">
                  <select
                    required
                    value={form.delivery.agencyId || ""}
                    onChange={async (e) => {
                      const agencyId = e.target.value;
                      set("delivery", { ...form.delivery, agencyId });
                      if (agencyId) {
                        try {
                          const rows = await api(
                            "/delivery-agencies/" + agencyId + "/rates",
                          );
                          setRates(rows);
                          const rate = rows.find(
                            (r) =>
                              r.wilayaId === form.location.wilayaId && r.active,
                          );
                          if (rate)
                            set(
                              "deliveryCharged",
                              form.delivery.type === "HOME"
                                ? rate.homePrice
                                : rate.deskPrice,
                            );
                        } catch (e) {
                          setError(e.message);
                        }
                      }
                    }}
                  >
                    <option value="">Choose agency</option>
                    {eligible.map((a) => (
                      <option key={a._id} value={a._id}>
                        {a.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Delivery type">
                  <select
                    value={form.delivery.type}
                    onChange={(e) => {
                      set("delivery", {
                        ...form.delivery,
                        type: e.target.value,
                      });
                      set(
                        "deliveryCharged",
                        shipping(form.location.wilayaId, e.target.value),
                      );
                    }}
                  >
                    <option value="HOME">Home</option>
                    <option value="STOP_DESK">Stop desk</option>
                  </select>
                </Field>
                <Field
                  label="Delivery cost (DA)"
                  hint="You can override the default for this order."
                >
                  <input
                    required
                    type="number"
                    min="0"
                    step="0.01"
                    value={form.deliveryCharged}
                    onChange={(e) =>
                      set("deliveryCharged", Number(e.target.value))
                    }
                  />
                </Field>
                <Field label="Exchange">
                  <select
                    value={String(form.delivery.exchange)}
                    onChange={(e) =>
                      set("delivery", {
                        ...form.delivery,
                        exchange: e.target.value === "true",
                      })
                    }
                  >
                    <option value="false">No</option>
                    <option value="true">Yes</option>
                  </select>
                </Field>
                <Field label="Payment method">
                  <select
                    value={form.payment.method}
                    onChange={(e) =>
                      set("payment", {
                        ...form.payment,
                        method: e.target.value,
                      })
                    }
                  >
                    <option value="COD">COD — cash on delivery</option>
                    <option value="ONLINE">Online — fully prepaid</option>
                    <option value="MIXED">Mixed — partially prepaid</option>
                  </select>
                </Field>
                {form.payment.method === "MIXED" && (
                  <Field label="Amount paid online (DA)">
                    <input
                      required
                      type="number"
                      min="0.01"
                      max={Math.max(0, total - 0.01)}
                      step="0.01"
                      value={form.payment.amountPaidOnline}
                      onChange={(e) =>
                        set("payment", {
                          ...form.payment,
                          amountPaidOnline: Number(e.target.value),
                        })
                      }
                    />
                  </Field>
                )}
              </div>
            </Panel>
          </div>
          <aside className="order-summary">
            <Panel
              title="Order summary"
              subtitle={
                form.items.some((i) => i.business === "TAMQO") &&
                form.items.some((i) => i.business === "LOGIX")
                  ? "Tamqo × Logix partnership"
                  : "Your order at a glance"
              }
            >
              <div className="summary-lines">
                <div>
                  <span>Tamqo</span>
                  <b>{money(subtotal("TAMQO"))}</b>
                </div>
                <div>
                  <span>Logix</span>
                  <b>{money(subtotal("LOGIX"))}</b>
                </div>
                <div>
                  <span>Delivery</span>
                  <b>{money(form.deliveryCharged)}</b>
                </div>
                <div className="summary-total">
                  <span>Total</span>
                  <b>{money(total)}</b>
                </div>
                <div>
                  <span>Paid online</span>
                  <b>{money(paid)}</b>
                </div>
                <div className="collection">
                  <span>Courier to collect</span>
                  <b>{money(balance)}</b>
                </div>
              </div>
              <div className="form-padding">
                <ErrorBox error={error} />
                <button
                  className="primary full"
                  type="submit"
                  disabled={busy || !form.items.length}
                >
                  {busy ? "Saving…" : id ? "Save changes" : "Create order"}
                  <ArrowRight size={16} />
                </button>
                <p className="small-note">
                  {eligible.find((a) => a._id === form.delivery.agencyId)
                    ?.integrationType === "API" &&
                  eligible.find((a) => a._id === form.delivery.agencyId)
                    ?.capabilities?.createShipment
                    ? "Saving this order automatically creates a courier parcel. Tracking or synchronization details will appear on the order."
                    : "Save this order, then handle its shipment manually."}
                </p>
              </div>
            </Panel>
            <div className="note">
              <Check size={17} />
              <span>
                Product prices and source names are saved with this order.
              </span>
            </div>
          </aside>
        </div>
      </form>
      {editDialog && (
        <Modal
          title={
            agencyChange
              ? "Change delivery agency?"
              : "Synchronize courier parcel?"
          }
          onClose={() => setEditDialog(false)}
        >
          <div className="modal-body">
            <p>
              {agencyChange
                ? "The old parcel must be deleted or cancelled at its agency before this order can move to the new agency. A new shipment will then be created or linked."
                : "These order changes may affect the courier parcel."}
            </p>
            {manualProviderStep ? (
              <label className="checkbox-field">
                <input
                  type="checkbox"
                  checked={providerConfirmed}
                  onChange={(e) => setProviderConfirmed(e.target.checked)}
                />
                {agencyChange
                  ? "I marked the old parcel Supprimée at the delivery agency."
                  : "I updated the courier parcel to match this order."}
              </label>
            ) : (
              <p>
                The delivery agency supports automatic synchronization. A
                provider error will be shown on the order.
              </p>
            )}
            <ErrorBox error={error} />
            <div className="modal-actions">
              <button type="button" onClick={() => setEditDialog(false)}>
                Keep editing
              </button>
              <button
                type="button"
                className="primary"
                disabled={busy || (manualProviderStep && !providerConfirmed)}
                onClick={() =>
                  save({
                    ...form,
                    payment: {
                      method: form.payment.method,
                      amountPaidOnline: paid,
                    },
                    providerUpdateConfirmed: !agencyChange && providerConfirmed,
                    providerDeletionConfirmed:
                      agencyChange && providerConfirmed,
                  })
                }
              >
                Save order
              </button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
export function OrderDetails() {
  const user = useUser();
  const location = useLocation();
  const { id } = useParams(),
    navigate = useNavigate(),
    order = useApi("/orders/" + id),
    timeline = useApi(`/orders/${id}/timeline`),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [dialog, setDialog] = useState(""),
    [tracking, setTracking] = useState(""),
    [collected, setCollected] = useState(0),
    [providerCancelled, setProviderCancelled] = useState(false),
    [providerDeleted, setProviderDeleted] = useState(false),
    [deleteReason, setDeleteReason] = useState(""),
    [refundAmount, setRefundAmount] = useState(""),
    [refundNote, setRefundNote] = useState(""),
    [refundAllocation, setRefundAllocation] = useState("WHOLE");
  async function action(path, body = {}) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await api(`/orders/${id}/${path}`, { method: "POST", body });
      setMessage("Order updated.");
      setDialog("");
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
      order.reload();
      timeline.reload();
    }
  }
  async function removeOrder() {
    setBusy(true);
    setError("");
    try {
      await api(`/orders/${id}`, {
        method: "DELETE",
        body: {
          revision: order.data.revision,
          reason: deleteReason,
          providerDeletionConfirmed: providerDeleted,
        },
      });
      navigate("/orders");
    } catch (e) {
      setError(e.message);
      order.reload();
      timeline.reload();
    } finally {
      setBusy(false);
    }
  }
  const o = order.data;
  if (order.loading && !o) return <Loading />;
  if (!o) return <ErrorBox error={order.error} />;
  const s = o.shipment,
    agency = o.deliveryAgency,
    canEdit =
      [
        "NEW",
        "CONFIRMED",
        "PREPARING",
        "READY_TO_SHIP",
        "SHIPPED",
        "OUT_FOR_DELIVERY",
        "FAILED_DELIVERY",
      ].includes(o.status) &&
      !o.deletedAt &&
      (can(user, P.orders.updateAll) ||
        (can(user, P.orders.updateOwn) && o.createdBy?.userId === user._id)),
    canDelete =
      !o.deletedAt &&
      (can(user, P.orders.deleteAll) ||
        (can(user, P.orders.deleteOwn) && o.createdBy?.userId === user._id)),
    canRefund =
      !o.deletedAt &&
      (can(user, P.orders.refundAll) ||
        (can(user, P.orders.refundOwn) && o.createdBy?.userId === user._id)),
    refundable = Math.max(
      0,
      Math.round(
        ((o.payment.amountPaidOnline || 0) +
          (o.payment.amountCollected || 0) -
          (o.refundedAmount || 0)) *
          100,
      ) / 100,
    ),
    manualDeletion = Boolean(
      s &&
      (agency?.integrationType === "MANUAL" ||
        !agency?.capabilities?.deleteShipment),
    );
  return (
    <>
      <Link className="back-link" to="/orders">
        <ArrowLeft size={15} />
        All orders
      </Link>
      <PageHeader
        eyebrow={`CREATED ${date(o.createdAt).toUpperCase()}`}
        title={o.orderNumber}
        description={`${o.customer.name} · ${human(o.businessType)}`}
      >
        <Badge>{o.deletedAt ? "Deleted" : o.status}</Badge>
        {canEdit && <Link to={`/orders/${id}/edit`}>Edit order</Link>}
      </PageHeader>
      <ErrorBox error={error || order.error} />
      {!s && location.state?.shipmentSync?.error && (
        <ErrorBox error={`Order saved. ${location.state.shipmentSync.error}`} />
      )}
      {message && (
        <div className="success" role="status">
          <Check size={16} />
          {message}
        </div>
      )}
      <div className="order-actions">
        {canRefund && (
          <button
            disabled={busy || refundable <= 0}
            onClick={() => {
              setRefundAmount("");
              setRefundNote("");
              setRefundAllocation("WHOLE");
              setDialog("refund");
            }}
          >
            Refund
          </button>
        )}
        {canDelete && (
          <button
            className="danger-text"
            disabled={busy}
            onClick={() => {
              setProviderDeleted(false);
              setDialog("delete");
            }}
          >
            <Trash2 size={15} /> Delete order
          </button>
        )}
        {!o.deletedAt && (
          <>
            {o.allowedStatuses
              .filter(
                (status) =>
                  !["CANCELLED", "READY_TO_SHIP"].includes(status) &&
                  can(
                    user,
                    status === "CONFIRMED"
                      ? P.orders.confirm
                      : P.orders.prepare,
                  ),
              )
              .map((status) => (
                <button
                  key={status}
                  className={status === "CONFIRMED" ? "primary" : ""}
                  disabled={busy}
                  onClick={() =>
                    action(status === "CONFIRMED" ? "confirm" : "status", {
                      status,
                    })
                  }
                >
                  {status === "CONFIRMED"
                    ? "Confirm"
                    : status === "PREPARING"
                      ? "Prepare"
                      : `Mark ${human(status)}`}
                </button>
              ))}
            {can(user, P.orders.markReady) &&
              o.allowedStatuses.includes("READY_TO_SHIP") && (
                <button
                  disabled={busy}
                  onClick={() => action("shipment/ready")}
                >
                  Mark ready to ship
                </button>
              )}
            {(o.status === "NEW"
              ? agency?.integrationType === "API"
              : ["CONFIRMED", "PREPARING", "READY_TO_SHIP"].includes(
                  o.status,
                )) &&
              agency?.capabilities?.createShipment &&
              s?.provider !== "MANUAL" &&
              !s?.uncertain &&
              !s?.tracking &&
              !s?.creationAttemptedAt &&
              can(user, P.orders.createShipment) && (
                <button disabled={busy} onClick={() => action("shipment")}>
                  <Truck size={15} />
                  {s ? "Retry shipment" : "Create shipment"}
                </button>
              )}
            {(s?.tracking || s?.uncertain) &&
              can(user, P.orders.refreshTracking) && (
                <button
                  disabled={busy}
                  onClick={() => action("shipment/refresh")}
                >
                  <RefreshCw size={15} />
                  Refresh tracking
                </button>
              )}
            {o.items.some((i) => i.business === "TAMQO") &&
              !o.tamqoActivatedAt &&
              (can(user, P.orders.updateAll) ||
                (can(user, P.orders.updateOwn) &&
                  o.createdBy?.userId === user._id)) &&
              !["NEW", "CANCELLED", "RETURNED", "RETURNING"].includes(
                o.status,
              ) && (
                <button disabled={busy} onClick={() => action("activate")}>
                  Activate Tamqo
                </button>
              )}
            {can(user, P.orders.cancel) &&
              o.allowedStatuses.includes("CANCELLED") && (
                <button
                  className="danger-text"
                  disabled={busy}
                  onClick={() => setDialog("cancel")}
                >
                  Cancel order
                </button>
              )}
          </>
        )}
      </div>
      <div className="order-form-layout">
        <div>
          <Panel title="Items & revenue" action={<Package size={18} />}>
            <DataTable
              rows={o.items}
              columns={[
                { key: "name", label: "Product / plan" },
                {
                  key: "business",
                  label: "Business",
                  render: (i) => <Badge>{i.business}</Badge>,
                },
                {
                  key: "unitPrice",
                  label: "Unit price",
                  render: (i) => money(i.unitPrice),
                },
                { key: "quantity", label: "Qty" },
                {
                  key: "subtotal",
                  label: "Subtotal",
                  render: (i) => <b>{money(i.subtotal)}</b>,
                },
              ]}
            />
            <div className="summary-strip">
              <div>
                <span>Tamqo revenue</span>
                <b>{money(o.tamqoRevenue)}</b>
              </div>
              <div>
                <span>Logix revenue</span>
                <b>{money(o.logixRevenue)}</b>
              </div>
              <div>
                <span>Product revenue</span>
                <b>{money(o.productRevenue)}</b>
              </div>
            </div>
            {o.tamqoActivatedAt && (
              <div className="note">
                <Check size={16} />
                Tamqo activated on {date(o.tamqoActivatedAt)}
              </div>
            )}
          </Panel>
          <div className="two-columns">
            <Panel title="Customer" action={<User size={17} />}>
              <div className="detail-body">
                <h3>{o.customer.name}</h3>
                <a href={`tel:${o.customer.normalizedPhone}`}>
                  {o.customer.phoneA}
                </a>
                {o.customer.phoneB && <p>{o.customer.phoneB}</p>}
                <small>{o.customer.normalizedPhone}</small>
                <hr />
                <span className="muted">Order source</span>
                <p>{o.source.name}</p>
              </div>
            </Panel>
            <p>
              Placed By: {o.createdBy?.name || "Legacy / Unknown"} · Agency:{" "}
              {o.delivery.agencyName || "Legacy / Unknown"}
            </p>
            <Panel title="Delivery address" action={<MapPin size={17} />}>
              <div className="detail-body">
                <h3>{o.location.wilayaName}</h3>
                <p>{o.location.commune}</p>
                <p>{o.location.address}</p>
                <hr />
                <p>
                  {human(o.delivery.type)} ·{" "}
                  {o.delivery.exchange ? "Exchange" : "Normal parcel"}
                </p>
                {o.note && <p className="note">{o.note}</p>}
              </div>
            </Panel>
          </div>
          <Panel
            title="Courier tracking"
            subtitle={`${o.delivery.agencyName || "Legacy / Unknown"}${s?.provider ? ` / ${s.provider}` : ""}`}
            action={<Truck size={17} />}
          >
            <div className="detail-body">
              {s ? (
                <>
                  <div className="tracking-row">
                    <div>
                      <small>TRACKING NUMBER</small>
                      <h3>{s.tracking || "Not linked yet"}</h3>
                    </div>
                    <Badge>{s.syncStatus}</Badge>
                  </div>
                  <p>
                    External reference: <b>{s.externalId}</b>
                  </p>
                  <p role="status">
                    {s.messageRetour === "Double Tracking" &&
                    s.syncStatus !== "SYNCED"
                      ? "Duplicate tracking found \u2014 reconciling"
                      : s.syncStatus === "ERROR"
                        ? "Shipment synchronization failed"
                        : s.uncertain
                          ? "Shipment awaiting verification"
                          : s.syncStatus === "SYNCED"
                            ? "Shipment synchronized"
                            : "Shipment awaiting verification"}
                  </p>
                  <p>Provider Status: {s.providerStatus || "Not reported"}</p>
                  <p>CRM Status: {s.status ? human(s.status) : "Not mapped"}</p>
                  {s.providerStatus && !s.status && (
                    <Badge tone="confirmed">Unmapped provider status</Badge>
                  )}
                  <p>
                    Provider Situation ID:{" "}
                    {s.providerSituationId || "Not reported"}
                  </p>
                  <p>
                    Last sync:{" "}
                    {s.lastSyncedAt
                      ? new Date(s.lastSyncedAt).toLocaleString("en-GB", {
                          timeZone: "Africa/Algiers",
                        })
                      : "Never"}
                  </p>
                  <ErrorBox error={s.lastError} />
                  {s.uncertain && (
                    <div className="note">
                      <AlertCircle size={17} />
                      Refresh tracking to verify this order with Procolis before
                      retrying creation.
                    </div>
                  )}
                  {!o.deletedAt &&
                    !s.tracking &&
                    (s.provider === "MANUAL" || s.creationAttemptedAt) &&
                    can(user, P.orders.refreshTracking) && (
                      <button
                        disabled={busy}
                        onClick={() => setDialog("reconcile")}
                      >
                        Reconcile shipment
                      </button>
                    )}
                </>
              ) : (
                <>
                  <p>No shipment has been created for this order.</p>
                  <p className="muted">
                    {agency?.integrationType === "API"
                      ? "Use Create shipment to attempt courier synchronization."
                      : "Confirm the order, then create its manual shipment."}
                  </p>
                </>
              )}
            </div>
          </Panel>
          <Panel
            title="Order timeline"
            subtitle="A complete history of this order’s progress."
            action={<History size={18} />}
          >
            <ErrorBox error={timeline.error} />
            <div className="timeline">
              {timeline.data?.map((event) => (
                <div key={event._id}>
                  <i />
                  <div>
                    <b>{event.message}</b>
                    <p>
                      {typeof event.actor === "object"
                        ? event.actor?.name
                        : event.actor ||
                          (event.source === "DELIVERY_PROVIDER"
                            ? "Delivery provider"
                            : "Legacy / Unknown")}{" "}
                      ·{" "}
                      {new Date(event.createdAt).toLocaleString("en-GB", {
                        timeZone: "Africa/Algiers",
                      })}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </Panel>
        </div>
        <aside>
          <Panel title="Payment summary" action={<CreditCard size={18} />}>
            <div className="summary-lines">
              <div>
                <span>Products</span>
                <b>{money(o.productRevenue)}</b>
              </div>
              <div>
                <span>Delivery</span>
                <b>{money(o.deliveryCharged)}</b>
              </div>
              <div className="summary-total">
                <span>Original total</span>
                <b>{money(o.totalOrderValue)}</b>
              </div>
              <div>
                <span>Payment</span>
                <Badge>{o.payment.method}</Badge>
              </div>
              <div>
                <span>Paid online</span>
                <b>{money(o.payment.amountPaidOnline)}</b>
              </div>
              <div>
                <span>Courier to collect</span>
                <b>{money(o.payment.amountToCollect)}</b>
              </div>
              <div>
                <span>Courier collected</span>
                <b>{money(o.payment.amountCollected)}</b>
              </div>
              <div>
                <span>Refunded</span>
                <b>{money(o.refundedAmount || 0)}</b>
              </div>
              <div>
                <span>Net received</span>
                <b>
                  {money(
                    (o.payment.amountPaidOnline || 0) +
                      (o.payment.amountCollected || 0) -
                      (o.refundedAmount || 0),
                  )}
                </b>
              </div>
              <div className="collection">
                <span>Outstanding</span>
                <b>
                  {money(
                    Math.max(
                      0,
                      o.payment.amountToCollect - o.payment.amountCollected,
                    ),
                  )}
                </b>
              </div>
            </div>
            {!o.deletedAt &&
              !["CANCELLED", "RETURNED"].includes(o.status) &&
              (can(user, P.orders.updateAll) ||
                (can(user, P.orders.updateOwn) &&
                  o.createdBy?.userId === user._id)) && (
                <div className="form-padding">
                  <button
                    className="full"
                    onClick={() => {
                      setCollected(o.payment.amountCollected);
                      setDialog("payment");
                    }}
                  >
                    Record courier collection
                  </button>
                </div>
              )}
          </Panel>
        </aside>
      </div>
      {dialog === "refund" && (
        <Modal title="Refund received payment" onClose={() => setDialog("")}>
          <form
            className="modal-body"
            onSubmit={(e) => {
              e.preventDefault();
              action("refund", {
                revision: o.revision,
                amount: Number(refundAmount),
                allocation: refundAllocation,
                note: refundNote,
              });
            }}
          >
            <p>
              Available to refund: <b>{money(refundable)}</b>. The original
              items and order total stay intact.
            </p>
            <Field label="Refund amount (DA)">
              <input
                required
                type="number"
                min="0.01"
                max={refundable}
                step="0.01"
                value={refundAmount}
                onChange={(e) => setRefundAmount(e.target.value)}
              />
            </Field>
            {o.businessType === "PARTNERSHIP" && (
              <Field label="Allocate refund to">
                <select
                  value={refundAllocation}
                  onChange={(e) => setRefundAllocation(e.target.value)}
                >
                  <option value="WHOLE">Whole order (proportional)</option>
                  <option value="LOGIX">Logix</option>
                  <option value="TAMQO">Tamqo</option>
                </select>
              </Field>
            )}
            <Field label="Reason / note (optional)">
              <textarea
                maxLength={2000}
                value={refundNote}
                onChange={(e) => setRefundNote(e.target.value)}
              />
            </Field>
            <ErrorBox error={error} />
            <div className="modal-actions">
              <button type="button" onClick={() => setDialog("")}>
                Keep order
              </button>
              <button
                className="primary"
                disabled={
                  busy ||
                  Number(refundAmount) <= 0 ||
                  Number(refundAmount) > refundable
                }
              >
                Record refund
              </button>
            </div>
          </form>
        </Modal>
      )}
      {dialog === "delete" && (
        <Modal
          title="Delete this order from CRM?"
          onClose={() => setDialog("")}
        >
          <div className="modal-body">
            <p>
              The order will be hidden from normal lists, reports and delivery
              sync. Its record, shipment and audit history remain available to
              administrators.
            </p>
            {s && (
              <div className="note">
                {manualDeletion
                  ? "First mark the parcel Supprimée at the delivery agency. CRM deletion does not delete the agency parcel for you."
                  : "The delivery agency parcel will be deleted first through its supported integration."}
              </div>
            )}
            {manualDeletion && (
              <label className="checkbox-field">
                <input
                  type="checkbox"
                  checked={providerDeleted}
                  onChange={(e) => setProviderDeleted(e.target.checked)}
                />
                I marked the agency parcel Supprimée.
              </label>
            )}
            <Field label="Delete reason (optional)">
              <textarea
                maxLength={2000}
                value={deleteReason}
                onChange={(e) => setDeleteReason(e.target.value)}
              />
            </Field>
            <ErrorBox error={error} />
            <div className="modal-actions">
              <button onClick={() => setDialog("")}>Keep order</button>
              <button
                className="danger"
                disabled={busy || (manualDeletion && !providerDeleted)}
                onClick={removeOrder}
              >
                Delete order
              </button>
            </div>
          </div>
        </Modal>
      )}
      {dialog === "cancel" && (
        <Modal title="Cancel this order?" onClose={() => setDialog("")}>
          <div className="modal-body">
            <p>
              The order and its history will remain available. Cancelling
              removes it from realized sales.
            </p>
            {s?.creationAttemptedAt && (
              <div className="note">
                Cancel this parcel with the delivery agency first. This
                workspace has no documented courier cancellation endpoint.
              </div>
            )}
            <label className="checkbox-field" hidden={!s?.creationAttemptedAt}>
              <input
                type="checkbox"
                checked={providerCancelled}
                onChange={(e) => setProviderCancelled(e.target.checked)}
              />
              I confirmed cancellation with the courier
            </label>
            <ErrorBox error={error} />
            <div className="modal-actions">
              <button onClick={() => setDialog("")}>Keep order</button>
              <button
                className="danger"
                disabled={
                  busy || (s?.creationAttemptedAt && !providerCancelled)
                }
                onClick={() =>
                  action("cancel", {
                    providerCancellationConfirmed: providerCancelled,
                  })
                }
              >
                Cancel order
              </button>
            </div>
          </div>
        </Modal>
      )}
      {dialog === "payment" && (
        <Modal title="Record courier collection" onClose={() => setDialog("")}>
          <form
            className="modal-body"
            onSubmit={(e) => {
              e.preventDefault();
              action("payment", { amountCollected: Number(collected) });
            }}
          >
            <Field label="Total collected by courier (DA)">
              <input
                type="number"
                required
                min="0"
                max={o.payment.amountToCollect}
                step="0.01"
                value={collected}
                onChange={(e) => setCollected(e.target.value)}
              />
            </Field>
            <p className="muted">
              Enter the cumulative collection, not an additional payment.
            </p>
            <ErrorBox error={error} />
            <button className="primary" disabled={busy}>
              Save collection
            </button>
          </form>
        </Modal>
      )}
      {dialog === "reconcile" && (
        <Modal title="Reconcile courier shipment" onClose={() => setDialog("")}>
          <div className="modal-body">
            <p>
              Find <b>{o.orderNumber}</b> as the external reference in your
              courier portal. Link only the parcel belonging to this order.
            </p>
            <Field label="Verified tracking number">
              <input
                value={tracking}
                onChange={(e) => setTracking(e.target.value)}
              />
            </Field>
            <ErrorBox error={error} />
            <div className="modal-actions">
              <button
                disabled={busy || !tracking}
                onClick={() => action("shipment/reconcile", { tracking })}
              >
                Link verified tracking
              </button>
            </div>
            {s?.provider !== "MANUAL" && (
              <>
                <hr />
                <p>
                  If you verified that no parcel exists, unlock one new creation
                  attempt.
                </p>
                <button
                  className="danger-text"
                  disabled={busy}
                  onClick={() =>
                    action("shipment/reconcile", { absentConfirmed: true })
                  }
                >
                  I verified that no parcel exists
                </button>
              </>
            )}
          </div>
        </Modal>
      )}
    </>
  );
}
