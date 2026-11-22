import { useState } from "react";
import { Link } from "react-router-dom";
import { RefreshCw } from "lucide-react";
import "./delivery-webhooks.css";
import { useUser, can, P } from "../access";
import { api, params, useApi } from "../api";
import {
  Badge,
  DataTable,
  ErrorBox,
  Field,
  Loading,
  Modal,
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
const statuses = [
  "RECEIVED",
  "PROCESSING",
  "PROCESSED",
  "RETRY_PENDING",
  "IGNORED",
  "FAILED",
];
const tone = (status) =>
  status === "PROCESSED"
    ? "delivered"
    : status === "FAILED"
      ? "failed_delivery"
      : "confirmed";

function WebhookDetails({ id, onClose, onRetry }) {
  const detail = useApi(`/delivery-sync/webhooks/events/${id}`),
    user = useUser();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const event = detail.data;
  async function retry() {
    setBusy(true);
    setError("");
    try {
      await api(`/delivery-sync/webhooks/events/${id}/retry`, {
        method: "POST",
      });
      detail.reload();
      onRetry();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="Webhook event details" onClose={onClose} wide>
      <div className="modal-body delivery-webhook-details">
        <ErrorBox error={error || detail.error} />
        {detail.loading ? (
          <Loading />
        ) : (
          event && (
            <>
              <div className="metric-rows">
                {[
                  ["Event ID", event.eventId],
                  ["Topic", event.eventType],
                  ["Contract", event.contractVersion],
                  ["Received", dateTime(event.receivedAt)],
                  ["Signed transport time", dateTime(event.providerTimestamp)],
                  ["Provider event time", dateTime(event.eventOccurredAt)],
                  ["Status", event.processingStatus],
                  [
                    "Attempts (total / current budget)",
                    `${event.attemptCount} / ${event.retryCount}`,
                  ],
                  ["Manual recoveries", `${event.recoveryCount} / 5`],
                  ["Next retry", dateTime(event.nextRetryAt)],
                  [
                    "Result",
                    event.resultCode || event.lastErrorCode || "Pending",
                  ],
                  ["Explanation", event.lastErrorMessage || "—"],
                  ["Parcel UUID", event.notification?.parcelId || "Unverified"],
                  ["Payload bytes", event.payloadMetadata?.byteLength],
                  ["Payload SHA-256", event.payloadHash],
                ].map(([label, value]) => (
                  <div key={label}>
                    <span>{label}</span>
                    <b>{value}</b>
                  </div>
                ))}
              </div>
              <p>
                Customer payloads and signing credentials are not stored in
                event history. Supported events refresh the linked parcel
                through ABEX; unrecognized events are ignored and malformed
                notifications require review.
              </p>
              {event.retryEligible &&
                ["ADMIN", "SUPER_ADMIN"].includes(user.role) &&
                can(user, P.deliverySync.run) && (
                  <button className="primary" disabled={busy} onClick={retry}>
                    {busy ? "Queuing…" : "Retry event"}
                  </button>
                )}
            </>
          )
        )}
      </div>
    </Modal>
  );
}

export function DeliveryWebhookEvents() {
  const user = useUser();
  const [filters, setFilters] = useState({
    page: 1,
    status: "",
    eventType: "",
    agencyId: "",
    search: "",
    from: "",
    to: "",
  });
  const [selected, setSelected] = useState(null);
  const health = useApi("/delivery-sync/webhooks/status");
  const agencies = useApi(
    can(user, P.deliveryAgencies.view) ? "/delivery-agencies" : null,
  );
  const query = {
    ...filters,
    limit: 20,
    from: filters.from ? `${filters.from}T00:00:00+01:00` : "",
    to: filters.to ? `${filters.to}T23:59:59.999+01:00` : "",
  };
  const events = useApi(`/delivery-sync/webhooks/events?${params(query)}`);
  const change = (key, value) =>
    setFilters((f) => ({ ...f, [key]: value, page: 1 }));
  const reload = () => {
    health.reload();
    events.reload();
  };
  const status = health.data;
  return (
    <>
      <Panel
        className="delivery-webhook-summary"
        title="ABEX webhooks"
        subtitle="Configuration, received events and processing health are shown separately."
        action={
          <button onClick={reload} aria-label="Refresh webhook history">
            <RefreshCw size={15} /> Refresh
          </button>
        }
      >
        <ErrorBox error={health.error} />
        {health.loading ? (
          <Loading />
        ) : (
          status && (
            <>
              <div className="metric-rows">
                <div>
                  <span>Receiver</span>
                  <b>
                    {status.receiverConfigured ? "Configured" : "Unconfigured"}{" "}
                    · {status.receiverEnabled ? "Enabled" : "Disabled"}
                  </b>
                </div>
                <div>
                  <span>Inbox processing</span>
                  <b>{status.processingEnabled ? "Enabled" : "Disabled"}</b>
                </div>
                <div>
                  <span>Background API pacing</span>
                  <b>
                    One request per{" "}
                    {status.backgroundRequestIntervalSeconds || 15}s · order
                    intake has priority
                  </b>
                </div>
                <div>
                  <span>Delivery updates</span>
                  <b>
                    {status.mutationsEnabled
                      ? "Enabled for supported events"
                      : !status.contractVerified
                        ? "Awaiting verified contract"
                        : !status.agencyBound
                          ? "Set the CRM agency ID"
                          : !status.receiverConfigured
                            ? "Configure receiver signing"
                            : "Enable inbox processing"}
                  </b>
                </div>
                <div>
                  <span>Last received webhook</span>
                  <b>{dateTime(status.lastReceivedAt)}</b>
                </div>
                <div>
                  <span>Last processed delivery update</span>
                  <b>{dateTime(status.lastProcessedAt)}</b>
                </div>
                <div>
                  <span>Last successful inbox scan</span>
                  <b>{dateTime(status.worker?.lastSuccessAt)}</b>
                </div>
                <div>
                  <span>Pending / failed / unknown or unmapped</span>
                  <b>
                    {status.pending} / {status.failed} /{" "}
                    {status.unknownOrUnmapped}
                  </b>
                </div>
                <div>
                  <span>Oldest pending event</span>
                  <b>{dateTime(status.oldestPendingAt)}</b>
                </div>
                {status.worker?.lastErrorCode && (
                  <div>
                    <span>Worker error</span>
                    <b>{status.worker.lastErrorCode}</b>
                  </div>
                )}
              </div>
              {!status.contractVerified && (
                <p className="notice">
                  The ABEX event contract is unverified. Signed events are
                  recorded safely; automatic webhook delivery updates remain
                  disabled. Verify the event contract before accepting automatic
                  updates; review individual shipments manually in the meantime.
                </p>
              )}
              {status.contractVerified && (
                <p className="notice">
                  Supported topics:{" "}
                  {(status.supportedEventTypes || []).join(", ")}. Notifications
                  refresh only the matching CRM shipment through ABEX. Cron can
                  stay disabled. Requests are paced, queued notifications for
                  the same parcel are combined, and background reads yield to
                  order intake and provider cooldowns. Events without a matching
                  CRM shipment need their saved tracking and agency reviewed.
                  Verify a live PROCESSED event and the resulting CRM status.
                </p>
              )}
              {!status.lastReceivedAt && (
                <p className="notice">
                  No authenticated webhook reception has been observed.
                </p>
              )}
            </>
          )
        )}
      </Panel>
      <Panel
        title="Webhook events"
        subtitle="Only sanitized event metadata is available. Retries use the same identity and transition checks."
      >
        <ErrorBox error={events.error} />
        <div className="filter-grid">
          <Field label="Processing status">
            <select
              value={filters.status}
              onChange={(e) => change("status", e.target.value)}
            >
              <option value="">All statuses</option>
              {statuses.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </Field>
          <Field label="Event type">
            <input
              maxLength={100}
              placeholder="Exact topic"
              value={filters.eventType}
              onChange={(e) => change("eventType", e.target.value)}
            />
          </Field>
          <Field label="Agency">
            {agencies.data ? (
              <select
                value={filters.agencyId}
                onChange={(e) => change("agencyId", e.target.value)}
              >
                <option value="">All authorized agencies</option>
                {agencies.data
                  .filter((a) => a.apiProvider === "ABEX")
                  .map((a) => (
                    <option key={a._id} value={a._id}>
                      {a.name}
                    </option>
                  ))}
              </select>
            ) : (
              <input
                placeholder="Agency record ID"
                maxLength={24}
                value={filters.agencyId}
                onChange={(e) => change("agencyId", e.target.value)}
              />
            )}
          </Field>
          <Field label="Order or tracking">
            <input
              maxLength={150}
              value={filters.search}
              onChange={(e) => change("search", e.target.value)}
            />
          </Field>
          <Field label="Received from">
            <input
              type="date"
              value={filters.from}
              onChange={(e) => change("from", e.target.value)}
            />
          </Field>
          <Field label="Received through">
            <input
              type="date"
              value={filters.to}
              onChange={(e) => change("to", e.target.value)}
            />
          </Field>
        </div>
        {events.loading ? (
          <Loading />
        ) : (
          <>
            <DataTable
              rows={events.data?.items}
              empty="No webhook events match these filters."
              columns={[
                {
                  key: "receivedAt",
                  label: "Received",
                  render: (e) => dateTime(e.receivedAt),
                },
                {
                  key: "agency",
                  label: "Agency",
                  render: (e) => e.agencyId?.name || "Unbound",
                },
                { key: "eventType", label: "Event type" },
                {
                  key: "order",
                  label: "Order",
                  render: (e) =>
                    e.orderId ? (
                      <Link to={`/orders/${e.orderId}`}>
                        {e.orderNumber || "Open order"}
                      </Link>
                    ) : (
                      "—"
                    ),
                },
                {
                  key: "tracking",
                  label: "Tracking",
                  render: (e) =>
                    e.trackingNumber || e.notification?.trackingNumber || "—",
                },
                {
                  key: "processingStatus",
                  label: "Processing status",
                  render: (e) => (
                    <Badge tone={tone(e.processingStatus)}>
                      {e.processingStatus}
                    </Badge>
                  ),
                },
                { key: "attemptCount", label: "Attempts" },
                {
                  key: "result",
                  label: "Result",
                  render: (e) => e.resultCode || e.lastErrorCode || "Pending",
                },
                {
                  key: "details",
                  label: "Details",
                  render: (e) => (
                    <button onClick={() => setSelected(e._id)}>Inspect</button>
                  ),
                },
              ]}
            />
            <Pagination
              page={filters.page}
              total={events.data?.total || 0}
              limit={20}
              onChange={(page) => setFilters((f) => ({ ...f, page }))}
            />
          </>
        )}
      </Panel>
      {selected && (
        <WebhookDetails
          id={selected}
          onClose={() => setSelected(null)}
          onRetry={reload}
        />
      )}
    </>
  );
}
