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

const STAGES_AR = {
  IN_PREPARATION: "قيد التحضير",
  AT_PRODUCTION: "قيد الإنتاج",
  READY_TO_SHIP: "جاهز للشحن",
  PREPARING: "قيد التحضير",
  COMPLETED: "مكتمل",
  CANCELLED: "ملغى",
};
const SEVERITIES_AR = {
  INFO: "معلومات",
  LOW: "منخفضة",
  MEDIUM: "متوسطة",
  HIGH: "مرتفعة",
  CRITICAL: "حرجة",
  WARNING: "تحذير",
};
const STATUS_AR = {
  OPEN: "مفتوح",
  RESOLVED: "محلول",
  PREPARING: "قيد التحضير",
  READY_TO_SHIP: "جاهز للشحن",
  SHIPPED: "تم الشحن",
  OUT_FOR_DELIVERY: "قيد التوصيل",
  DELIVERED: "تم التسليم",
  FAILED_DELIVERY: "فشل التسليم",
  RETURNING: "قيد الإرجاع",
  RETURNED: "تم الإرجاع",
  CANCELLED: "ملغى",
  CREATED: "تم الإنشاء",
  UPDATED: "تم التحديث",
  DESIGNER: "مصمم",
  PRODUCTION: "إنتاج",
  PRODUCTION_MANAGER: "مدير الإنتاج",
  SALES: "مبيعات",
  SUPER_ADMIN: "المدير العام",
};
const TAGS_AR = {
  IMPORTANT: "مهم",
  NEW: "جديد",
  ISSUES: "به مشكلات",
  BLOCKED: "معيق",
  NO_ISSUES: "دون مشكلات",
  OLD: "قديم",
  URGENT: "عاجل",
  OVERDUE: "متأخر",
  TODAY: "اليوم",
  MY_ORDERS: "طلباتي",
};
const stageLabel = (key) =>
  STAGES_AR[key] ||
  (STAGE_LABELS[key] ? localizedStatus(STAGE_LABELS[key]) : "غير معروف");
const severityLabel = (key) =>
  SEVERITIES_AR[key] || localizedStatus(SEVERITY_LABELS[key] || key);
const localizedStatus = (value) =>
  STATUS_AR[value] || String(value ?? "").replace(/_/g, " ");
const quickTagLabel = (tag) =>
  TAGS_AR[tag.value] ||
  {
    Important: "مهم",
    New: "جديد",
    Blocked: "معيق",
    Issues: "مشكلات",
    "No issues": "دون مشكلات",
  }[tag.label] ||
  tag.label;

function ContactLink({ contact, children }) {
  return contact?.url ? (
    <a href={contact.url} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ) : (
    <span className="unavailable-contact">
      {children}
      <small>{contact?.unavailableReason || "غير متاح"}</small>
    </span>
  );
}
const age = (value) => {
  if (!value) return "مدة المرحلة غير معروفة";
  const hours = Math.max(
    0,
    Math.floor((Date.now() - new Date(value)) / 3600000),
  );
  return hours < 1
    ? "أقل من ساعة"
    : hours < 24
      ? `${hours} ساعة في هذه المرحلة`
      : `${Math.floor(hours / 24)} يوم و${hours % 24} ساعة في هذه المرحلة`;
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
        aria-label={`صور الطلب للعميل ${order.customer?.name || "غير معروف"}`}
      >
        <header className="tracking-image-toolbar">
          <div className="tracking-image-heading">
            <strong>{order.customer?.name || "صور الطلب"}</strong>
            <span>
              {index + 1} من {count}
            </span>
          </div>
          <button
            ref={closeRef}
            type="button"
            className="tracking-image-close"
            onClick={onClose}
            aria-label="إغلاق معاينة الصورة"
          >
            <X size={20} />
          </button>
        </header>
        <div className="tracking-image-stage">
          {count > 1 && (
            <button
              type="button"
              className="tracking-image-nav"
              aria-label="الصورة السابقة"
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
            alt={`صورة الطلب ${index + 1} من ${count}`}
            title="انقر لإغلاق المعاينة"
            onClick={onClose}
          />
          {count > 1 && (
            <button
              type="button"
              className="tracking-image-nav"
              aria-label="الصورة التالية"
              onClick={() => setIndex((current) => (current + 1) % count)}
            >
              <ArrowRight size={20} />
            </button>
          )}
        </div>
        {count > 1 && (
          <nav className="tracking-image-thumbnails" aria-label="اختيار صورة">
            {images.map((image, position) => (
              <button
                type="button"
                key={image._id || position}
                aria-label={`عرض الصورة ${position + 1}`}
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
  async function perform(operation, success = "تم الحفظ", close = false) {
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
      `تم النقل إلى ${stageLabel(targetStage)}`,
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
    }, "اكتملت العملية الجماعية. الطلبات التي تحتاج إلى متابعة موضحة أدناه.");
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
    <div className="tracking-page" dir="rtl" lang="ar">
      <PageHeader
        eyebrow="العمليات / تتبع الطلبات"
        title="تتبع الطلبات"
        description="تابع مراحل الإنتاج وحالة الطلبات بسهولة."
      >
        <button
          onClick={result.reload}
          disabled={busy}
          aria-label="تحديث التتبع"
        >
          <RefreshCw size={16} /> Refresh
        </button>
      </PageHeader>
      <div className="panel tracking-panel" aria-busy={busy}>
        <div className="tracking-filters">
          <label className="tracking-search">
            <Search size={16} />
            <input
              aria-label="البحث في الطلبات"
              placeholder="ابحث بالطلب أو العميل أو الهاتف أو المنتج أو رقم التتبع…"
              value={filters.search || ""}
              onChange={(e) => change("search", e.target.value)}
            />
          </label>
          <select
            aria-label="مرحلة الإنتاج"
            value={filters.stage || ""}
            onChange={(e) => change("stage", e.target.value)}
          >
            <option value="">جميع مراحل الإنتاج</option>
            {Object.entries(STAGE_LABELS).map(([k, v]) => (
              <option key={k} value={k}>
                {stageLabel(k)}
              </option>
            ))}
          </select>
          <select
            aria-label="حالة البلاغات"
            value={filters.issue || ""}
            onChange={(e) => change("issue", e.target.value)}
          >
            <option value="">جميع البلاغات</option>
            <option value="OPEN">البلاغات غير المحلولة</option>
            <option value="BLOCKING">البلاغات المعيقة</option>
            <option value="NONE">دون بلاغات مفتوحة</option>
          </select>
          <details className="tracking-filter-details">
            <summary>فلاتر إضافية</summary>
            <div className="filter-grid">
              <Field label="حالة التوصيل">
                <select
                  value={filters.courierStatus || ""}
                  onChange={(e) => change("courierStatus", e.target.value)}
                >
                  <option value="">جميع حالات التوصيل</option>
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
              <Field label="الموظف">
                <select
                  value={filters.employee || ""}
                  onChange={(e) => change("employee", e.target.value)}
                >
                  <option value="">جميع الموظفين</option>
                  {employees.data?.map((u) => (
                    <option key={u._id} value={u._id}>
                      {u.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="النشاط التجاري">
                <select
                  value={filters.business || ""}
                  onChange={(e) => change("business", e.target.value)}
                >
                  <option value="">الأنشطة المسموح بها</option>
                  <option value="LOGIX_ONLY">Logix</option>
                  {(user.role === "SUPER_ADMIN" ||
                    user.businessAccess?.includes("TAMQO")) && (
                    <option value="PARTNERSHIP">الشراكة</option>
                  )}
                </select>
              </Field>
              <Field label="تاريخ الإنشاء من">
                <input
                  type="date"
                  value={filters.from || ""}
                  onChange={(e) => change("from", e.target.value)}
                />
              </Field>
              <Field label="تاريخ الإنشاء إلى">
                <input
                  type="date"
                  value={filters.to || ""}
                  onChange={(e) => change("to", e.target.value)}
                />
              </Field>
              <Field label="الترتيب">
                <select
                  value={filters.sort}
                  onChange={(e) => change("sort", e.target.value)}
                >
                  <option value="oldest">الأقدم أولاً</option>
                  <option value="newest">الأحدث أولاً</option>
                  <option value="issuesFirst">
                    Issues first · oldest within priority
                  </option>
                </select>
              </Field>
              <Field label="دورة حياة الطلب">
                <select
                  value={filters.lifecycle || "ALL"}
                  onChange={(e) => change("lifecycle", e.target.value)}
                >
                  <option value="ALL">جميع الطلبات</option>
                  <option value="ACTIVE">الطلبات النشطة</option>
                  <option value="COMPLETED">
                    Completed / cancelled orders
                  </option>
                </select>
              </Field>
              <Field label="قائمة الإنتاج">
                <select
                  value={filters.attention || "all"}
                  onChange={(e) => change("attention", e.target.value)}
                >
                  <option value="all">تضمين طلبات شركة التوصيل</option>
                  <option value="internal">
                    الطلبات التي تتطلب متابعة داخلية فقط
                  </option>
                </select>
              </Field>
            </div>
          </details>
        </div>
        <div
          className="tracking-quick-filters"
          role="group"
          aria-label="فلاتر سريعة"
        >
          {QUICK_TAGS.map((tag) => (
            <button
              key={tag.value}
              className={`tracking-filter-chip ${activeTags.has(tag.value) ? "active" : ""}`}
              aria-pressed={activeTags.has(tag.value)}
              disabled={busy}
              onClick={() => toggleTag(tag)}
              title="تراعي الأعداد الفلاتر الأخرى؛ تُجمع الوسوم في الفئة نفسها بشرط «أو»."
            >
              {quickTagLabel(tag)}
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
              ? "جارٍ تحديث النتائج…"
              : result.data
                ? `${result.data.total} طلب مطابق`
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
                aria-label="تحديد الطلبات المؤهلة الظاهرة"
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
              تحديد الصفحة
            </label>
            <span>{selected.length} محدد</span>
            {can(user, P.tracking.markReady) &&
              rows.some((o) => o.allowedTargets.includes("READY_TO_SHIP")) && (
                <button
                  disabled={busy || result.loading || !selected.length}
                  onClick={() => bulk("READY_TO_SHIP")}
                >
                  تحديد كجاهز للشحن
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
                  إرجاع إلى الإنتاج
                </button>
              )}
          </div>
        )}
        {result.loading && !result.data ? (
          <Loading />
        ) : !rows.length ? (
          <Empty
            title="لا توجد طلبات في هذه القائمة"
            text="جرّب مرحلة أخرى أو غيّر البحث."
          />
        ) : (
          <div className="tracking-list">
            <div
              className="tracking-order-row tracking-head"
              aria-hidden="true"
            >
              <span />
              <span>العميل</span>
              <span>السعر الإجمالي</span>
              <span>المنتجات</span>
              <span>الإنتاج</span>
              <span>المسؤول / شركة التوصيل</span>
              <span>الإجراءات</span>
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
                        aria-label={`تحديد ${o.orderNumber}`}
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
                        aria-label={`معاينة صورة الطلب ${o.orderNumber}`}
                        onClick={() => open("image", o)}
                      >
                        <img
                          src={o.images[0].url + "?thumbnail=true"}
                          alt="صورة الطلب"
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
                            aria-label={`${o.tracking.important ? "إلغاء تمييز" : "تمييز"} ${o.orderNumber} as Important`}
                            aria-pressed={Boolean(o.tracking.important)}
                            title={
                              o.tracking.important
                                ? "إزالة علامة الأهمية"
                                : "تمييز كمهم"
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
                                  ? "أُزيلت علامة الأهمية"
                                  : "تم تمييز الطلب كمهم",
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
                            title="مهم"
                            aria-label="مهم"
                          >
                            <Star size={14} fill="currentColor" />
                          </span>
                        ) : null}
                      </div>
                      <small>{o.customer.phoneA}</small>
                    </div>
                  </div>
                  <div className="tracking-price" data-label="السعر الإجمالي">
                    {o.totalOrderValue != null &&
                    Number.isFinite(Number(o.totalOrderValue)) ? (
                      money(o.totalOrderValue)
                    ) : (
                      <span className="tracking-not-available">—</span>
                    )}
                  </div>
                  <div className="tracking-products" data-label="المنتجات">
                    {o.items.map((i, n) => (
                      <div key={n}>
                        <b>
                          {i.quantity} × {i.name}
                        </b>
                        {i.specifications && <small>{i.specifications}</small>}
                      </div>
                    ))}
                  </div>
                  <div className="tracking-stage" data-label="الإنتاج">
                    <button
                      disabled={busy || !target}
                      onClick={() => move(o, target)}
                      title={
                        target
                          ? `نقل إلى ${stageLabel(target)}`
                          : o.courierOwned
                            ? "تتحكم شركة التوصيل في هذا الطلب"
                            : o.tracking.blockingIssues
                              ? "يجب حل البلاغات المعيقة أولاً"
                              : "لا يوجد انتقال مسموح"
                      }
                      aria-label={
                        target
                          ? `${o.orderNumber}: ${stageLabel(o.tracking.stage)} ← ${stageLabel(target)}`
                          : `${o.orderNumber}: ${stageLabel(o.tracking.stage)}`
                      }
                    >
                      {stageLabel(o.tracking.stage)}
                      {target && <span aria-hidden="true"> →</span>}
                    </button>
                    <small>
                      {o.courierOwned
                        ? "هذا الطلب تحت إدارة شركة التوصيل"
                        : age(o.tracking.stageEnteredAt)}
                    </small>
                    {o.tracking.openIssues > 0 && (
                      <button
                        className={`tracking-issue-count ${o.tracking.criticalIssues ? "critical" : o.tracking.blockingIssues ? "blocking" : ""}`}
                        disabled={!can(user, P["tracking.issue"].view)}
                        onClick={() => open("issues", o)}
                      >
                        <Flag size={13} />
                        {o.tracking.openIssues} بلاغ مفتوح
                        {o.tracking.criticalIssues
                          ? " · حرج"
                          : o.tracking.blockingIssues > 0
                            ? " · معيق"
                            : ""}
                      </button>
                    )}
                  </div>
                  <div
                    className="tracking-responsible"
                    data-label="المسؤول / شركة التوصيل"
                  >
                    <span>{o.responsible.name || "لم يُعيّن موظف داخلي"}</span>
                    <small>
                      {o.shipment?.agencyName || localizedStatus(o.status)}
                      {o.shipment?.providerStatus
                        ? ` · ${localizedStatus(o.shipment.providerStatus)}`
                        : o.shipment?.status
                          ? ` · ${localizedStatus(o.shipment.status)}`
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
                        مزامنة شركة التوصيل تحتاج إلى متابعة
                      </small>
                    )}
                  </div>
                  <div className="tracking-actions">
                    {can(user, P["tracking.issue"].create) && (
                      <button disabled={busy} onClick={() => open("report", o)}>
                        إبلاغ عن مشكلة
                      </button>
                    )}
                    <details className="tracking-more">
                      <summary
                        aria-label={`إجراءات إضافية للطلب ${o.orderNumber}`}
                      >
                        <MoreHorizontal size={18} />
                        <span className="sr-only">المزيد</span>
                      </summary>
                      <div>
                        <span className="tracking-more-reference">
                          {o.orderNumber}
                        </span>
                        <ContactLink contact={o.creatorContact}>
                          التواصل مع مُنشئ الطلب
                        </ContactLink>
                        <ContactLink contact={o.responsible}>
                          التواصل مع المسؤول الحالي
                        </ContactLink>
                        {o.shipment?.url ? (
                          <a
                            href={o.shipment.url}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            عرض لدى شركة التوصيل
                          </a>
                        ) : (
                          <span className="unavailable-contact">
                            عرض لدى شركة التوصيل
                            <small>
                              {o.shipment?.tracking
                                ? "رابط التتبع الخارجي غير متاح لهذه الشركة"
                                : "لا يوجد رقم تتبع بعد"}
                            </small>
                          </span>
                        )}
                        {can(user, P["tracking.issue"].view) && (
                          <button onClick={() => open("issues", o)}>
                            البلاغات والسجل
                          </button>
                        )}
                        {can(user, P.tracking.assign) && (
                          <button onClick={() => open("assign", o)}>
                            تعيين موظف
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
                                "بدأت عملية الإنتاج",
                              )
                            }
                          >
                            بدء سير عمل الإنتاج
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
                              نقل إلى {stageLabel(t)}
                            </button>
                          ))}
                        {o.canViewOrder && (
                          <Link to={`/orders/${o._id}`}>عرض الطلب</Link>
                        )}
                        {can(user, P.audit.view) && (
                          <button onClick={() => open("history", o)}>
                            سجل تدقيق التتبع
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
          title={`${modal.kind === "report" ? "إبلاغ عن مشكلة" : modal.kind === "issues" ? "البلاغات" : modal.kind === "assign" ? "التعيين" : "سجل تدقيق التتبع"} · ${modal.order.orderNumber}`}
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
                    "تم إرسال البلاغ",
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
                    "تم حفظ التعيين",
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
      <Field label="نوع المشكلة">
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
          <option value="">اختر نوع المشكلة</option>
          {types.map((t) => (
            <option key={t._id} value={t._id}>
              {t.label}
              {t.blocksProduction ? " · يعيق الإنتاج" : ""}
            </option>
          ))}
        </select>
      </Field>
      <fieldset className="tracking-severity">
        <legend>درجة الخطورة</legend>
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
            {severityLabel(s)}
          </label>
        ))}
      </fieldset>
      <details>
        <summary>الوصف (اختياري)</summary>
        <textarea
          aria-label="الوصف"
          rows={2}
          maxLength={2000}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </details>
      <button className="primary full tracking-send" disabled={busy || !typeId}>
        {busy ? "جارٍ الإرسال…" : "إرسال"}
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
          {!result.data?.items.length && <p>لا توجد بلاغات بعد.</p>}
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
                {localizedStatus(i.typeSnapshot.label)}
              </b>
              <span>
                {severityLabel(i.severity)} · {localizedStatus(i.status)}
                {i.blocking ? " · يعيق الإنتاج" : ""}
              </span>
              {i.description && <p>{i.description}</p>}
              <small>
                أبلغ عنه {i.reporter.name} ·{" "}
                {i.reporterRoles.map(localizedStatus).join(", ") || "الموظف"} ·{" "}
                {date(i.createdAt)}
              </small>
              <ContactLink contact={i.reporterContact}>
                التواصل مع مُقدّم البلاغ
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
                          "تم حل البلاغ",
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
        ["المصمم", designerId, setDesigner, ["DESIGNER"]],
        [
          "موظف / مدير الإنتاج",
          productionId,
          setProduction,
          ["PRODUCTION", "PRODUCTION_MANAGER"],
        ],
      ].map(([label, value, set, roles]) => (
        <Field key={label} label={label}>
          <select value={value} onChange={(e) => set(e.target.value)}>
            <option value="">غير معيّن</option>
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
            <b>{localizedStatus(e.kind)}</b>
            <span>
              {stageLabel(e.previousStage)} → {stageLabel(e.newStage)}
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
