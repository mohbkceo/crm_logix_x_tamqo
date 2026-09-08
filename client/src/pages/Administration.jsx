import { useState } from "react";
import { api, useApi, date, params, useConfig, money, human } from "../api";
import { P, can, useUser, Can } from "../access";
import { PERMISSIONS, BUSINESSES } from "../../../shared/permissions.js";
import {
  PageHeader,
  Panel,
  DataTable,
  Field,
  Modal,
  ErrorBox,
  PeriodFilter,
  Pagination,
} from "../components";
function Checks({ values, options, onChange, disabled = false }) {
  return (
    <div className="permission-grid">
      {options.map((v) => (
        <label key={v}>
          <input
            type="checkbox"
            disabled={disabled}
            checked={values.includes(v)}
            onChange={(e) =>
              onChange(
                e.target.checked
                  ? [...values, v]
                  : values.filter((x) => x !== v),
              )
            }
          />
          {v}
        </label>
      ))}
    </div>
  );
}
export function UserManagement() {
  const result = useApi("/users"),
    user = useUser(),
    [editing, setEditing] = useState(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [sessions, setSessions] = useState(null);
  async function save(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const body = { ...editing };
      delete body._id;
      if (editing._id && !body.password) delete body.password;
      if (editing.role === "SUPER_ADMIN") {
        delete body.permissions;
        delete body.businessAccess;
      }
      if (!can(user, P.users.permissions)) {
        delete body.permissions;
        delete body.businessAccess;
      }
      if (editing._id && !can(user, P.users.disable)) delete body.status;
      if (editing._id && !can(user, P.users.update)) {
        delete body.name;
        delete body.email;
        delete body.role;
        delete body.password;
      }
      await api("/users" + (editing._id ? "/" + editing._id : ""), {
        method: editing._id ? "PATCH" : "POST",
        body,
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
        title="Users"
        description="Assign business access and permissions to each person."
      >
        <Can permission={P.users.create}>
          <button
            className="primary"
            onClick={() =>
              setEditing({
                name: "",
                email: "",
                password: "",
                role: "EMPLOYEE",
                status: "ACTIVE",
                businessAccess: [],
                permissions: [],
              })
            }
          >
            Add user
          </button>
        </Can>
      </PageHeader>
      <ErrorBox error={error || result.error} />
      <DataTable
        rows={result.data || []}
        columns={[
          { key: "name", label: "Name" },
          { key: "email", label: "Email" },
          { key: "role", label: "Role" },
          {
            key: "businessAccess",
            label: "Businesses",
            render: (r) =>
              r.role === "SUPER_ADMIN" ? "All" : r.businessAccess.join(", "),
          },
          { key: "status", label: "Status" },
          {
            key: "lastLoginAt",
            label: "Last login",
            render: (r) => date(r.lastLoginAt),
          },
          {
            key: "actions",
            label: "Actions",
            render: (r) => (
              <>
                <Can
                  permission={[
                    P.users.update,
                    P.users.permissions,
                    P.users.disable,
                  ]}
                >
                  <button
                    onClick={() =>
                      setEditing({
                        _id: r._id,
                        name: r.name,
                        email: r.email,
                        role: r.role,
                        status: r.status,
                        businessAccess: r.businessAccess,
                        permissions: r.permissions,
                      })
                    }
                  >
                    Edit
                  </button>
                </Can>
                <Can permission={P["users.sessions"].view}>
                  <button onClick={() => setSessions(r)}>Sessions</button>
                </Can>
              </>
            ),
          },
        ]}
      />
      {sessions && (
        <Modal
          title={"Sessions — " + sessions.name}
          onClose={() => setSessions(null)}
        >
          <SessionList userId={sessions._id} />
        </Modal>
      )}
      {editing && (
        <Modal
          title={editing._id ? "Edit user" : "Add user"}
          onClose={() => setEditing(null)}
        >
          <form className="modal-body" onSubmit={save}>
            <ErrorBox error={error} />
            {["name", "email", "password"].map((k) => (
              <Field key={k} label={human(k)}>
                <input
                  type={
                    k === "password"
                      ? "password"
                      : k === "email"
                        ? "email"
                        : "text"
                  }
                  value={editing[k] || ""}
                  required={k !== "password" || !editing._id}
                  minLength={k === "password" ? 12 : undefined}
                  onChange={(e) =>
                    setEditing({ ...editing, [k]: e.target.value })
                  }
                />
              </Field>
            ))}
            <Field label="Role">
              <select
                value={editing.role}
                disabled={
                  user.role !== "SUPER_ADMIN" || editing.role === "SUPER_ADMIN"
                }
                onChange={(e) =>
                  setEditing({ ...editing, role: e.target.value })
                }
              >
                {(user.role === "SUPER_ADMIN"
                  ? ["SUPER_ADMIN", "ADMIN", "EMPLOYEE"]
                  : ["EMPLOYEE"]
                ).map((r) => (
                  <option key={r}>{r}</option>
                ))}
              </select>
            </Field>
            {editing.role === "SUPER_ADMIN" ? (
              <p>Full system access</p>
            ) : (
              <>
                <Can permission={P.users.disable}>
                  <Field label="Status">
                    <select
                      value={editing.status}
                      onChange={(e) =>
                        setEditing({ ...editing, status: e.target.value })
                      }
                    >
                      <option>ACTIVE</option>
                      <option>DISABLED</option>
                    </select>
                  </Field>
                </Can>
                <h3>Business access</h3>
                <Checks
                  disabled={!can(user, P.users.permissions)}
                  values={editing.businessAccess}
                  options={
                    user.role === "SUPER_ADMIN"
                      ? BUSINESSES
                      : user.businessAccess
                  }
                  onChange={(businessAccess) =>
                    setEditing({ ...editing, businessAccess })
                  }
                />
                <h3>Permissions</h3>
                {[...new Set(PERMISSIONS.map((p) => p.split(".")[0]))].map(
                  (group) => (
                    <fieldset key={group}>
                      <legend>{human(group)}</legend>
                      <Checks
                        disabled={!can(user, P.users.permissions)}
                        values={editing.permissions}
                        options={PERMISSIONS.filter(
                          (p) =>
                            p.startsWith(group + ".") &&
                            (user.role === "SUPER_ADMIN" || can(user, p)),
                        )}
                        onChange={(permissions) =>
                          setEditing({ ...editing, permissions })
                        }
                      />
                    </fieldset>
                  ),
                )}
              </>
            )}
            <button className="primary" disabled={busy}>
              Save user
            </button>
          </form>
        </Modal>
      )}
    </>
  );
}
export function SessionList({ userId }) {
  const user = useUser(),
    path = userId ? `/users/${userId}/sessions` : "/auth/sessions",
    result = useApi(path),
    [error, setError] = useState("");
  async function revoke(id = "") {
    try {
      await api(path + (id ? "/" + id : ""), { method: "DELETE" });
      result.reload();
    } catch (e) {
      setError(e.message);
    }
  }
  const allowed = can(
    user,
    userId ? P["users.sessions"].revoke : P.sessions.revokeOwn,
  );
  return (
    <div className="modal-body">
      <ErrorBox error={error || result.error} />
      {userId && allowed && (
        <button onClick={() => revoke()}>Log out all sessions</button>
      )}
      <DataTable
        rows={result.data || []}
        columns={[
          { key: "ip", label: "IP" },
          { key: "userAgent", label: "Device" },
          {
            key: "lastSeenAt",
            label: "Last seen",
            render: (r) => date(r.lastSeenAt),
          },
          {
            key: "expiresAt",
            label: "Expires",
            render: (r) => date(r.expiresAt),
          },
          {
            key: "action",
            label: "Action",
            render: (r) =>
              allowed && <button onClick={() => revoke(r._id)}>Revoke</button>,
          },
        ]}
      />
    </div>
  );
}
export function RegistrationSettings() {
  const result = useApi("/settings/registration"),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  async function save(e) {
    e.preventDefault();
    const form = e.currentTarget,
      d = new FormData(form),
      body = {
        registrationEnabled: d.get("enabled") === "on",
        registrationKeyExpiresAt: d.get("expires")
          ? new Date(d.get("expires")).toISOString()
          : null,
      };
    if (d.get("key")) body.registrationKey = d.get("key");
    form.reset();
    try {
      await api("/settings/registration", { method: "PATCH", body });
      setMessage("Registration settings saved.");
      result.reload();
    } catch (e) {
      setError(e.message);
    }
  }
  return (
    <>
      <PageHeader title="Registration security" />
      <Panel title="Registration Auth Key">
        <form className="modal-body" onSubmit={save}>
          <ErrorBox error={error || result.error} />
          <p>{message}</p>
          <p>
            Registration{" "}
            {result.data?.registrationEnabled ? "enabled" : "disabled"} · Last
            changed {date(result.data?.registrationKeyUpdatedAt)} ·{" "}
            {result.data?.registrationKeyUpdatedBy?.name || "Not set"}
          </p>
          <label>
            <input
              key={String(result.data?.registrationEnabled)}
              name="enabled"
              type="checkbox"
              defaultChecked={result.data?.registrationEnabled}
            />
            Enable registration
          </label>
          <Field label="Change key">
            <input
              type="password"
              name="key"
              minLength={16}
              maxLength={72}
              autoComplete="new-password"
            />
          </Field>
          <Field label="Expiration (optional)">
            <input name="expires" type="datetime-local" />
          </Field>
          <button className="primary">Save settings</button>
        </form>
      </Panel>
    </>
  );
}
export function AuditView() {
  const [page, setPage] = useState(1),
    result = useApi("/audit?" + params({ page }));
  return (
    <>
      <PageHeader title="Audit log" />
      <ErrorBox error={result.error} />
      <DataTable
        rows={result.data?.items || []}
        columns={[
          { key: "createdAt", label: "Date", render: (r) => date(r.createdAt) },
          { key: "actorName", label: "Actor" },
          { key: "action", label: "Action" },
          { key: "resourceType", label: "Resource" },
          { key: "resourceId", label: "Record" },
          { key: "business", label: "Business" },
        ]}
      />
      {result.data && <Pagination {...result.data} onChange={setPage} />}
    </>
  );
}
export function TeamAnalytics() {
  const [filters, setFilters] = useState({ period: "30d", scope: "ALL" }),
    result = useApi("/analytics/employees?" + params(filters)),
    employees = useApi("/employees"),
    { data: config } = useConfig(),
    [selected, setSelected] = useState("");
  const row = result.data?.items.find((r) => r.userId === selected);
  const metrics = [
    "totalOrders",
    "confirmedOrders",
    "deliveredOrders",
    "cancelledOrders",
    "returnedOrders",
    "pendingOrders",
    "failedDeliveryOrders",
    "grossSales",
    "netSales",
    "totalUnitsSold",
    "directSalesCount",
    "directSalesRevenue",
    "directSalesUnits",
    "averageOrderValue",
    "confirmationRate",
    "deliverySuccessRate",
    "cancellationRate",
    "returnRate",
    "failedDeliveryRate",
  ];
  return (
    <>
      <PageHeader
        title="Employee performance"
        description="Order and direct-sale performance belongs to the employee who created each record."
      />
      <div className="report-toolbar">
        <PeriodFilter value={filters} onChange={setFilters} />
        <select
          value={filters.scope}
          onChange={(e) => setFilters({ ...filters, scope: e.target.value })}
        >
          {["ALL", "LOGIX", "TAMQO", "PARTNERSHIP"].map((v) => (
            <option key={v}>{v}</option>
          ))}
        </select>
        <select
          aria-label="Employee"
          value={filters.employee || ""}
          onChange={(e) => setFilters({ ...filters, employee: e.target.value })}
        >
          <option value="">All employees</option>
          {employees.data?.map((u) => (
            <option key={u._id} value={u._id}>
              {u.name}
            </option>
          ))}
        </select>
        {[
          ["source", "sources"],
          ["wilaya", "wilayas"],
        ].map(([key, collection]) => (
          <select
            key={key}
            aria-label={key}
            value={filters[key] || ""}
            onChange={(e) => setFilters({ ...filters, [key]: e.target.value })}
          >
            <option value="">All {collection}</option>
            {config?.[collection]?.map((o) => (
              <option key={o._id} value={o._id}>
                {o.name}
              </option>
            ))}
          </select>
        ))}
      </div>
      <ErrorBox error={result.error} />
      <DataTable
        rows={result.data?.items || []}
        columns={[
          {
            key: "name",
            label: "Employee",
            render: (r) => (
              <button onClick={() => setSelected(r.userId)}>{r.name}</button>
            ),
          },
          ...metrics.map((key) => ({
            key,
            label: human(key.replace(/([A-Z])/g, " $1")),
            render: (r) => r.metrics[key],
          })),
        ]}
      />
      {row && (
        <>
          <Panel title={row.name + " — activity"}>
            <p>
              Today: {row.ordersToday} · This week: {row.ordersThisWeek} · This
              month: {row.ordersThisMonth}
            </p>
            <p>
              Direct sales — Today: {row.directSalesToday} · This week:{" "}
              {row.directSalesThisWeek} · This month: {row.directSalesThisMonth}
            </p>
            <DataTable
              rows={["tamqo", "logix", "partnership"].map((name) => ({
                name,
                ...row[name],
              }))}
              columns={[
                { key: "name", label: "Business" },
                { key: "totalOrders", label: "Orders" },
                { key: "directSalesCount", label: "Direct sales" },
                {
                  key: "netSales",
                  label: "Revenue",
                  render: (r) => money(r.netSales),
                },
                { key: "totalUnitsSold", label: "Units" },
              ]}
            />
          </Panel>
          {["sources", "wilayas", "products"].map((key) => (
            <Panel key={key} title={human(key)}>
              <DataTable
                rows={row[key]}
                columns={[
                  { key: "name", label: "Name" },
                  { key: "totalOrders", label: "Orders" },
                  {
                    key: "netSales",
                    label: "Revenue",
                    render: (r) => money(r.netSales ?? r.revenue),
                  },
                  {
                    key: "units",
                    label: "Units",
                    render: (r) => r.units ?? r.totalUnitsSold,
                  },
                ]}
              />
            </Panel>
          ))}
        </>
      )}
    </>
  );
}
