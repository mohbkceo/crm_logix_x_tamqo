import { useState } from "react";
import { Check, RefreshCw, Radio, Save } from "lucide-react";
import { P, Can } from "../access";
import { api, number, useApi } from "../api";
import { DeliveryWebhookEvents } from "./DeliveryWebhookEvents";
import {
  Badge,
  DataTable,
  ErrorBox,
  Field,
  Loading,
  Metric,
  Modal,
  PageHeader,
  Pagination,
  Panel,
} from "../components";

const dateTime = (value) =>
  value
    ? new Intl.DateTimeFormat("en-GB", {
        dateStyle: "medium",
        timeStyle: "medium",
        timeZone: "Africa/Algiers",
      }).format(new Date(value))
    : "—";
const interval = (ms) => (ms ? `${number(ms / 60000)} minutes` : "Disabled");
const statusTone = (status) =>
  status === "COMPLETED" || status === "SUCCESS"
    ? "delivered"
    : status === "RUNNING"
      ? "shipped"
      : status === "UNCHANGED" || status === "UNKNOWN_STATUS" || status === "SKIPPED"
        ? "confirmed"
        : "failed_delivery";
const skipReasonCounters = [
  ["No shipment", "noShipment"],
  ["No/invalid tracking", "noTracking"],
  ["Missing agency", "missingAgency"],
  ["Manual agency", "manualAgency"],
  ["Tracking disabled", "trackingDisabled"],
];

function RunDetails({ id, onClose }) {
  const detail = useApi(`/delivery-sync/runs/${id}`);
  return (
    <Modal title="Delivery sync run" onClose={onClose} wide>
      <div className="modal-body">
        <ErrorBox error={detail.error} />
        {detail.loading ? (
          <Loading />
        ) : (
          detail.data && (
            <>
              <div className="metric-rows">
                <div>
                  <span>Started</span>
                  <b>{dateTime(detail.data.run.startedAt)}</b>
                </div>
                <div>
                  <span>Status</span>
                  <Badge tone={statusTone(detail.data.run.status)}>
                    {detail.data.run.status}
                  </Badge>
                </div>
              </div>
              <div className="metrics-grid">
                {skipReasonCounters.map(([label, key]) => (
                  <Metric
                    key={key}
                    label={label}
                    value={detail.data.run.skipReasons?.[key] || 0}
                  />
                ))}
              </div>
              <DataTable
                rows={detail.data.items}
                empty="No orders were attempted in this run."
                columns={[
                  { key: "orderNumber", label: "Order Number" },
                  { key: "tracking", label: "Tracking" },
                  { key: "agencyName", label: "Agency" },
                  { key: "provider", label: "Provider" },
                  {
                    key: "providerStatus",
                    label: "Provider Status Before → After",
                    render: (row) =>
                      `${row.beforeProviderStatus || "—"} → ${row.afterProviderStatus || "—"}`,
                  },
                  {
                    key: "orderStatus",
                    label: "CRM Status Before → After",
                    render: (row) =>
                      `${row.beforeOrderStatus || "—"} → ${row.afterOrderStatus || "—"}`,
                  },
                  {
                    key: "result",
                    label: "Result",
                    render: (row) => (
                      <Badge tone={statusTone(row.result)}>
                        {row.result === "UNKNOWN_STATUS"
                          ? "Unmapped provider status"
                          : row.result}
                      </Badge>
                    ),
                  },
                  { key: "error", label: "Error" },
                ]}
              />
            </>
          )
        )}
      </div>
    </Modal>
  );
}

const MIN_INTERVAL_MINUTES = 1,
  MAX_INTERVAL_MINUTES = 1440;

function SyncSettings({ status, onSaved }) {
  const [form, setForm] = useState({
      cronEnabled: Boolean(status.cronEnabled),
      intervalMinutes: String(status.intervalMinutes ?? 15),
      loggingEnabled: Boolean(status.loggingEnabled),
    }),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    minutes = Number(form.intervalMinutes),
    validInterval =
      Number.isInteger(minutes) &&
      minutes >= MIN_INTERVAL_MINUTES &&
      minutes <= MAX_INTERVAL_MINUTES,
    dirty =
      form.cronEnabled !== Boolean(status.cronEnabled) ||
      minutes !== status.intervalMinutes ||
      form.loggingEnabled !== Boolean(status.loggingEnabled);
  async function save(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/delivery-sync/settings", {
        method: "PUT",
        body: {
          cronEnabled: form.cronEnabled,
          intervalMinutes: minutes,
          loggingEnabled: form.loggingEnabled,
        },
      });
      onSaved("Delivery sync settings saved.");
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  }
  return (
    <Panel
      title="Configuration"
      subtitle="Changes apply immediately, without restarting the server."
    >
      <form className="sync-settings" onSubmit={save}>
        <ErrorBox error={error} />
        <label className="switch-field">
          <input
            type="checkbox"
            role="switch"
            className="switch"
            checked={form.cronEnabled}
            onChange={(e) =>
              setForm({ ...form, cronEnabled: e.target.checked })
            }
          />
          <span>
            <b>Cron</b>
            <small>
              {form.cronEnabled
                ? "On — statuses are checked automatically."
                : "Off — manual refresh and the independent webhook inbox remain available."}
            </small>
          </span>
        </label>
        <Field
          label="Interval (minutes)"
          hint={`How often the cron runs. ${MIN_INTERVAL_MINUTES} to ${MAX_INTERVAL_MINUTES} minutes.`}
          error={
            validInterval
              ? ""
              : `Enter a whole number from ${MIN_INTERVAL_MINUTES} to ${MAX_INTERVAL_MINUTES}.`
          }
        >
          <input
            type="number"
            inputMode="numeric"
            min={MIN_INTERVAL_MINUTES}
            max={MAX_INTERVAL_MINUTES}
            step={1}
            disabled={!form.cronEnabled}
            value={form.intervalMinutes}
            onChange={(e) =>
              setForm({ ...form, intervalMinutes: e.target.value })
            }
          />
        </Field>
        <label className="switch-field">
          <input
            type="checkbox"
            role="switch"
            className="switch"
            checked={form.loggingEnabled}
            onChange={(e) =>
              setForm({ ...form, loggingEnabled: e.target.checked })
            }
          />
          <span>
            <b>Logging</b>
            <small>
              {form.loggingEnabled
                ? "On — every run and its orders are saved to the database."
                : "Off — syncs still update orders, but nothing is saved to the run history."}
            </small>
          </span>
        </label>
        <div className="sync-settings-actions">
          <button
            className="primary"
            type="submit"
            disabled={busy || !dirty || !validInterval}
          >
            <Save size={15} />
            {busy ? "Saving…" : "Save settings"}
          </button>
        </div>
      </form>
    </Panel>
  );
}

export function DeliverySyncLogs() {
  const [page, setPage] = useState(1),
    [selected, setSelected] = useState(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    status = useApi("/delivery-sync/status"),
    runs = useApi(`/delivery-sync/runs?page=${page}&limit=20`),
    last = status.data?.lastRun;
  async function runNow() {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const run = await api("/delivery-sync/run", { method: "POST" });
      // A run made while logging is off has no saved details to open.
      if (run.logged === false)
        setMessage(
          `Sync finished: ${number(run.attempted)} attempted, ${number(run.changed)} changed, ${number(run.failed)} failed. Logging is off, so this run was not saved.`,
        );
      else setSelected(run.runId);
      status.reload();
      runs.reload();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  const counters = [
    ["Scanned", "scanned"],
    ["Eligible", "eligible"],
    ["Attempted", "attempted"],
    ["Successful", "successful"],
    ["Changed", "changed"],
    ["Unchanged", "unchanged"],
    ["Terminal reached", "terminalReached"],
    ["Unknown statuses", "unknownStatuses"],
    ["Failed", "failed"],
  ];
  return (
    <>
      <PageHeader
        eyebrow="SETTINGS / DELIVERY"
        title="Delivery Synchronization"
        description="Monitor webhook reception, delivery polling and manual status checks."
      >
        <Can permission={P.deliverySync.run}>
          <button className="primary" disabled={busy} onClick={runNow}>
            <RefreshCw size={15} />
            {busy ? "Syncing…" : "Run Sync Now"}
          </button>
        </Can>
      </PageHeader>
      <ErrorBox error={error || status.error || runs.error} />
      {message && (
        <div className="success">
          <Check size={17} />
          {message}
        </div>
      )}
      <DeliveryWebhookEvents />
      {status.loading ? (
        <Loading />
      ) : (
        <>
          <Panel title="Schedule" action={<Radio size={18} />}>
            <div className="metric-rows">
              <div>
                <span>Cron</span>
                <Badge tone={status.data?.enabled ? "delivered" : "cancelled"}>
                  {status.data?.enabled ? "Enabled" : "Disabled"}
                </Badge>
              </div>
              <div>
                <span>Interval</span>
                <b>{interval(status.data?.intervalMs)}</b>
              </div>
              <div>
                <span>Logging</span>
                <Badge
                  tone={status.data?.loggingEnabled ? "delivered" : "cancelled"}
                >
                  {status.data?.loggingEnabled ? "Enabled" : "Disabled"}
                </Badge>
              </div>
              <div>
                <span>Last run</span>
                <b>{dateTime(last?.startedAt)}</b>
              </div>
              <div>
                <span>Next run</span>
                <b>{dateTime(status.data?.nextRunAt)}</b>
              </div>
              <div>
                <span>Last duration</span>
                <b>{last ? `${number(last.durationMs)} ms` : "—"}</b>
              </div>
            </div>
          </Panel>
          {status.data && (
            <Can permission={P.deliverySync.configure}>
              <SyncSettings
                status={status.data}
                onSaved={(text) => {
                  setError("");
                  setMessage(text);
                  status.reload();
                }}
              />
            </Can>
          )}
          {last && (
            <>
              <div className="metrics-grid">
                {counters.map(([label, key]) => (
                  <Metric key={key} label={label} value={last[key]} />
                ))}
              </div>
              <Panel title="Skip reasons">
                <div className="metrics-grid">
                  {skipReasonCounters.map(([label, key]) => (
                    <Metric
                      key={key}
                      label={label}
                      value={last.skipReasons?.[key] || 0}
                    />
                  ))}
                </div>
              </Panel>
            </>
          )}
        </>
      )}
      <Panel
        title="Run history"
        subtitle="Open a run to inspect affected orders."
      >
        {runs.loading ? (
          <Loading />
        ) : (
          <>
            <DataTable
              rows={runs.data?.items}
              empty={
                status.data && status.data.loggingEnabled === false
                  ? "Logging is off, so new runs are not recorded."
                  : "No delivery sync runs have been recorded yet."
              }
              columns={[
                {
                  key: "startedAt",
                  label: "Started",
                  render: (row) => dateTime(row.startedAt),
                },
                { key: "trigger", label: "Trigger" },
                {
                  key: "status",
                  label: "Status",
                  render: (row) => (
                    <Badge tone={statusTone(row.status)}>{row.status}</Badge>
                  ),
                },
                { key: "attempted", label: "Attempted" },
                { key: "changed", label: "Changed" },
                { key: "unknownStatuses", label: "Unknown" },
                { key: "failed", label: "Failed" },
                {
                  key: "open",
                  label: "Details",
                  render: (row) => (
                    <button onClick={() => setSelected(row._id)}>Open</button>
                  ),
                },
              ]}
            />
            <Pagination
              page={page}
              limit={20}
              total={runs.data?.total || 0}
              onChange={setPage}
            />
          </>
        )}
      </Panel>
      {selected && (
        <RunDetails id={selected} onClose={() => setSelected(null)} />
      )}
    </>
  );
}
