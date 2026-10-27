import { useState } from "react";
import { api, useApi, human } from "../api";
import { P, can, useUser } from "../access";
import {
  PageHeader,
  Panel,
  ErrorBox,
  Field,
  Modal,
  DataTable,
  Loading,
  Pagination,
} from "../components";
import {
  OPERATIONAL_ROLES,
  SEVERITIES,
  SEVERITY_LABELS,
} from "../../../shared/tracking.js";
export function TrackingSettings() {
  const user = useUser(),
    [page, setPage] = useState(1);
  const types = useApi(
    can(user, P["tracking.issueTypes"].manage)
      ? `/tracking/issue-types?includeDisabled=true&page=${page}`
      : null,
  );
  const settings = useApi(
    can(user, P["tracking.settings"].manage) ? "/tracking/settings" : null,
  );
  const [editing, setEditing] = useState(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function saveType(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const {
        _id,
        __v,
        createdAt: _created,
        updatedAt: _updated,
        code: _code,
        ...body
      } = editing;
      await api("/tracking/issue-types" + (_id ? "/" + _id : ""), {
        method: _id ? "PATCH" : "POST",
        body: { ...body, ...(_id ? { expectedRevision: __v } : {}) },
      });
      setEditing(null);
      types.reload();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <PageHeader
        eyebrow="SETTINGS / TRACKING"
        title="Tracking settings"
        description="Issue types, operational roles and employee contact requirements."
      />
      <ErrorBox error={error || types.error || settings.error} />
      {can(user, P["tracking.issueTypes"].manage) && (
        <Panel
          title="Issue Types"
          subtitle="Reports preserve the label and rules used when they were created."
          action={
            <button
              onClick={() =>
                setEditing({
                  label: "",
                  description: "",
                  defaultSeverity: "INFO",
                  blocksProduction: false,
                  responsibleTeam: "",
                  enabled: true,
                  sortOrder: 0,
                  indicator: "INFO",
                })
              }
            >
              Create issue type
            </button>
          }
        >
          {types.loading ? (
            <Loading />
          ) : (
            <>
              <DataTable
                rows={types.data?.items || []}
                columns={[
                  { key: "label", label: "Issue type" },
                  {
                    key: "defaultSeverity",
                    label: "Default severity",
                    render: (t) => SEVERITY_LABELS[t.defaultSeverity],
                  },
                  {
                    key: "blocksProduction",
                    label: "Production",
                    render: (t) =>
                      t.blocksProduction ? "Blocking" : "Informational",
                  },
                  {
                    key: "enabled",
                    label: "Status",
                    render: (t) => (t.enabled ? "Enabled" : "Disabled"),
                  },
                  { key: "sortOrder", label: "Order" },
                  {
                    key: "actions",
                    label: "",
                    render: (t) => (
                      <button
                        onClick={() => {
                          setError("");
                          setEditing(t);
                        }}
                      >
                        Edit
                      </button>
                    ),
                  },
                ]}
              />
              {types.data && <Pagination {...types.data} onChange={setPage} />}
            </>
          )}
        </Panel>
      )}
      {settings.data && (
        <SettingsForm value={settings.data} reload={settings.reload} />
      )}
      {editing && (
        <Modal
          title={editing._id ? "Edit issue type" : "Create issue type"}
          onClose={() => !busy && setEditing(null)}
        >
          <form className="modal-body" onSubmit={saveType}>
            <ErrorBox error={error} />
            <Field label="Label">
              <input
                required
                maxLength={100}
                value={editing.label}
                onChange={(e) =>
                  setEditing({ ...editing, label: e.target.value })
                }
              />
            </Field>
            <Field label="Description">
              <textarea
                rows={2}
                maxLength={500}
                value={editing.description}
                onChange={(e) =>
                  setEditing({ ...editing, description: e.target.value })
                }
              />
            </Field>
            <Field label="Default severity">
              <select
                value={editing.defaultSeverity}
                onChange={(e) =>
                  setEditing({ ...editing, defaultSeverity: e.target.value })
                }
              >
                {SEVERITIES.map((s) => (
                  <option key={s} value={s}>
                    {SEVERITY_LABELS[s]}
                  </option>
                ))}
              </select>
            </Field>
            <label className="tracking-checkbox">
              <input
                type="checkbox"
                checked={editing.blocksProduction}
                onChange={(e) =>
                  setEditing({ ...editing, blocksProduction: e.target.checked })
                }
              />{" "}
              Blocks production until resolved
            </label>
            <Field label="Default responsible team">
              <select
                value={editing.responsibleTeam}
                onChange={(e) =>
                  setEditing({ ...editing, responsibleTeam: e.target.value })
                }
              >
                <option value="">No default team</option>
                {OPERATIONAL_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {human(r)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Visual indicator">
              <select
                value={editing.indicator}
                onChange={(e) =>
                  setEditing({ ...editing, indicator: e.target.value })
                }
              >
                {["INFO", "FLAG", "ATTENTION"].map((v) => (
                  <option key={v}>{v}</option>
                ))}
              </select>
            </Field>
            <Field label="Display order">
              <input
                type="number"
                min={0}
                max={10000}
                required
                value={editing.sortOrder}
                onChange={(e) =>
                  setEditing({ ...editing, sortOrder: Number(e.target.value) })
                }
              />
            </Field>
            <label className="tracking-checkbox">
              <input
                type="checkbox"
                disabled={editing.code === "OTHER"}
                checked={editing.enabled}
                onChange={(e) =>
                  setEditing({ ...editing, enabled: e.target.checked })
                }
              />{" "}
              Enabled
            </label>
            <button className="primary" disabled={busy}>
              Save issue type
            </button>
          </form>
        </Modal>
      )}
    </>
  );
}
function SettingsForm({ value, reload }) {
  const [form, setForm] = useState(value),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const employees = useApi("/tracking/employees?limit=100");
  async function save(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const updated = await api("/tracking/settings", {
        method: "PATCH",
        body: {
          expectedRevision: form.__v || 0,
          requireWhatsApp: form.requireWhatsApp,
          fallbackContactId: form.fallbackContactId || null,
          operationalRoles: form.operationalRoles,
        },
      });
      setForm(updated);
      setMessage("Tracking settings saved");
      reload();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Panel title="Team & contact settings">
      <form className="modal-body" onSubmit={save}>
        <ErrorBox error={error || employees.error} />
        {message && (
          <p className="success" role="status">
            {message}
          </p>
        )}
        <label className="tracking-checkbox">
          <input
            type="checkbox"
            checked={form.requireWhatsApp}
            onChange={(e) =>
              setForm({ ...form, requireWhatsApp: e.target.checked })
            }
          />{" "}
          Require WhatsApp on registration and profile completion
        </label>
        <p>
          Existing employees can continue signing in and complete their profile.
          Public registration only requests an operational role; administrators
          assign access.
        </p>
        <Field label="Fallback operations contact">
          <select
            value={form.fallbackContactId || ""}
            onChange={(e) =>
              setForm({ ...form, fallbackContactId: e.target.value })
            }
          >
            <option value="">No fallback contact</option>
            {employees.data?.map((u) => (
              <option key={u._id} value={u._id}>
                {u.name}
              </option>
            ))}
          </select>
        </Field>
        <fieldset>
          <legend>Operational roles</legend>
          {form.operationalRoles.map((r, index) => (
            <div key={r.code} className="tracking-role-setting">
              <Field label={human(r.code)}>
                <input
                  value={r.label}
                  required
                  maxLength={60}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      operationalRoles: form.operationalRoles.map((v, n) =>
                        n === index ? { ...v, label: e.target.value } : v,
                      ),
                    })
                  }
                />
              </Field>
              <label className="tracking-checkbox">
                <input
                  type="checkbox"
                  checked={r.enabled}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      operationalRoles: form.operationalRoles.map((v, n) =>
                        n === index ? { ...v, enabled: e.target.checked } : v,
                      ),
                    })
                  }
                />{" "}
                Available for assignment
              </label>
            </div>
          ))}
        </fieldset>
        <button className="primary" disabled={busy}>
          Save tracking settings
        </button>
      </form>
    </Panel>
  );
}
export function MyProfile() {
  const profile = useApi("/auth/me"),
    policy = useApi("/auth/profile-policy");
  return (
    <>
      <PageHeader
        title="My profile"
        description="Keep your operational contact details up to date."
      />
      <ErrorBox error={profile.error || policy.error} />
      {profile.data && (
        <ProfileForm
          user={profile.data.user}
          required={policy.data?.requireWhatsApp}
        />
      )}
    </>
  );
}
function ProfileForm({ user, required }) {
  const [revision, setRevision] = useState(user.__v);
  const [phone, setPhone] = useState(user.whatsappPhone || ""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [saved, setSaved] = useState(false);
  return (
    <Panel title={user.name}>
      <form
        className="modal-body"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          try {
            const updated = await api("/auth/profile", {
              method: "PATCH",
              body: { whatsappPhone: phone, expectedRevision: revision },
            });
            setRevision(updated.user.__v);
            setPhone(updated.user.whatsappPhone);
            setSaved(true);
          } catch (e) {
            setError(e.message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <ErrorBox error={error} />
        {saved && (
          <p className="success" role="status">
            Profile saved
          </p>
        )}
        <Field
          label={`WhatsApp phone${required ? " (required)" : " (optional)"}`}
          hint="Algerian mobile (05, 06, 07) or international number beginning with +. Only authorized colleagues can access it."
        >
          <input
            type="tel"
            autoComplete="tel"
            required={required}
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
          />
        </Field>
        <button className="primary" disabled={busy}>
          Save profile
        </button>
      </form>
    </Panel>
  );
}
