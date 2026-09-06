import { useState } from "react";
import { api, useApi, useConfig, money } from "../api";
import { P, can, useUser, Can } from "../access";
import { PageHeader, DataTable, Field, Modal, ErrorBox } from "../components";
export function Agencies() {
  const user = useUser(),
    result = useApi("/delivery-agencies"),
    [editing, setEditing] = useState(null),
    [rates, setRates] = useState(null),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  async function save(e) {
    e.preventDefault();
    setBusy(true);
    const form = e.currentTarget,
      fields = new FormData(form),
      body = { ...editing };
    delete body._id;
    if (fields.get("token") || fields.get("key"))
      body.credentials = { token: fields.get("token"), key: fields.get("key") };
    form.querySelectorAll("input[type=password]").forEach((i) => {
      i.value = "";
    });
    if (editing._id && !can(user, P.deliveryAgencies.assignBusinesses))
      delete body.businesses;
    if (editing._id && !can(user, P.deliveryAgencies.disable))
      delete body.active;
    try {
      await api("/delivery-agencies" + (editing._id ? "/" + editing._id : ""), {
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
  async function test(r) {
    try {
      const data = await api(`/delivery-agencies/${r._id}/test`, {
        method: "POST",
      });
      setMessage(data.message);
    } catch (e) {
      setError(e.message);
    }
  }
  return (
    <>
      <PageHeader
        title="Delivery agencies"
        description="Business assignments, agency rates and protected API credentials."
      >
        <Can permission={P.deliveryAgencies.create}>
          <button
            className="primary"
            onClick={() =>
              setEditing({
                name: "",
                code: "",
                active: true,
                businesses: [],
                integrationType: "MANUAL",
                apiProvider: "MANUAL",
                config: {},
                capabilities: {
                  createShipment: true,
                  tracking: true,
                  readyToShip: true,
                  pricing: true,
                },
              })
            }
          >
            Add agency
          </button>
        </Can>
      </PageHeader>
      <ErrorBox error={error || result.error} />
      {message && <p className="note">{message}</p>}
      <DataTable
        rows={result.data || []}
        columns={[
          { key: "name", label: "Agency" },
          {
            key: "businesses",
            label: "Businesses",
            render: (r) => r.businesses.join(", "),
          },
          { key: "integrationType", label: "Integration" },
          {
            key: "active",
            label: "Status",
            render: (r) => (r.active ? "Active" : "Disabled"),
          },
          {
            key: "credentialsConfigured",
            label: "Connection",
            render: (r) =>
              r.integrationType === "MANUAL"
                ? "Manual"
                : r.credentialsConfigured
                  ? "Credentials configured"
                  : "Not configured",
          },
          {
            key: "actions",
            label: "Actions",
            render: (r) => (
              <>
                <Can permission={P.deliveryAgencies.update}>
                  <button
                    onClick={() =>
                      setEditing({
                        _id: r._id,
                        name: r.name,
                        code: r.code,
                        active: r.active,
                        businesses: r.businesses,
                        integrationType: r.integrationType,
                        apiProvider: r.apiProvider,
                        config: r.config || {},
                        capabilities: r.capabilities,
                      })
                    }
                  >
                    Edit
                  </button>
                </Can>
                <button onClick={() => setRates(r)}>Rates</button>
                <Can permission={P.deliveryAgencies.testConnection}>
                  <button onClick={() => test(r)}>Test connection</button>
                </Can>
                <Can permission={P.deliveryAgencies.disable}>
                  <button
                    onClick={async () => {
                      try {
                        await api("/delivery-agencies/" + r._id, {
                          method: "PATCH",
                          body: { active: !r.active },
                        });
                        result.reload();
                      } catch (e) {
                        setError(e.message);
                      }
                    }}
                  >
                    {r.active ? "Disable" : "Enable"}
                  </button>
                </Can>
              </>
            ),
          },
        ]}
      />
      {editing && (
        <Modal
          title={editing._id ? "Edit agency" : "Add agency"}
          onClose={() => setEditing(null)}
        >
          <form className="modal-body" onSubmit={save}>
            <ErrorBox error={error} />
            {["name", "code"].map((k) => (
              <Field key={k} label={k === "name" ? "Agency name" : "Code"}>
                <input
                  required
                  value={editing[k]}
                  onChange={(e) =>
                    setEditing({ ...editing, [k]: e.target.value })
                  }
                />
              </Field>
            ))}
            <Field label="Businesses">
              <div>
                {["LOGIX", "TAMQO"]
                  .filter(
                    (b) =>
                      user.role === "SUPER_ADMIN" ||
                      user.businessAccess.includes(b),
                  )
                  .map((b) => (
                    <label key={b}>
                      <input
                        type="checkbox"
                        disabled={
                          !can(user, P.deliveryAgencies.assignBusinesses)
                        }
                        checked={editing.businesses.includes(b)}
                        onChange={(e) =>
                          setEditing({
                            ...editing,
                            businesses: e.target.checked
                              ? [...editing.businesses, b]
                              : editing.businesses.filter((x) => x !== b),
                          })
                        }
                      />
                      {b}
                    </label>
                  ))}
              </div>
            </Field>
            <Field label="Integration">
              <select
                value={editing.integrationType}
                onChange={(e) =>
                  setEditing({
                    ...editing,
                    integrationType: e.target.value,
                    apiProvider:
                      e.target.value === "API" ? "PROCOLIS" : "MANUAL",
                    config: {
                      ...editing.config,
                      baseUrl:
                        e.target.value === "API"
                          ? "https://procolis.com/api_v1"
                          : undefined,
                    },
                  })
                }
              >
                <option>MANUAL</option>
                <option>API</option>
              </select>
            </Field>
            {editing.integrationType === "API" && (
              <>
                <p>API provider: PROCOLIS</p>
                <Field label="Base URL">
                  <input
                    value={editing.config.baseUrl || ""}
                    onChange={(e) =>
                      setEditing({
                        ...editing,
                        config: { ...editing.config, baseUrl: e.target.value },
                      })
                    }
                  />
                </Field>
                <Can permission={P.deliveryAgencies.manageCredentials}>
                  <Field label="Replace token">
                    <input
                      type="password"
                      name="token"
                      autoComplete="new-password"
                    />
                  </Field>
                  <Field label="Replace key">
                    <input
                      type="password"
                      name="key"
                      autoComplete="new-password"
                    />
                  </Field>
                </Can>
              </>
            )}
            <Field label="Notes">
              <textarea
                value={editing.config.notes || ""}
                onChange={(e) =>
                  setEditing({
                    ...editing,
                    config: { ...editing.config, notes: e.target.value },
                  })
                }
              />
            </Field>
            <fieldset>
              <legend>Capabilities</legend>
              {Object.keys(editing.capabilities)
                .filter((k) => k !== "_id")
                .map((k) => (
                  <label key={k}>
                    <input
                      type="checkbox"
                      checked={editing.capabilities[k]}
                      onChange={(e) =>
                        setEditing({
                          ...editing,
                          capabilities: {
                            ...editing.capabilities,
                            [k]: e.target.checked,
                          },
                        })
                      }
                    />
                    {k}
                  </label>
                ))}
            </fieldset>
            <button className="primary" disabled={busy}>
              Save agency
            </button>
          </form>
        </Modal>
      )}
      {rates && (
        <Modal title={rates.name + " — rates"} onClose={() => setRates(null)}>
          <AgencyRates agency={rates} />
        </Modal>
      )}
    </>
  );
}
function AgencyRates({ agency }) {
  const result = useApi(`/delivery-agencies/${agency._id}/rates`),
    { data: config } = useConfig(),
    [editing, setEditing] = useState({
      wilayaId: "",
      homePrice: 0,
      deskPrice: 0,
      active: true,
    }),
    [error, setError] = useState("");
  async function save(e) {
    e.preventDefault();
    try {
      await api(
        `/delivery-agencies/${agency._id}/rates` +
          (editing._id ? "/" + editing._id : ""),
        {
          method: editing._id ? "PATCH" : "POST",
          body: {
            ...editing,
            homePrice: Number(editing.homePrice),
            deskPrice: Number(editing.deskPrice),
          },
        },
      );
      setEditing({ wilayaId: "", homePrice: 0, deskPrice: 0, active: true });
      result.reload();
    } catch (e) {
      setError(e.message);
    }
  }
  return (
    <div className="modal-body">
      <ErrorBox error={error || result.error} />
      <DataTable
        rows={result.data || []}
        columns={[
          {
            key: "wilayaId",
            label: "Wilaya",
            render: (r) =>
              config.wilayas.find((w) => w._id === r.wilayaId)?.name ||
              r.wilayaId,
          },
          {
            key: "homePrice",
            label: "Home",
            render: (r) => money(r.homePrice),
          },
          {
            key: "deskPrice",
            label: "Desk",
            render: (r) => money(r.deskPrice),
          },
          {
            key: "active",
            label: "Active",
            render: (r) => (r.active ? "Yes" : "No"),
          },
          {
            key: "action",
            label: "Action",
            render: (r) => (
              <Can permission={P.deliveryAgencies.manageRates}>
                <button onClick={() => setEditing(r)}>Edit</button>
              </Can>
            ),
          },
        ]}
      />
      <Can permission={P.deliveryAgencies.manageRates}>
        <form onSubmit={save}>
          <Field label="Wilaya">
            <select
              required
              value={editing.wilayaId}
              onChange={(e) =>
                setEditing({ ...editing, wilayaId: e.target.value })
              }
            >
              <option value="">Choose Wilaya</option>
              {config.wilayas.map((w) => (
                <option key={w._id} value={w._id}>
                  {w.name}
                </option>
              ))}
            </select>
          </Field>
          {["homePrice", "deskPrice"].map((k) => (
            <Field
              key={k}
              label={k === "homePrice" ? "Home (DA)" : "Desk (DA)"}
            >
              <input
                type="number"
                required
                min="0"
                step="0.01"
                value={editing[k]}
                onChange={(e) =>
                  setEditing({ ...editing, [k]: e.target.value })
                }
              />
            </Field>
          ))}
          <label>
            <input
              type="checkbox"
              checked={editing.active}
              onChange={(e) =>
                setEditing({ ...editing, active: e.target.checked })
              }
            />
            Active
          </label>
          <button className="primary">Save rate</button>
        </form>
      </Can>
    </div>
  );
}
