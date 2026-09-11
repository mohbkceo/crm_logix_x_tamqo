import { P, Can, can, useUser } from "../access";
import { useState } from "react";
import { Link } from "react-router-dom";
import {
  Plus,
  Pencil,
  ArrowUp,
  ArrowDown,
  Check,
  ShieldCheck,
  RefreshCw,
  FileSpreadsheet,
  Radio,
} from "lucide-react";
import { api, useApi, useConfig, money, human } from "../api";
import {
  PageHeader,
  Panel,
  DataTable,
  ErrorBox,
  Field,
  Modal,
  Badge,
} from "../components";
const resources = [
  ["plans", "Tamqo plans"],
  ["products", "Logix products"],
  ["sources", "Order sources"],
  ["wilayas", "Wilayas & shipping"],
  ["expense-categories", "Expense categories"],
  ["delivery", "Delivery integration"],
];
export function Settings() {
  const user = useUser();
  const resourcePermissions = {
    plans: P.tamqoPlans.manage,
    products: P.logixProducts.manage,
    sources: P.sources.manage,
    wilayas: P.wilayas.manage,
    "expense-categories": P.settings.manage,
    delivery: P.deliveryAgencies.view,
  };
  const config = useConfig(),
    delivery = useApi("/delivery/status"),
    [tab, setTab] = useState("plans"),
    [editing, setEditing] = useState(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const rows = config.data?.[tab] || [],
    label = resources.find((r) => r[0] === tab)?.[1];
  async function save(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api(`/config/${tab}${editing._id ? "/" + editing._id : ""}`, {
        method: editing._id ? "PATCH" : "POST",
        body: editing,
      });
      setEditing(null);
      config.reload();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function update(row, values) {
    setBusy(true);
    setError("");
    try {
      await api(`/config/${tab}/${row._id}`, { method: "PATCH", body: values });
      config.reload();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function reorder(index, delta) {
    const other = rows[index + delta];
    if (!other) return;
    setBusy(true);
    setError("");
    try {
      const reordered = [...rows];
      [reordered[index], reordered[index + delta]] = [
        reordered[index + delta],
        reordered[index],
      ];
      await api(`/config/${tab}/reorder`, {
        method: "POST",
        body: { ids: reordered.map((r) => r._id) },
      });
      config.reload();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  function create() {
    setError("");
    setEditing({
      name: "",
      active: true,
      sortOrder: rows.length,
      ...(tab === "plans"
        ? { price: 0, durationDays: 30 }
        : tab === "products"
          ? { price: 0 }
          : tab === "sources"
            ? { isDefault: false }
            : tab === "wilayas"
              ? { agencyId: "", homeShippingPrice: 0, deskShippingPrice: 0 }
              : { business: "TAMQO" }),
    });
  }
  async function test(path) {
    setBusy(true);
    setMessage("");
    setError("");
    try {
      const result = await api("/delivery/" + path, { method: "POST" });
      setMessage(
        result.message ||
          `Synchronized ${result.synced} shipments; ${result.errors} errors.`,
      );
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <PageHeader
        eyebrow="WORKSPACE / SETTINGS"
        title="Make it work your way."
        description="Manage your catalog, shipping prices, sources, and expense categories."
      />
      <div className="tabs">
        {resources
          .filter(([key]) => can(user, resourcePermissions[key]))
          .map(([key, label]) => (
            <button
              key={key}
              className={key === tab ? "active" : ""}
              onClick={() => {
                setTab(key);
                setError("");
                setMessage("");
              }}
            >
              {label}
            </button>
          ))}
        {can(user, P.imports.view) && (
          <Link to="/settings/import-data">
            <FileSpreadsheet size={15} /> Import data
          </Link>
        )}
        {can(user, P.deliverySync.view) && (
          <Link to="/settings/delivery-sync">
            <Radio size={15} /> Delivery Sync Logs
          </Link>
        )}
      </div>
      <ErrorBox error={error} />
      {message && (
        <div className="success">
          <Check size={17} />
          {message}
        </div>
      )}
      {tab !== "delivery" ? (
        <Panel
          title={label}
          subtitle={
            tab === "sources"
              ? "Exactly one active source is the default for new orders."
              : "Changes apply to new orders. Existing order snapshots stay intact."
          }
          action={
            <Can permission={resourcePermissions[tab]}>
              <button className="primary" onClick={create}>
                <Plus size={15} />
                Add{" "}
                {tab === "plans"
                  ? "plan"
                  : tab === "products"
                    ? "product"
                    : tab === "sources"
                      ? "source"
                      : tab === "wilayas"
                        ? "Wilaya"
                        : "category"}
              </button>
            </Can>
          }
        >
          <DataTable
            rows={rows}
            columns={[
              { key: "name", label: "Name", render: (r) => <b>{r.name}</b> },
              ...(["plans", "products"].includes(tab)
                ? [
                    {
                      key: "price",
                      label: "Price",
                      render: (r) => money(r.price),
                    },
                  ]
                : []),
              ...(tab === "plans"
                ? [
                    {
                      key: "durationDays",
                      label: "Duration",
                      render: (r) => `${r.durationDays} days`,
                    },
                  ]
                : []),
              ...(tab === "sources"
                ? [
                    {
                      key: "isDefault",
                      label: "Default source",
                      render: (r) =>
                        r.isDefault ? (
                          <Badge tone="delivered">Default</Badge>
                        ) : (
                          <button
                            disabled={busy || !r.active}
                            onClick={() => update(r, { isDefault: true })}
                          >
                            Make default
                          </button>
                        ),
                    },
                  ]
                : []),
              ...(tab === "wilayas"
                ? [
                    { key: "agencyId", label: "Agency ID" },
                    {
                      key: "homeShippingPrice",
                      label: "Home shipping",
                      render: (r) => money(r.homeShippingPrice),
                    },
                    {
                      key: "deskShippingPrice",
                      label: "Stop desk shipping",
                      render: (r) => money(r.deskShippingPrice),
                    },
                  ]
                : []),
              ...(tab === "expense-categories"
                ? [
                    {
                      key: "business",
                      label: "Business",
                      render: (r) => <Badge>{r.business}</Badge>,
                    },
                  ]
                : []),
              {
                key: "active",
                label: "Status",
                render: (r) => (
                  <Badge tone={r.active ? "delivered" : "cancelled"}>
                    {r.active ? "Active" : "Disabled"}
                  </Badge>
                ),
              },
              {
                key: "actions",
                label: "Manage",
                render: (r) => (
                  <div className="row-actions">
                    {tab !== "wilayas" && (
                      <>
                        <button
                          disabled={busy || rows.indexOf(r) === 0}
                          className="icon-button"
                          title="Move up"
                          onClick={() => reorder(rows.indexOf(r), -1)}
                        >
                          <ArrowUp size={14} />
                        </button>
                        <button
                          disabled={busy || rows.indexOf(r) === rows.length - 1}
                          className="icon-button"
                          title="Move down"
                          onClick={() => reorder(rows.indexOf(r), 1)}
                        >
                          <ArrowDown size={14} />
                        </button>
                      </>
                    )}
                    <button
                      className="icon-button"
                      title="Edit configuration"
                      onClick={() => {
                        setError("");
                        setEditing({ ...r });
                      }}
                    >
                      <Pencil size={15} />
                    </button>
                    <button
                      disabled={busy || r.isDefault}
                      onClick={() => update(r, { active: !r.active })}
                    >
                      {r.active ? "Disable" : "Enable"}
                    </button>
                  </div>
                ),
              },
            ]}
          />
        </Panel>
      ) : (
        <Panel
          title="ABEX / Procolis"
          subtitle="Delivery requests run securely through your server."
          action={<ShieldCheck size={20} />}
        >
          <div className="detail-body">
            <div className="integration-status">
              <span>Server credentials</span>
              <Badge
                tone={
                  delivery.data?.configured ? "delivered" : "failed_delivery"
                }
              >
                {delivery.data?.configured ? "Configured" : "Not configured"}
              </Badge>
            </div>
            <div className="integration-status">
              <span>Provider status mapping</span>
              <Badge>
                {delivery.data?.statusMappingConfigured
                  ? "Configured"
                  : "Unverified"}
              </Badge>
            </div>
            <p>
              Set courier credentials in the server environment. The browser
              never receives the token or API key.
            </p>
            <p>
              Procolis credentials are valid only when GET /token returns the
              activated access status. Unknown parcel status values are kept for
              review without changing the CRM order status.
            </p>
            <ErrorBox error={delivery.error} />
            <div className="row-actions">
              <button
                disabled={busy || !delivery.data?.configured}
                onClick={() => test("test")}
              >
                <ShieldCheck size={15} />
                Test connection
              </button>
              <Can permission={P.deliverySync.run}>
                <button
                  disabled={busy || !delivery.data?.configured}
                  onClick={() => test("sync")}
                >
                  <RefreshCw size={15} />
                  Sync active shipments
                </button>
              </Can>
            </div>
          </div>
        </Panel>
      )}
      {editing && (
        <Modal
          title={`${editing._id ? "Edit" : "Add"} ${label.toLowerCase()}`}
          onClose={() => setEditing(null)}
        >
          <form className="modal-body" onSubmit={save}>
            <ErrorBox error={error} />
            <Field label="Name">
              <input
                required
                maxLength={100}
                value={editing.name}
                onChange={(e) =>
                  setEditing({ ...editing, name: e.target.value })
                }
              />
            </Field>
            {["price", "durationDays", "homeShippingPrice", "deskShippingPrice"]
              .filter((key) => key in editing)
              .map((key) => (
                <Field
                  label={
                    human(key.replace(/([A-Z])/g, " $1")) +
                    (key === "durationDays" ? "" : " (DA)")
                  }
                  key={key}
                >
                  <input
                    type="number"
                    min={key === "durationDays" ? 1 : 0}
                    step={key === "durationDays" ? 1 : 0.01}
                    required
                    value={editing[key]}
                    onChange={(e) =>
                      setEditing({ ...editing, [key]: Number(e.target.value) })
                    }
                  />
                </Field>
              ))}
            {tab === "wilayas" && (
              <Field label="Delivery agency Wilaya ID">
                <input
                  required
                  pattern="[0-9]{1,3}"
                  value={editing.agencyId}
                  onChange={(e) =>
                    setEditing({ ...editing, agencyId: e.target.value })
                  }
                />
              </Field>
            )}
            {tab === "expense-categories" && (
              <Field label="Business">
                <select
                  value={editing.business}
                  onChange={(e) =>
                    setEditing({ ...editing, business: e.target.value })
                  }
                >
                  <option>TAMQO</option>
                  <option>LOGIX</option>
                </select>
              </Field>
            )}
            <label className="checkbox-field">
              <input
                type="checkbox"
                checked={editing.active}
                onChange={(e) =>
                  setEditing({ ...editing, active: e.target.checked })
                }
              />
              Active
            </label>
            {tab === "sources" && (
              <label className="checkbox-field">
                <input
                  type="checkbox"
                  checked={editing.isDefault}
                  onChange={(e) =>
                    setEditing({ ...editing, isDefault: e.target.checked })
                  }
                />
                Default source
              </label>
            )}
            <div className="modal-actions">
              <button type="button" onClick={() => setEditing(null)}>
                Cancel
              </button>
              <button className="primary" disabled={busy}>
                {busy ? "Saving…" : "Save changes"}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
