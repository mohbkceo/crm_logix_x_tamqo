import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  ArrowLeft,
  ArrowRight,
  X,
  MoreHorizontal,
  RefreshCw,
  Search,
  Flag,
  Star,
} from "lucide-react";
import { api, useApi, params, money, human, date } from "../api";
import { P, can, useUser } from "../access";
import { MediaGallery } from "../MediaGallery";
import {
  PageHeader,
  ErrorBox,
  Loading,
  Empty,
  Field,
  Modal,
  Pagination,
} from "../components";
import {
  STAGE_LABELS,
  SEVERITIES,
  SEVERITY_LABELS,
} from "../../../shared/tracking.js";
import {
  QUICK_TAGS,
  defaultTrackingFilters,
  clearTrackingFilters,
} from "../../../shared/trackingFilters.js";
import "./tracking-redesign.css";

function ContactLink({ contact, children }) {
  return contact?.url ? (
    <a href={contact.url} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ) : (
    <span className="unavailable-contact">
      {children}
      <small>{contact?.unavailableReason || "Unavailable"}</small>
    </span>
  );
}
const age = (value) => {
  if (!value) return "Stage age unknown";
  const hours = Math.max(
    0,
    Math.floor((Date.now() - new Date(value)) / 3600000),
  );
  return hours < 1
    ? "Less than 1 hour"
    : hours < 24
      ? `${hours}h in stage`
      : `${Math.floor(hours / 24)}d ${hours % 24}h in stage`;
};
/** Full-size, keyboard-accessible order image preview. */
function TrackingImageViewer({ order, onClose }) {
  const [index, setIndex] = useState(0);
  const closeRef = useRef(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const images = order.images || [];
  const count = images.length;

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    const previouslyFocused = document.activeElement;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    const onKeyDown = (event) => {
      if (event.key === "Escape") onCloseRef.current();
      if (event.key === "ArrowRight" && count > 1)
        setIndex((current) => (current + 1) % count);
      if (event.key === "ArrowLeft" && count > 1)
        setIndex((current) => (current - 1 + count) % count);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeyDown);
      previouslyFocused?.focus?.();
    };
  }, [count]);

  if (!count) return null;
  return (
    <div
      className="tracking-image-overlay"
      role="presentation"
      onClick={(event) => {
        // Clicking/tapping the dark backdrop dismisses the preview.
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="tracking-image-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={`Order images for ${order.customer?.name || "customer"}`}
      >
        <header className="tracking-image-toolbar">
          <div className="tracking-image-heading">
            <strong>{order.customer?.name || "Order images"}</strong>
            <span>
              {index + 1} of {count}
            </span>
          </div>
          <button
            ref={closeRef}
            type="button"
            className="tracking-image-close"
            onClick={onClose}
            aria-label="Close image preview"
          >
            <X size={20} />
          </button>
        </header>
        <div className="tracking-image-stage">
          {count > 1 && (
            <button
              type="button"
              className="tracking-image-nav"
              aria-label="Previous image"
              onClick={() =>
                setIndex((current) => (current - 1 + count) % count)
              }
            >
              <ArrowLeft size={20} />
            </button>
          )}
          <img
            key={images[index]._id || images[index].url}
            src={images[index].url}
            alt={`Order reference ${index + 1} of ${count}`}
            title="Click or tap to close preview"
            onClick={onClose}
          />
          {count > 1 && (
            <button
              type="button"
              className="tracking-image-nav"
              aria-label="Next image"
              onClick={() => setIndex((current) => (current + 1) % count)}
            >
              <ArrowRight size={20} />
            </button>
          )}
        </div>
        {count > 1 && (
          <nav className="tracking-image-thumbnails" aria-label="Choose image">
            {images.map((image, position) => (
              <button
                type="button"
                key={image._id || position}
                aria-label={`Show image ${position + 1}`}
                aria-current={position === index ? "true" : undefined}
                className={position === index ? "active" : ""}
                onClick={() => setIndex(position)}
              >
                <img
                  src={image.url + "?thumbnail=true"}
                  alt=""
                  loading="lazy"
                />
              </button>
            ))}
          </nav>
        )}
      </section>
    </div>
  );
}

export function Tracking() {
  const user = useUser();
  const [filters, setFilters] = useState(() => defaultTrackingFilters(user));
  const result = useApi("/tracking?" + params(filters));
  const types = useApi(
    can(user, P["tracking.issue"].create)
      ? "/tracking/issue-types?limit=100"
      : null,
  );
  const employees = useApi("/tracking/employees?limit=100");
  const [selected, setSelected] = useState([]),
    [modal, setModal] = useState(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const inFlight = useRef(false);
  useEffect(() => {
    const timer = setInterval(() => {
      if (!document.hidden && !inFlight.current) result.reload();
    }, 30000);
    return () => clearInterval(timer);
  }, [result.reload]);
  const change = (key, value) => {
    setFilters((f) => ({
      ...f,
      [key]: value,
      page: 1,
      ...(key === "issue"
        ? {
            tags: (f.tags || "")
              .split(",")
              .filter(
                (t) =>
                  t &&
                  QUICK_TAGS.find((tag) => tag.value === t).category !==
                    "issue",
              )
              .join(","),
          }
        : {}),
    }));
    setSelected([]);
  };
  const issueTag = { OPEN: "ISSUES", BLOCKING: "BLOCKED", NONE: "NO_ISSUES" };
  const activeTags = new Set((filters.tags || "").split(",").filter(Boolean));
  if (filters.issue) activeTags.add(issueTag[filters.issue]);
  function toggleTag(tag) {
    setFilters((f) => {
      const tags = new Set((f.tags || "").split(",").filter(Boolean));
      if (tag.category === "issue" && f.issue) tags.add(issueTag[f.issue]);
      if (tags.has(tag.value)) tags.delete(tag.value);
      else tags.add(tag.value);
      return {
        ...f,
        tags: [...tags].join(","),
        page: 1,
        ...(tag.category === "issue" ? { issue: "" } : {}),
      };
    });
    setSelected([]);
  }
  function resetFilters(defaults) {
    setFilters(
      defaults ? defaultTrackingFilters(user) : clearTrackingFilters(),
    );
    setSelected([]);
  }
  async function perform(operation, success = "Saved", close = false) {
    if (inFlight.current) return false;
    inFlight.current = true;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await operation();
      result.reload();
      setMessage(success);
      if (close) setModal(null);
      return true;
    } catch (e) {
      setError(e.message);
      result.reload();
      if (modal?.order) {
        try {
          const current = await api("/tracking/" + modal.order._id);
          setModal((m) => (m ? { ...m, order: current } : null));
        } catch {
          /* The list explains removed access. */
        }
      }
      return false;
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  const move = (o, targetStage) =>
    perform(
      () =>
        api(`/tracking/${o._id}/stage`, {
          method: "PATCH",
          body: { targetStage, expectedRevision: o.revision },
        }),
      `Moved to ${STAGE_LABELS[targetStage]}`,
    );
  async function bulk(targetStage) {
    await perform(async () => {
      const rows = result.data.items.filter((o) => selected.includes(o._id));
      const response = await api("/tracking/bulk-stage", {
        method: "POST",
        body: {
          orders: rows.map((o) => ({
            orderId: o._id,
            expectedRevision: o.revision,
            targetStage,
          })),
        },
      });
      const failures = response.results.filter((r) => !r.success);
      setSelected(failures.map((r) => r.orderId));
      if (failures.length)
        setError(
          failures
            .map(
              (r) =>
                `${rows.find((o) => o._id === r.orderId)?.orderNumber}: ${r.error}`,
            )
            .join("\n"),
        );
    }, "Bulk operation completed. Any orders requiring attention are listed below.");
  }
  const open = (kind, order) => {
    setError("");
    setModal({ kind, order });
  };
  const rows = result.data?.items || [];
  const selectable = rows.filter((o) =>
    o.allowedTargets.some((s) =>
      ["READY_TO_SHIP", "AT_PRODUCTION"].includes(s),
    ),
  );
  return (
    <div className="tracking-page">
      <PageHeader
        eyebrow="OPERATIONS / TRACKING"
        title="Tracking"
        description="Production progress and order status, at a glance."
      >
        <button
          onClick={result.reload}
          disabled={busy}
          aria-label="Refresh tracking"
        >
          <RefreshCw size={16} /> Refresh
        </button>
      </PageHeader>
      <div className="panel tracking-panel" aria-busy={busy}>
        <div className="tracking-filters">
          <label className="tracking-search">
            <Search size={16} />
            <input
              aria-label="Search tracking"
              placeholder="Order, customer, phone, product or tracking…"
              value={filters.search || ""}
              onChange={(e) => change("search", e.target.value)}
            />
          </label>
          <select
            aria-label="Production stage"
            value={filters.stage || ""}
            onChange={(e) => change("stage", e.target.value)}
          >
            <option value="">All production stages</option>
            {Object.entries(STAGE_LABELS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
          <select
            aria-label="Issue status"
            value={filters.issue || ""}
            onChange={(e) => change("issue", e.target.value)}
          >
            <option value="">All reports</option>
            <option value="OPEN">Unresolved reports</option>
            <option value="BLOCKING">Blocking reports</option>
            <option value="NONE">No open reports</option>
          </select>
          <details className="tracking-filter-details">
            <summary>More filters</summary>
            <div className="filter-grid">
              <Field label="Courier status">
                <select
                  value={filters.courierStatus || ""}
                  onChange={(e) => change("courierStatus", e.target.value)}
                >
                  <option value="">All courier statuses</option>
                  {[
                    "PREPARING",
                    "READY_TO_SHIP",
                    "SHIPPED",
                    "OUT_FOR_DELIVERY",
                    "DELIVERED",
                    "FAILED_DELIVERY",
                    "RETURNING",
                    "RETURNED",
                    "CANCELLED",
                  ].map((s) => (
                    <option key={s}>{s}</option>
                  ))}
                </select>
              </Field>
              <Field label="Employee">
                <select
                  value={filters.employee || ""}
                  onChange={(e) => change("employee", e.target.value)}
                >
                  <option value="">All employees</option>
                  {employees.data?.map((u) => (
                    <option key={u._id} value={u._id}>
                      {u.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Business">
                <select
                  value={filters.business || ""}
                  onChange={(e) => change("business", e.target.value)}
                >
                  <option value="">Authorized businesses</option>
                  <option value="LOGIX_ONLY">Logix</option>
                  {(user.role === "SUPER_ADMIN" ||
                    user.businessAccess?.includes("TAMQO")) && (
                    <option value="PARTNERSHIP">Partnership</option>
                  )}
                </select>
              </Field>
              <Field label="Created from">
                <input
                  type="date"
                  value={filters.from || ""}
                  onChange={(e) => change("from", e.target.value)}
                />
              </Field>
              <Field label="Created through">
                <input
                  type="date"
                  value={filters.to || ""}
                  onChange={(e) => change("to", e.target.value)}
                />
              </Field>
              <Field label="Sort">
                <select
                  value={filters.sort}
                  onChange={(e) => change("sort", e.target.value)}
                >
                  <option value="oldest">Oldest first</option>
                  <option value="newest">Newest first</option>
                  <option value="issuesFirst">
                    Issues first · oldest within priority
                  </option>
                </select>
              </Field>
              <Field label="Order lifecycle">
                <select
                  value={filters.lifecycle || "ALL"}
                  onChange={(e) => change("lifecycle", e.target.value)}
                >
                  <option value="ALL">All orders</option>
                  <option value="ACTIVE">Active orders</option>
                  <option value="COMPLETED">
                    Completed / cancelled orders
                  </option>
                </select>
              </Field>
              <Field label="Production queue">
                <select
                  value={filters.attention || "all"}
                  onChange={(e) => change("attention", e.target.value)}
                >
                  <option value="all">Include delivery agency orders</option>
                  <option value="internal">Internal attention only</option>
                </select>
              </Field>
            </div>
          </details>
        </div>
        <div
          className="tracking-quick-filters"
          role="group"
          aria-label="Quick filters"
        >
          {QUICK_TAGS.map((tag) => (
            <button
              key={tag.value}
              className={`tracking-filter-chip ${activeTags.has(tag.value) ? "active" : ""}`}
              aria-pressed={activeTags.has(tag.value)}
              disabled={busy}
              onClick={() => toggleTag(tag)}
              title="Counts include other filter categories; tags in this category are combined with OR."
            >
              {tag.label}
              {!result.loading &&
                result.data?.tagCounts?.[tag.value] !== undefined && (
                  <span className="tracking-chip-count">
                    {result.data.tagCounts[tag.value]}
                  </span>
                )}
            </button>
          ))}
        </div>
        <div className="tracking-filter-tools">
          <span role="status" aria-live="polite">
            {result.loading
              ? "Updating results…"
              : result.data
                ? `${result.data.total} matching order${result.data.total === 1 ? "" : "s"}`
                : ""}
          </span>
          <button disabled={busy} onClick={() => resetFilters(false)}>
            Clear Filters
          </button>
          <button disabled={busy} onClick={() => resetFilters(true)}>
            Reset to My Default View
          </button>
        </div>
        <ErrorBox
          error={error || result.error || types.error || employees.error}
        />
        {message && (
          <p className="success" role="status">
            {message}
          </p>
        )}
        {can(user, P.tracking.bulkUpdate) && (
          <div className="tracking-bulk">
            <label>
              <input
                type="checkbox"
                aria-label="Select visible eligible orders"
                checked={
                  selectable.length > 0 &&
                  selectable.every((o) => selected.includes(o._id))
                }
                disabled={busy || result.loading || !selectable.length}
                onChange={(e) =>
                  setSelected(
                    e.target.checked ? selectable.map((o) => o._id) : [],
                  )
                }
              />{" "}
              Select page
            </label>
            <span>{selected.length} selected</span>
            {can(user, P.tracking.markReady) &&
              rows.some((o) => o.allowedTargets.includes("READY_TO_SHIP")) && (
                <button
                  disabled={busy || result.loading || !selected.length}
                  onClick={() => bulk("READY_TO_SHIP")}
                >
                  Mark ready
                </button>
              )}
            {can(user, P.tracking.revertReady) &&
              rows.some(
                (o) =>
                  o.tracking.stage === "READY_TO_SHIP" &&
                  o.allowedTargets.includes("AT_PRODUCTION"),
              ) && (
                <button
                  disabled={busy || result.loading || !selected.length}
                  onClick={() => bulk("AT_PRODUCTION")}
                >
                  Return to production
                </button>
              )}
          </div>
        )}
        {result.loading && !result.data ? (
          <Loading />
        ) : !rows.length ? (
          <Empty
            title="No orders in this queue"
            text="Try another stage or search."
          />
        ) : (
          <div className="tracking-list">
            <div
              className="tracking-order-row tracking-head"
              aria-hidden="true"
            >
              <span />
              <span>Customer</span>
              <span>Total price</span>
              <span>Products</span>
              <span>Production</span>
              <span>Responsible / courier</span>
              <span>Actions</span>
            </div>
            {rows.map((o) => {
              const target = o.allowedTargets.includes("READY_TO_SHIP")
                ? "READY_TO_SHIP"
                : o.allowedTargets[0];
              return (
                <article
                  key={o._id}
                  className={`tracking-order-row stage-${o.tracking.stage.toLowerCase()}`}
                  aria-label={o.orderNumber}
                >
                  <div className="tracking-selection">
                    {can(user, P.tracking.bulkUpdate) && (
                      <input
                        type="checkbox"
                        aria-label={`Select ${o.orderNumber}`}
                        checked={selected.includes(o._id)}
                        disabled={busy || !o.allowedTargets.length}
                        onChange={(e) =>
                          setSelected((s) =>
                            e.target.checked
                              ? [...s, o._id]
                              : s.filter((id) => id !== o._id),
                          )
                        }
                      />
                    )}
                  </div>
                  <div className="tracking-person">
                    {o.images[0] && (
                      <button
                        className="tracking-thumb"
                        aria-label={`Preview ${o.orderNumber} image`}
                        onClick={() => open("image", o)}
                      >
                        <img
                          src={o.images[0].url + "?thumbnail=true"}
                          alt="Order reference"
                          loading="lazy"
                        />
                      </button>
                    )}
                    <div className="tracking-person-main">
                      <div className="tracking-name-line">
                        <strong>{o.customer.name}</strong>
                        {o.canMarkImportant ? (
                          <button
                            className={`tracking-important ${o.tracking.important ? "active" : ""}`}
                            aria-label={`${o.tracking.important ? "Unmark" : "Mark"} ${o.orderNumber} as Important`}
                            aria-pressed={Boolean(o.tracking.important)}
                            title={
                              o.tracking.important
                                ? "Remove Important flag"
                                : "Mark as Important"
                            }
                            disabled={busy}
                            onClick={() =>
                              perform(
                                () =>
                                  api(`/tracking/${o._id}/important`, {
                                    method: "PATCH",
                                    body: {
                                      important: !o.tracking.important,
                                      expectedRevision: o.revision,
                                    },
                                  }),
                                o.tracking.important
                                  ? "Important flag removed"
                                  : "Marked as Important",
                              )
                            }
                          >
                            <Star
                              size={14}
                              fill={
                                o.tracking.important ? "currentColor" : "none"
                              }
                            />
                          </button>
                        ) : o.tracking.important ? (
                          <span
                            className="tracking-important-indicator"
                            title="Important"
                            aria-label="Important"
                          >
                            <Star size={14} fill="currentColor" />
                          </span>
                        ) : null}
                      </div>
                      <small>{o.customer.phoneA}</small>
                    </div>
                  </div>
                  <div className="tracking-price" data-label="Total price">
                    {o.totalOrderValue != null &&
                    Number.isFinite(Number(o.totalOrderValue)) ? (
                      money(o.totalOrderValue)
                    ) : (
                      <span className="tracking-not-available">—</span>
                    )}
                  </div>
                  <div className="tracking-products" data-label="Products">
                    {o.items.map((i, n) => (
                      <div key={n}>
                        <b>
                          {i.quantity} × {i.name}
                        </b>
                        {i.specifications && <small>{i.specifications}</small>}
                      </div>
                    ))}
                  </div>
                  <div className="tracking-stage" data-label="Production">
                    <button
                      disabled={busy || !target}
                      onClick={() => move(o, target)}
                      title={
                        target
                          ? `Move to ${STAGE_LABELS[target]}`
                          : o.courierOwned
                            ? "Controlled by delivery agency"
                            : o.tracking.blockingIssues
                              ? "Resolve blocking reports first"
                              : "No authorized transition"
                      }
                      aria-label={
                        target
                          ? `${o.orderNumber}: ${STAGE_LABELS[o.tracking.stage]} → ${STAGE_LABELS[target]}`
                          : `${o.orderNumber}: ${STAGE_LABELS[o.tracking.stage]}`
                      }
                    >
                      {STAGE_LABELS[o.tracking.stage]}
                      {target && <span aria-hidden="true"> →</span>}
                    </button>
                    <small>
                      {o.courierOwned
                        ? "Delivery agency controls this order"
                        : age(o.tracking.stageEnteredAt)}
                    </small>
                    {o.tracking.openIssues > 0 && (
                      <button
                        className={`tracking-issue-count ${o.tracking.criticalIssues ? "critical" : o.tracking.blockingIssues ? "blocking" : ""}`}
                        disabled={!can(user, P["tracking.issue"].view)}
                        onClick={() => open("issues", o)}
                      >
                        <Flag size={13} />
                        {o.tracking.openIssues} open report
                        {o.tracking.openIssues > 1 ? "s" : ""}
                        {o.tracking.criticalIssues
                          ? " · Critical"
                          : o.tracking.blockingIssues > 0
                            ? " · Blocking"
                            : ""}
                      </button>
                    )}
                  </div>
                  <div
                    className="tracking-responsible"
                    data-label="Responsible / courier"
                  >
                    <span>
                      {o.responsible.name || "No internal employee assigned"}
                    </span>
                    <small>
                      {o.shipment?.agencyName || human(o.status)}
                      {o.shipment?.providerStatus
                        ? ` · ${o.shipment.providerStatus}`
                        : o.shipment?.status
                          ? ` · ${human(o.shipment.status)}`
                          : ""}
                    </small>
                    {o.shipment?.tracking && (
                      <small>{o.shipment.tracking}</small>
                    )}
                    {o.shipment?.syncStatus === "ERROR" && (
                      <small
                        className="tracking-sync-error"
                        title={o.shipment.lastError}
                      >
                        Courier sync needs attention
                      </small>
                    )}
                  </div>
                  <div className="tracking-actions">
                    {can(user, P["tracking.issue"].create) && (
                      <button disabled={busy} onClick={() => open("report", o)}>
                        Report
                      </button>
                    )}
                    <details className="tracking-more">
                      <summary aria-label={`More actions for ${o.orderNumber}`}>
                        <MoreHorizontal size={18} />
                        <span className="sr-only">More</span>
                      </summary>
                      <div>
                        <span className="tracking-more-reference">
                          {o.orderNumber}
                        </span>
                        <ContactLink contact={o.creatorContact}>
                          Contact Order Creator
                        </ContactLink>
                        <ContactLink contact={o.responsible}>
                          Contact Current Responsible
                        </ContactLink>
                        {o.shipment?.url ? (
                          <a
                            href={o.shipment.url}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            View at Delivery Agency
                          </a>
                        ) : (
                          <span className="unavailable-contact">
                            View at Delivery Agency
                            <small>
                              {o.shipment?.tracking
                                ? "External tracking link unavailable for this agency"
                                : "No tracking number yet"}
                            </small>
                          </span>
                        )}
                        {can(user, P["tracking.issue"].view) && (
                          <button onClick={() => open("issues", o)}>
                            Reports & history
                          </button>
                        )}
                        {can(user, P.tracking.assign) && (
                          <button onClick={() => open("assign", o)}>
                            Assign employee
                          </button>
                        )}
                        {o.canInitialize && (
                          <button
                            disabled={busy}
                            onClick={() =>
                              perform(
                                () =>
                                  api(`/tracking/${o._id}/initialize`, {
                                    method: "POST",
                                    body: { expectedRevision: o.revision },
                                  }),
                                "Production initialized",
                              )
                            }
                          >
                            Start production workflow
                          </button>
                        )}
                        {o.allowedTargets
                          .filter((t) => t !== target)
                          .map((t) => (
                            <button
                              key={t}
                              disabled={busy}
                              onClick={() => move(o, t)}
                            >
                              Move to {STAGE_LABELS[t]}
                            </button>
                          ))}
                        {o.canViewOrder && (
                          <Link to={`/orders/${o._id}`}>View order</Link>
                        )}
                        {can(user, P.audit.view) && (
                          <button onClick={() => open("history", o)}>
                            Tracking audit
                          </button>
                        )}
                      </div>
                    </details>
                  </div>
                </article>
              );
            })}
          </div>
        )}
        {result.data && (
          <Pagination
            {...result.data}
            onChange={(page) => {
              setFilters((f) => ({ ...f, page }));
              setSelected([]);
            }}
          />
        )}
      </div>
      {modal?.kind === "image" && (
        <TrackingImageViewer
          order={modal.order}
          onClose={() => setModal(null)}
        />
      )}
      {modal && modal.kind !== "image" && (
        <Modal
          title={`${modal.kind === "report" ? "Report" : modal.kind === "issues" ? "Reports" : modal.kind === "assign" ? "Assignment" : "Tracking audit"} · ${modal.order.orderNumber}`}
          onClose={() => !busy && setModal(null)}
        >
          <div className="modal-body">
            <ErrorBox error={error} />
            {modal.kind === "report" && (
              <ReportForm
                key={modal.order._id}
                types={types.data?.items || []}
                busy={busy}
                onSend={(body) =>
                  perform(
                    () =>
                      api(`/tracking/${modal.order._id}/issues`, {
                        method: "POST",
                        body: {
                          ...body,
                          expectedRevision: modal.order.revision,
                        },
                      }),
                    "Report sent",
                    true,
                  )
                }
              />
            )}
            {modal.kind === "issues" && (
              <IssueList order={modal.order} busy={busy} perform={perform} />
            )}
            {modal.kind === "assign" && (
              <Assignment
                order={modal.order}
                employees={employees.data || []}
                busy={busy}
                save={(body) =>
                  perform(
                    () =>
                      api(`/tracking/${modal.order._id}/assign`, {
                        method: "PATCH",
                        body: {
                          ...body,
                          expectedRevision: modal.order.revision,
                        },
                      }),
                    "Assignment saved",
                    true,
                  )
                }
              />
            )}
            {modal.kind === "history" && (
              <TrackingHistory order={modal.order} />
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}
function ReportForm({ types, busy, onSend }) {
  const [typeId, setTypeId] = useState(""),
    [severity, setSeverity] = useState("INFO"),
    [description, setDescription] = useState("");
  const requestId = useRef(crypto.randomUUID());
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!busy)
          onSend({
            typeId,
            severity,
            description,
            requestId: requestId.current,
          });
      }}
      className="tracking-report-form"
    >
      <Field label="Issue Type">
        <select
          required
          value={typeId}
          onChange={(e) => {
            setTypeId(e.target.value);
            setSeverity(
              types.find((t) => t._id === e.target.value)?.defaultSeverity ||
                "INFO",
            );
          }}
        >
          <option value="">Select issue type</option>
          {types.map((t) => (
            <option key={t._id} value={t._id}>
              {t.label}
              {t.blocksProduction ? " · Blocks production" : ""}
            </option>
          ))}
        </select>
      </Field>
      <fieldset className="tracking-severity">
        <legend>Severity</legend>
        {SEVERITIES.map((s) => (
          <label key={s}>
            <input
              type="radio"
              name="severity"
              required
              value={s}
              checked={severity === s}
              onChange={() => setSeverity(s)}
            />
            {SEVERITY_LABELS[s]}
          </label>
        ))}
      </fieldset>
      <details>
        <summary>Description (optional)</summary>
        <textarea
          aria-label="Description"
          rows={2}
          maxLength={2000}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </details>
      <button className="primary full tracking-send" disabled={busy || !typeId}>
        {busy ? "Sending…" : "Send"}
      </button>
    </form>
  );
}
function IssueList({ order, busy, perform }) {
  const user = useUser(),
    [page, setPage] = useState(1),
    result = useApi(`/tracking/${order._id}/issues?page=${page}`);
  return (
    <>
      <ErrorBox error={result.error} />
      {result.loading && !result.data ? (
        <Loading />
      ) : (
        <>
          {!result.data?.items.length && <p>No reports yet.</p>}
          {result.data?.items.map((i) => (
            <article
              key={i._id}
              className={`tracking-report severity-${i.severity.toLowerCase()}`}
            >
              <b>
                <span aria-hidden="true">
                  {i.typeSnapshot.indicator === "FLAG"
                    ? "⚑ "
                    : i.typeSnapshot.indicator === "ATTENTION"
                      ? "! "
                      : "ℹ "}
                </span>
                {i.typeSnapshot.label}
              </b>
              <span>
                {SEVERITY_LABELS[i.severity]} · {human(i.status)}
                {i.blocking ? " · Blocks production" : ""}
              </span>
              {i.description && <p>{i.description}</p>}
              <small>
                Reported by {i.reporter.name} ·{" "}
                {i.reporterRoles.map(human).join(", ") || "Employee"} ·{" "}
                {date(i.createdAt)}
              </small>
              <ContactLink contact={i.reporterContact}>
                Contact Reporter
              </ContactLink>
              <details>
                <summary>Attachments ({i.attachments?.length || 0})</summary>
                <MediaGallery
                  endpoint={`/issue-media/${order._id}/${i._id}`}
                  images={i.attachments}
                  revision={result.data.revision}
                  editable={i.canManageAttachments}
                  disabled={busy}
                  onChange={result.reload}
                />
              </details>
              {i.status === "OPEN" &&
                can(user, P["tracking.issue"].resolve) && (
                  <button
                    disabled={busy}
                    onClick={async () => {
                      if (
                        await perform(
                          () =>
                            api(
                              `/tracking/${order._id}/issues/${i._id}/resolve`,
                              {
                                method: "POST",
                                body: {
                                  expectedRevision: result.data.revision,
                                },
                              },
                            ),
                          "Report resolved",
                        )
                      )
                        result.reload();
                      else result.reload();
                    }}
                  >
                    Resolve
                  </button>
                )}
              {i.status === "RESOLVED" && (
                <small>
                  Resolved by {i.resolvedBy?.name} · {date(i.resolvedAt)}
                </small>
              )}
            </article>
          ))}
          {result.data && <Pagination {...result.data} onChange={setPage} />}
        </>
      )}
    </>
  );
}
function Assignment({ order, employees, busy, save }) {
  const [designerId, setDesigner] = useState(order.tracking.designerId || ""),
    [productionId, setProduction] = useState(order.tracking.productionId || "");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        save({
          designerId: designerId || null,
          productionId: productionId || null,
        });
      }}
    >
      {[
        ["Designer", designerId, setDesigner, ["DESIGNER"]],
        [
          "Production employee / manager",
          productionId,
          setProduction,
          ["PRODUCTION", "PRODUCTION_MANAGER"],
        ],
      ].map(([label, value, set, roles]) => (
        <Field key={label} label={label}>
          <select value={value} onChange={(e) => set(e.target.value)}>
            <option value="">Unassigned</option>
            {employees
              .filter((u) => u.operationalRoles.some((r) => roles.includes(r)))
              .map((u) => (
                <option key={u._id} value={u._id}>
                  {u.name}
                </option>
              ))}
          </select>
        </Field>
      ))}
      <button className="primary" disabled={busy}>
        Save assignment
      </button>
    </form>
  );
}
function TrackingHistory({ order }) {
  const [page, setPage] = useState(1),
    result = useApi(`/tracking/${order._id}/history?page=${page}`);
  return (
    <>
      <ErrorBox error={result.error} />
      {result.loading ? (
        <Loading />
      ) : (
        result.data?.items.map((e) => (
          <article className="tracking-report" key={e._id}>
            <b>{human(e.kind)}</b>
            <span>
              {STAGE_LABELS[e.previousStage]} → {STAGE_LABELS[e.newStage]}
            </span>
            <small>
              {e.actor?.name} · {date(e.at)} · Revision {e.revision} ·{" "}
              {e.source}
            </small>
          </article>
        ))
      )}
      {result.data && <Pagination {...result.data} onChange={setPage} />}
    </>
  );
}
