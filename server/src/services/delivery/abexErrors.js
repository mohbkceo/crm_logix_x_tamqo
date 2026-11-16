import { AppError } from "../../errors.js";

// Single source of truth for ABEX shipping failures. Every entry has a stable
// code, an English message, an Arabic message for CRM users, the form field it
// relates to (when there is one), the action that resolves it, and whether the
// same request may simply be sent again.
//
// retryable: the identical request can be repeated without creating a duplicate.
// reconcile: the outcome at ABEX is unknown or may already exist. The shipment
//            must be verified (Refresh tracking / Reconcile) before a new attempt.
const catalog = {
  ABEX_HUB_REQUIRED: {
    status: 409,
    message:
      "No compatible ABEX pickup office was found for the selected commune. Choose an available office or change the delivery method.",
    messageAr:
      "لم يتم العثور على مكتب ABEX متوافق مع البلدية المحددة. اختر مكتباً متاحاً أو غيّر طريقة التوصيل.",
    field: "pickupHubId",
    action: "CHANGE_DELIVERY_TYPE",
  },
  ABEX_HUB_SELECTION_REQUIRED: {
    status: 409,
    message:
      "More than one ABEX pickup office can serve this destination. Choose the pickup office on the order.",
    messageAr:
      "توجد عدة مكاتب ABEX متاحة لهذه الوجهة. اختر مكتب الاستلام في الطلب.",
    field: "pickupHubId",
    action: "CHOOSE_PICKUP_HUB",
  },
  ABEX_HUB_INVALID: {
    status: 409,
    message:
      "The selected ABEX pickup office is no longer available for this wilaya. Choose another office.",
    messageAr: "مكتب ABEX المختار لم يعد متاحاً لهذه الولاية. اختر مكتباً آخر.",
    field: "pickupHubId",
    action: "CHOOSE_PICKUP_HUB",
  },
  ABEX_HUB_MAPPING_STALE: {
    status: 409,
    message:
      "The pickup office configured for this commune is no longer valid in ABEX. Choose an office on the order, or ask an administrator to update the ABEX mapping.",
    messageAr:
      "مكتب الاستلام المضبوط لهذه البلدية لم يعد صالحاً لدى ABEX. اختر مكتباً في الطلب أو اطلب من المسؤول تحديث الربط.",
    field: "pickupHubId",
    action: "UPDATE_HUB_MAPPING",
  },
  ABEX_TERRITORY_REQUIRED: {
    status: 409,
    message:
      "ABEX could not verify the commune for this wilaya. Edit the order and select a commune for the correct wilaya.",
    messageAr:
      "تعذر التحقق من البلدية لدى ABEX. عدّل الطلب واختر بلدية تابعة للولاية الصحيحة.",
    field: "commune",
    action: "EDIT_ADDRESS",
  },
  ABEX_DELIVERY_UNSUPPORTED: {
    status: 409,
    message:
      "The selected delivery service is not currently available for this area.",
    messageAr: "خدمة التوصيل المختارة غير متوفرة حالياً لهذه المنطقة.",
    field: "deliveryType",
    action: "CHANGE_DELIVERY_TYPE",
  },
  ABEX_EXCHANGE_UNSUPPORTED: {
    status: 409,
    message:
      "ABEX exchanges require an existing provider parcel and must be arranged in the courier portal.",
    messageAr:
      "طرود الاستبدال تتطلب طرداً أصلياً لدى ABEX ويجب ترتيبها من بوابة شركة التوصيل.",
    field: "exchange",
    action: "USE_COURIER_PORTAL",
  },
  ABEX_ORDER_INVALID: {
    status: 409,
    message: "The order is missing information required to create a parcel.",
    messageAr:
      "بيانات الطلب غير مكتملة أو غير صالحة للشحن. راجع الحقول المشار إليها.",
    action: "EDIT_ORDER",
  },
  ABEX_MAPPING_INVALID: {
    status: 422,
    message: "This ABEX mapping could not be verified against the ABEX catalog.",
    messageAr: "تعذر التحقق من هذا الربط مع بيانات ABEX.",
    action: "UPDATE_HUB_MAPPING",
  },
  ABEX_VALIDATION: {
    status: 422,
    message: "ABEX rejected the parcel data.",
    messageAr: "رفضت ABEX بيانات الطرد. راجع الحقول المشار إليها.",
    action: "EDIT_ORDER",
  },
  ABEX_AUTHENTICATION: {
    status: 502,
    message: "ABEX rejected the credentials. Check or rotate the API credentials.",
    messageAr:
      "رفضت ABEX بيانات الاعتماد. يجب على المسؤول التحقق من مفتاح API ومعرّف الحساب.",
    action: "CHECK_CREDENTIALS",
  },
  ABEX_PERMISSION: {
    status: 502,
    message: "ABEX denied access. Check the tenant and supplier role.",
    messageAr: "رفضت ABEX الوصول. يجب على المسؤول التحقق من صلاحيات الحساب.",
    action: "CHECK_CREDENTIALS",
  },
  ABEX_NOT_FOUND: {
    status: 404,
    message: "ABEX could not find the requested record.",
    messageAr: "لم تعثر ABEX على السجل المطلوب.",
    action: "CONTACT_ADMIN",
  },
  ABEX_PRICING_NOT_FOUND: {
    status: 404,
    message:
      "ABEX has no delivery price assigned to this supplier for the requested route.",
    messageAr: "لا توجد تسعيرة توصيل معيّنة لهذا المسار لدى ABEX.",
    action: "CONTACT_ADMIN",
  },
  ABEX_CONFLICT: {
    status: 409,
    message: "ABEX reported a conflict. Verify the parcel in the courier portal.",
    messageAr:
      "أبلغت ABEX عن تعارض وقد يكون الطرد موجوداً مسبقاً. تحقق من حالة الشحنة قبل إعادة المحاولة.",
    action: "VERIFY_SHIPMENT",
    reconcile: true,
  },
  ABEX_RATE_LIMIT: {
    status: 503,
    message: "ABEX rate limit reached. Try again after the quota resets.",
    messageAr: "تم بلوغ حد الطلبات لدى ABEX. أعد المحاولة بعد قليل.",
    action: "RETRY_LATER",
    retryable: true,
  },
  ABEX_TIMEOUT: {
    status: 504,
    message:
      "ABEX did not respond in time. Verify any pending parcel operation before retrying.",
    messageAr:
      "لم تستجب ABEX في الوقت المحدد. تحقق من حالة الشحنة قبل إعادة المحاولة.",
    action: "VERIFY_SHIPMENT",
  },
  ABEX_UNAVAILABLE: {
    status: 502,
    message: "ABEX could not complete the request.",
    messageAr:
      "تعذر الاتصال بخدمة ABEX حالياً. تحقق من حالة الشحنة قبل إعادة المحاولة.",
    action: "VERIFY_SHIPMENT",
  },
  ABEX_INVALID_RESPONSE: {
    status: 502,
    message: "ABEX returned an invalid or incomplete response.",
    messageAr:
      "أعادت ABEX رداً غير مكتمل. تحقق من حالة الشحنة قبل إعادة المحاولة.",
    action: "VERIFY_SHIPMENT",
  },
  DELIVERY_NOT_CONFIGURED: {
    status: 503,
    message: "ABEX is not configured. Contact your administrator.",
    messageAr: "خدمة ABEX غير مهيأة أو أن إنشاء الطرود متوقف. تواصل مع المسؤول.",
    action: "CONTACT_ADMIN",
  },
  RECONCILIATION_REQUIRED: {
    status: 409,
    message:
      "A parcel creation was already attempted. Reconcile tracking before another attempt.",
    messageAr:
      "توجد محاولة سابقة لإنشاء الطرد. تحقق من حالة الشحنة قبل أي محاولة جديدة.",
    action: "VERIFY_SHIPMENT",
    reconcile: true,
  },
};

const detailKeys = [
  "messageAr",
  "field",
  "fields",
  "action",
  "retryable",
  "reconcile",
  "alternative",
];

export const abexErrorCodes = Object.keys(catalog);

export function abexErrorDetails(code, overrides = {}) {
  const entry = catalog[code] || {};
  const details = {
    retryable: false,
    reconcile: false,
    ...Object.fromEntries(
      detailKeys.filter((key) => key in entry).map((key) => [key, entry[key]]),
    ),
    ...Object.fromEntries(
      detailKeys
        .filter((key) => overrides[key] !== undefined)
        .map((key) => [key, overrides[key]]),
    ),
  };
  return details;
}

export function abexError(code, overrides = {}) {
  const entry = catalog[code];
  if (!entry) throw new Error(`Unknown ABEX error code ${code}`);
  return new AppError(
    overrides.message || entry.message,
    overrides.status || entry.status,
    code,
    abexErrorDetails(code, overrides),
  );
}

export function abexAssert(condition, code, overrides) {
  if (!condition) throw abexError(code, overrides);
}

// Adds catalog details to an AppError raised elsewhere with a known code
// (for example the shared write-flag and reservation checks).
export function withAbexDetails(error) {
  if (error instanceof AppError && !error.details && catalog[error.code])
    error.details = abexErrorDetails(error.code);
  return error;
}

// Client-safe view of an error. Only allowlisted keys leave the server.
export function publicErrorDetails(error) {
  const details = error?.details;
  if (!details || typeof details !== "object") return {};
  return Object.fromEntries(
    detailKeys
      .filter((key) => details[key] !== undefined && details[key] !== null)
      .map((key) => [key, details[key]]),
  );
}

// Compact record stored beside Shipment.lastError so the order page can show
// the same guidance later. `message` lets the client ignore a stale record.
export function shipmentErrorInfo(error, message) {
  if (!(error instanceof AppError) || !error.code) return undefined;
  return {
    code: error.code,
    message: message ?? error.message,
    ...publicErrorDetails(withAbexDetails(error)),
  };
}
