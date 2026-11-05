import { Fragment, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
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
  SlidersHorizontal,
  ArrowDownUp,
  MessageSquareText,
  ShoppingBag,
  CalendarDays,
  Image as ImageIcon,
} from "lucide-react";
import { api, useApi, params, money, date } from "../api";
import { P, can, useUser } from "../access";
import { MediaGallery } from "../MediaGallery";
import {
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
  DELETED: "محذوف",
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
  DELETED: "محذوف",
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
  LT4D: "أقل من 4 أيام",
  GTE4D: "4 أيام فأكثر",
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
// Creation age is independent of the time spent in the current production stage.
const creationPeriod = (value) => {
  const timestamp = value ? new Date(value).getTime() : NaN;
  if (!Number.isFinite(timestamp)) return "تاريخ غير معروف";
  const hours = Math.max(0, Math.floor((Date.now() - timestamp) / 3600000));
  return hours < 1
    ? "منذ أقل من ساعة"
    : hours < 24
      ? `منذ ${hours} ساعة`
      : `منذ ${Math.floor(hours / 24)} يوم`;
};
const creationDay = (value) => {
  const timestamp = value ? new Date(value).getTime() : NaN;
  return Number.isFinite(timestamp)
    ? new Intl.DateTimeFormat("ar-DZ", {
        day: "numeric",
        month: "long",
        year: "numeric",
        timeZone: "Africa/Algiers",
      }).format(timestamp)
    : "تاريخ غير معروف";
};
const itemCount = (order) =>
  (order.items || []).reduce(
    (total, item) => total + (Number(item.quantity) || 0),
    0,
  );
const orderTotal = (order) =>
  order.totalOrderValue != null &&
  Number.isFinite(Number(order.totalOrderValue))
    ? Number(order.totalOrderValue)
    : null;
const nextStage = (order) => {
  // Forward progress belongs on the badge; reversals stay in the action menu.
  const next = { PREPARING: "AT_PRODUCTION", AT_PRODUCTION: "READY_TO_SHIP" }[
    order.tracking.stage
  ];
  return !order.deleted &&
    !order.courierOwned &&
    order.allowedTargets.includes(next)
    ? next
    : null;
};

/** Fixed positioning keeps the action menu outside the scrolling desktop table. */
function OrderMenu({ orderNumber, children }) {
  const ref = useRef(null);
  const menuRef = useRef(null);
  const [position, setPosition] = useState(null);
  useEffect(() => {
    const dismiss = () => {
      ref.current?.removeAttribute("open");
      setPosition(null);
    };
    const close = (event) => {
      if (
        !ref.current?.contains(event.target) &&
        !menuRef.current?.contains(event.target)
      )
        dismiss();
    };
    const escape = (event) => {
      if (event.key === "Escape" && ref.current?.open) {
        dismiss();
        ref.current.querySelector("summary")?.focus();
      }
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    window.addEventListener("resize", dismiss);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", escape);
      window.removeEventListener("resize", dismiss);
    };
  }, []);
  useEffect(() => {
    if (position)
      menuRef.current
        ?.querySelector("a[href], button:not(:disabled)")
        ?.focus({ preventScroll: true });
  }, [position]);
  return (
    <>
      <details
        ref={ref}
        className="tracking-more"
        onToggle={(event) => {
          if (!event.currentTarget.open) {
            setPosition(null);
            return;
          }
          const rect = event.currentTarget.getBoundingClientRect();
          const width = Math.min(280, window.innerWidth - 24);
          setPosition({
            width,
            left: Math.max(
              12,
              Math.min(rect.left, window.innerWidth - width - 12),
            ),
            top: Math.max(
              12,
              Math.min(rect.bottom + 6, window.innerHeight - 412),
            ),
          });
        }}
      >
        <summary
          aria-label={`إجراءات إضافية للطلب ${orderNumber}`}
          aria-expanded={Boolean(position)}
        >
          <MoreHorizontal size={18} />
        </summary>
      </details>
      {position &&
        createPortal(
          <div
            className="tracking-page tracking-menu-portal"
            dir="rtl"
            lang="ar"
          >
            <div className="tracking-more">
              <div
                ref={menuRef}
                className="tracking-order-menu"
                style={position}
                role="region"
                aria-label={`إجراءات الطلب ${orderNumber}`}
                onKeyDown={(event) => {
                  if (event.key === "Tab") {
                    const items = menuRef.current.querySelectorAll(
                      "a[href], button:not(:disabled)",
                    );
                    if (
                      (!event.shiftKey &&
                        event.target === items[items.length - 1]) ||
                      (event.shiftKey && event.target === items[0])
                    ) {
                      event.preventDefault();
                      ref.current.removeAttribute("open");
                      setPosition(null);
                      ref.current.querySelector("summary").focus();
                    }
                  }
                }}
                onClick={(event) => {
                  if (event.target.closest("button, a")) {
                    ref.current.removeAttribute("open");
                    setPosition(null);
                  }
                }}
              >
                {children}
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
function OrderThumbnail({ order, onOpen }) {
  const [failed, setFailed] = useState(false);
  const image = order.images?.[0];
  if (!image?.url || failed) {
    return (
      <span
        className="tracking-order-thumbnail tracking-thumbnail-placeholder"
        role="img"
        aria-label="لا توجد صورة متاحة للطلب"
        title="لا توجد صورة متاحة"
      >
        <ImageIcon size={19} aria-hidden="true" />
      </span>
    );
  }
  return (
    <button
      type="button"
      className="tracking-order-thumbnail"
      aria-label={`تكبير صورة الطلب ${order.orderNumber}`}
      title="تكبير الصورة"
      onClick={onOpen}
    >
      <img
        src={`${image.url}${image.url.includes("?") ? "&" : "?"}thumbnail=true`}
        alt=""
        width={40}
        height={40}
        loading="lazy"
        onError={() => setFailed(true)}
      />
    </button>
  );
}

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
        dir="auto"
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
            title="انقر لتصغير الصورة"
            role="button"
            tabIndex={0}
            aria-label="تصغير الصورة والعودة إلى الطلبات"
            onClick={onClose}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onClose();
              }
            }}
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
      ...(key === "lifecycle" && value === "READINESS_DELETED"
        ? { stage: "", attention: "all", tags: "", issue: "" }
        : {}),
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
      <header className="tracking-page-heading">
        <h1>
          <ShoppingBag size={22} aria-hidden="true" /> الطلبات
        </h1>
        <button
          onClick={result.reload}
          disabled={busy || result.loading}
          aria-label="تحديث التتبع"
        >
          <RefreshCw size={16} />
          <span>تحديث</span>
        </button>
      </header>
      <section
        className="tracking-summary"
        aria-label="ملخص الطلبات في الصفحة الحالية"
      >
        <span className="tracking-summary-period">
          <CalendarDays size={16} /> هذه الصفحة
        </span>
        {[
          ["الطلبات", rows.length],
          ["إجمالي القطع", rows.reduce((sum, o) => sum + itemCount(o), 0)],
          [
            "القيمة الإجمالية",
            rows.every((o) => orderTotal(o) !== null)
              ? money(rows.reduce((sum, o) => sum + orderTotal(o), 0))
              : "—",
          ],
          [
            "جاهز للشحن",
            rows.filter(
              (o) => !o.deleted && o.tracking.stage === "READY_TO_SHIP",
            ).length,
          ],
          [
            "البلاغات المفتوحة",
            rows.reduce((sum, o) => sum + (o.tracking.openIssues || 0), 0),
          ],
        ].map(([label, value]) => (
          <div key={label}>
            <span>{label}</span>
            <strong>
              <bdi>{result.loading ? "…" : value}</bdi>
            </strong>
          </div>
        ))}
      </section>
      <div className="panel tracking-panel" aria-busy={busy || result.loading}>
        <div className="tracking-filters">
          <label className="tracking-search">
            <Search size={16} />
            <input
              aria-label="البحث في الطلبات"
              placeholder="بحث في الطلبات"
              value={filters.search || ""}
              onChange={(e) => change("search", e.target.value)}
            />
          </label>
          <button
            className="tracking-sort"
            aria-label={
              filters.sort === "newest"
                ? "ترتيب الأقدم أولاً"
                : "ترتيب الأحدث أولاً"
            }
            title={
              filters.sort === "newest"
                ? "الأحدث أولاً"
                : filters.sort === "oldest"
                  ? "الأقدم أولاً"
                  : "المشكلات أولاً"
            }
            onClick={() =>
              change("sort", filters.sort === "newest" ? "oldest" : "newest")
            }
          >
            <ArrowDownUp size={18} />
          </button>
          <details className="tracking-filter-details">
            <summary aria-label="تصفية الطلبات">
              <SlidersHorizontal size={18} />
              <span>الفلاتر</span>
            </summary>
            <div className="filter-grid">
              <Field label="مرحلة الإنتاج">
                <select
                  aria-label="مرحلة الإنتاج"
                  value={filters.stage || ""}
                  onChange={(e) => change("stage", e.target.value)}
                >
                  <option value="">جميع مراحل الإنتاج</option>
                  {Object.entries(STAGE_LABELS).map(([k]) => (
                    <option key={k} value={k}>
                      {stageLabel(k)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="حالة البلاغات">
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
              </Field>
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
                    <option key={s} value={s}>
                      {localizedStatus(s)}
                    </option>
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
                  <option value="issuesFirst">المشكلات أولاً ثم الأقدم</option>
                </select>
              </Field>
              <Field label="دورة حياة الطلب">
                <select
                  value={filters.lifecycle || "ALL"}
                  onChange={(e) => change("lifecycle", e.target.value)}
                >
                  <option value="ALL">جميع الطلبات</option>
                  <option value="ACTIVE">الطلبات النشطة</option>
                  <option value="COMPLETED">الطلبات المكتملة أو الملغاة</option>
                  <option value="READINESS_DELETED">
                    الطلبات المحذوفة لدى شركة التوصيل
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
              <div className="tracking-extra-filters">
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
                    مسح الفلاتر
                  </button>
                  <button disabled={busy} onClick={() => resetFilters(true)}>
                    عرضي الافتراضي
                  </button>
                </div>
              </div>
            </div>
          </details>
        </div>
        <nav className="tracking-view-tabs" aria-label="مراحل الطلبات">
          {[
            ["", "الكل"],
            ["PREPARING", "قيد التحضير"],
            ["AT_PRODUCTION", "قيد الإنتاج"],
            ["READY_TO_SHIP", "جاهز للشحن"],
          ].map(([stage, label]) => (
            <button
              key={stage}
              className={(filters.stage || "") === stage ? "active" : ""}
              aria-pressed={(filters.stage || "") === stage}
              onClick={() => change("stage", stage)}
            >
              {label}
            </button>
          ))}
        </nav>
        <ErrorBox
          error={error || result.error || types.error || employees.error}
        />
        {message && (
          <p className="success" role="status">
            {message}
          </p>
        )}
        {can(user, P.tracking.bulkUpdate) && selected.length > 0 && (
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
          <div
            className="tracking-list"
            role="region"
            aria-label="قائمة الطلبات"
            tabIndex={0}
          >
            <div className="tracking-order-row tracking-head">
              <span className="tracking-selection">
                {can(user, P.tracking.bulkUpdate) && (
                  <input
                    type="checkbox"
                    aria-label="تحديد كل الطلبات المؤهلة"
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
                  />
                )}
              </span>{" "}
              <span>الطلب</span>
              <span>منذ الإنشاء</span>
              <span>العميل</span>
              <span>الإجمالي</span>
              <span>الملاحظات والبلاغات</span>
              <span>حالة الطلب</span>
              <span>القطع</span>
              <span>المسؤول / التوصيل</span>
              <span>الإجراءات</span>
            </div>
            {rows.map((o, index) => {
              const target = nextStage(o);
              const status =
                o.courierOwned || o.deleted
                  ? o.displayStatus || o.status
                  : o.tracking.stage;
              const label =
                o.courierOwned || o.deleted
                  ? localizedStatus(status)
                  : stageLabel(status);
              const day = creationDay(o.createdAt);
              return (
                <Fragment key={o._id}>
                  {(index === 0 ||
                    day !== creationDay(rows[index - 1].createdAt)) && (
                    <h2 className="tracking-date-group">{day}</h2>
                  )}
                  <article
                    className={`tracking-order-row stage-${status.toLowerCase()} ${o.deleted ? "readiness-deleted" : ""}`}
                    aria-label={o.orderNumber}
                  >
                    <div className="tracking-selection">
                      {can(user, P.tracking.bulkUpdate) && (
                        <input
                          type="checkbox"
                          aria-label={`تحديد ${o.orderNumber}`}
                          checked={selected.includes(o._id)}
                          disabled={
                            busy ||
                            result.loading ||
                            !selectable.some((row) => row._id === o._id)
                          }
                          onChange={(e) =>
                            setSelected((ids) =>
                              e.target.checked
                                ? [...ids, o._id]
                                : ids.filter((id) => id !== o._id),
                            )
                          }
                        />
                      )}
                    </div>
                    <div className="tracking-identity">
                      <OrderThumbnail
                        key={o.images?.[0]?.url || "no-image"}
                        order={o}
                        onOpen={() => open("image", o)}
                      />
                      {o.canViewOrder ? (
                        <Link to={`/orders/${o._id}`}>
                          <bdi>{o.orderNumber}</bdi>
                        </Link>
                      ) : (
                        <strong>
                          <bdi>{o.orderNumber}</bdi>
                        </strong>
                      )}
                      {o.canMarkImportant ? (
                        <button
                          className={`tracking-important ${o.tracking.important ? "active" : ""}`}
                          aria-label={`${o.tracking.important ? "إلغاء تمييز" : "تمييز"} ${o.orderNumber} كمهم`}
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
                    <div className="tracking-metadata">
                      <span className="tracking-created" title={day}>
                        {creationPeriod(o.createdAt)}
                      </span>
                      <span
                        className="tracking-customer"
                        title={o.customer.phoneA}
                      >
                        <bdi>{o.customer.name}</bdi>
                      </span>
                      <span
                        className="tracking-item-count"
                        title={o.items
                          .map((i) => `${i.quantity} × ${i.name}`)
                          .join("، ")}
                      >
                        <bdi>{itemCount(o)} قطعة</bdi>
                      </span>
                    </div>
                    <div className="tracking-price" aria-label="السعر الإجمالي">
                      <bdi>
                        {orderTotal(o) === null ? "—" : money(orderTotal(o))}
                      </bdi>
                    </div>
                    <div className="tracking-badges">
                      <div className="tracking-reports">
                        {o.tracking.openIssues > 0 ? (
                          <button
                            className={`tracking-badge tracking-issue-count ${o.tracking.criticalIssues ? "critical" : o.tracking.blockingIssues ? "blocking" : ""}`}
                            disabled={!can(user, P["tracking.issue"].view)}
                            onClick={() => open("issues", o)}
                          >
                            <MessageSquareText size={13} />
                            {o.tracking.openIssues} بلاغ
                            {o.tracking.criticalIssues
                              ? " · حرج"
                              : o.tracking.blockingIssues
                                ? " · معيق"
                                : " مفتوح"}
                          </button>
                        ) : o.note ? (
                          <span
                            className="tracking-badge tracking-note"
                            title={o.note}
                          >
                            <MessageSquareText size={13} />
                            ملاحظة
                          </span>
                        ) : (
                          <span className="tracking-no-reports">—</span>
                        )}
                      </div>
                      <div className="tracking-stage">
                        {target ? (
                          <button
                            className="tracking-badge tracking-stage-current"
                            disabled={busy || result.loading}
                            onClick={() => move(o, target)}
                            title={`نقل إلى ${stageLabel(target)}`}
                            aria-label={`نقل طلب ${o.customer.name} إلى ${stageLabel(target)}`}
                          >
                            <span className="tracking-status-dot" />
                            {label}
                            <ArrowLeft size={12} />
                          </button>
                        ) : (
                          <span
                            className="tracking-badge tracking-stage-current"
                            aria-label={`الحالة الحالية: ${label}`}
                          >
                            <span className="tracking-status-dot" />
                            {label}
                          </span>
                        )}
                      </div>
                      <div className="tracking-actions">
                        {!o.deleted &&
                          can(user, P["tracking.issue"].create) && (
                            <button
                              className="tracking-report-action"
                              aria-label="إبلاغ عن مشكلة"
                              title="إبلاغ عن مشكلة"
                              disabled={busy}
                              onClick={() => open("report", o)}
                            >
                              <Flag size={15} aria-hidden="true" />
                              <span>إبلاغ عن مشكلة</span>
                            </button>
                          )}
                        <OrderMenu orderNumber={o.orderNumber}>
                          <div className="tracking-order-details">
                            <strong>
                              <bdi>{o.customer.name}</bdi>
                            </strong>
                            <bdi>{o.customer.phoneA}</bdi>
                            <span>أُنشئ في {creationDay(o.createdAt)}</span>
                            <span>
                              المسؤول: <bdi>{o.responsible.name || "—"}</bdi>
                            </span>
                            {o.shipment?.tracking && (
                              <bdi>{o.shipment.tracking}</bdi>
                            )}
                            {o.shipment?.status && (
                              <span>{localizedStatus(o.shipment.status)}</span>
                            )}
                            {o.items.map((item, index) => (
                              <p key={index}>
                                <bdi>
                                  {item.quantity} × {item.name}
                                </bdi>
                                {item.specifications && (
                                  <small dir="auto">
                                    {item.specifications}
                                  </small>
                                )}
                              </p>
                            ))}
                            {o.note && <p dir="auto">{o.note}</p>}
                            {o.images.length > 0 && (
                              <button onClick={() => open("image", o)}>
                                عرض صور الطلب ({o.images.length})
                              </button>
                            )}
                          </div>
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
                          {!o.deleted && can(user, P.tracking.assign) && (
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
                        </OrderMenu>
                      </div>
                    </div>
                    <div className="tracking-responsible">
                      <span>
                        <bdi>
                          {o.courierOwned
                            ? o.shipment?.agencyName || "شركة التوصيل"
                            : o.responsible.name || "—"}
                        </bdi>
                      </span>
                      {o.shipment?.status && (
                        <small title={o.shipment.providerStatus}>
                          {localizedStatus(o.shipment.status)}
                        </small>
                      )}
                      {o.shipment?.tracking && (
                        <small>
                          <bdi>{o.shipment.tracking}</bdi>
                        </small>
                      )}
                    </div>
                  </article>
                </Fragment>
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
          <div className="modal-body" dir="rtl">
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
                <summary>المرفقات ({i.attachments?.length || 0})</summary>
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
                    تحديد كمحلول
                  </button>
                )}
              {i.status === "RESOLVED" && (
                <small>
                  تم الحل بواسطة {i.resolvedBy?.name} · {date(i.resolvedAt)}
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
        حفظ التعيين
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
