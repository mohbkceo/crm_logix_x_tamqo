import { useState } from "react";
import { RefreshCw, Radio } from "lucide-react";
import { P, Can } from "../access";
import { api, number, useApi } from "../api";
import {
  Badge,
  DataTable,
  ErrorBox,
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
      : status === "UNCHANGED" || status === "UNKNOWN_STATUS"
        ? "confirmed"
        : "failed_delivery";

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
              <DataTable
                rows={detail.data.items}
                empty="No orders were attempted in this run."
                columns={[
                  { key: "orderNumber", label: "Order Number" },
                  { key: "tracking", label: "Tracking" },
                  { key: "agencyName", label: "Agency" },
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

export function DeliverySyncLogs() {
  const [page, setPage] = useState(1),
    [selected, setSelected] = useState(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    status = useApi("/delivery-sync/status"),
    runs = useApi(`/delivery-sync/runs?page=${page}&limit=20`),
    last = status.data?.lastRun;
  async function runNow() {
    setBusy(true);
    setError("");
    try {
      const run = await api("/delivery-sync/run", { method: "POST" });
      setSelected(run.runId);
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
        eyebrow="SETTINGS / DELIVERY SYNC LOGS"
        title="Delivery sync, without the guesswork."
        description="Every automatic and manual status check is recorded here."
      >
        <Can permission={P.deliverySync.run}>
          <button className="primary" disabled={busy} onClick={runNow}>
            <RefreshCw size={15} />
            {busy ? "Syncing…" : "Run Sync Now"}
          </button>
        </Can>
      </PageHeader>
      <ErrorBox error={error || status.error || runs.error} />
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
          {last && (
            <div className="metrics-grid">
              {counters.map(([label, key]) => (
                <Metric key={key} label={label} value={last[key]} />
              ))}
            </div>
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
              empty="No delivery sync runs have been recorded yet."
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
