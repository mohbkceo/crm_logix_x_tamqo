import path from "node:path";
import { createHash } from "node:crypto";
import * as XLSX from "xlsx";
import {
  Expense,
  ImportBatch,
  ImportMapping,
  LogixProduct,
  Order,
  OrderEvent,
  Shipment,
  TamqoPlan,
  Wilaya,
} from "../models/index.js";
import { audit } from "../models/security.js";
import { assert, AppError } from "../errors.js";
import { hasBusinessAccess, orderBusinesses } from "../authorization.js";
import {
  calculateFinancials,
  canProviderTransition,
  normalizePhone,
  round,
} from "../domain/order.js";
import {
  allocateOrderNumber,
  materialize,
  transaction,
} from "./orderService.js";

const MAX_ROWS = 5000;
const FAILURE_FEE = 150;

/*
 * Commune is intentionally NOT critical.
 *
 * If Commune is absent/empty, the importer automatically
 * uses the Wilaya name as the Commune.
 */
const CRITICAL_COLUMNS = [
  "client",
  "mobile1",
  "wilaya",
  "product",
  "situation",
];

const COLUMN_ALIASES = {
  date: ["date", "order date"],
  tracking: ["tracking", "tracking number", "numero tracking", "suivi"],
  excelId: ["id", "order id", "commande id"],
  client: ["client", "customer", "nom client"],
  mobile1: ["mobile1", "mobile 1", "telephone", "telephone 1", "phone"],
  mobile2: ["mobile2", "mobile 2", "telephone 2", "phone 2"],
  address: ["adresse", "address"],
  wilaya: ["wilaya", "province"],
  commune: ["commune", "municipality"],
  product: ["produit", "product", "article"],
  note: ["note", "notes"],
  situation: ["situation", "status", "statut"],
  comment: ["commentaire", "comment", "comments"],
  actionDate: ["date action", "action date", "dateaction"],
  total: ["total", "montant", "amount"],
  deliveryFee: [
    "frais de livraison",
    "frais livraison",
    "delivery fee",
    "shipping fee",
  ],
};

export function normalizeImportText(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

const normalizedAliases = new Map(
  Object.entries(COLUMN_ALIASES).flatMap(([key, aliases]) =>
    aliases.map((alias) => [normalizeImportText(alias), key]),
  ),
);

export function mapImportSituation(value) {
  const normalized = normalizeImportText(value);

  if (
    normalized === "livree" ||
    normalized.startsWith("livree encaisser") ||
    normalized.startsWith("livree recouvert")
  ) {
    return {
      status: "DELIVERED",
      delivered: true,
      known: true,
    };
  }

  if (
    [
      "retour client",
      "retour livreur",
      "retour navette",
      "retour de dispatche",
    ].includes(normalized)
  ) {
    return {
      status: "RETURNED",
      fee: true,
      known: true,
    };
  }

  if (normalized === "annuler par le client") {
    return {
      status: "CANCELLED",
      fee: true,
      known: true,
    };
  }

  if (normalized === "en livraison") {
    return {
      status: "OUT_FOR_DELIVERY",
      known: true,
    };
  }

  if (["en preparation", "en traitement"].includes(normalized)) {
    return {
      status: "PREPARING",
      known: true,
    };
  }

  if (normalized === "dispatcher") {
    return {
      status: "READY_TO_SHIP",
      known: true,
    };
  }

  if (
    ["sd en attente du client", "sd appel sans reponse", "a relance"].includes(
      normalized,
    )
  ) {
    return {
      status: "CONFIRMED",
      known: true,
      safeFallback: true,
    };
  }

  return {
    status: "CONFIRMED",
    known: false,
    safeFallback: true,
  };
}

function safeFilename(filename) {
  return path
    .basename(String(filename || "upload"))
    .split("")
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code >= 32 && code !== 127;
    })
    .join("")
    .slice(0, 255);
}

function hasControlCharacters(value) {
  return [...String(value)].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
}

function moneyValue(value) {
  let text = String(value ?? "")
    .replace(/\bda\b/gi, "")
    .replace(/\s/g, "")
    .trim();

  if (!text) return null;

  if (text.includes(",") && text.includes(".")) {
    text = text.replace(/,/g, "");
  } else if ((text.match(/,/g) || []).length === 1) {
    const decimals = text.split(",")[1]?.length;

    text = decimals === 3 ? text.replace(",", "") : text.replace(",", ".");
  } else {
    text = text.replace(/,/g, "");
  }

  const number = Number(text.replace(/[^0-9.-]/g, ""));

  return Number.isFinite(number) ? round(number) : NaN;
}

function excelDate(value) {
  if (value == null || value === "") return null;

  if (value instanceof Date && Number.isFinite(+value)) {
    return value;
  }

  const text = String(value).trim();

  let match = text.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})/);

  if (match) {
    const date = new Date(
      `${match[3]}-${match[2].padStart(2, "0")}-${match[1].padStart(
        2,
        "0",
      )}T00:00:00+01:00`,
    );

    return Number.isFinite(+date) ? date : null;
  }

  match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);

  if (match) {
    const date = new Date(
      `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(
        2,
        "0",
      )}T00:00:00+01:00`,
    );

    return Number.isFinite(+date) ? date : null;
  }

  const date = new Date(text);

  return Number.isFinite(+date) ? date : null;
}

/*
 * Normalize imported phone values before the application's
 * strict normalizePhone() validation.
 *
 * Examples:
 *
 * "Tel: 0550 12 34 56"
 * -> 0550123456
 *
 * "0550-12-34-56 test"
 * -> 0550123456
 *
 * "+213 550 12 34 56"
 * -> 213550123456
 *
 * "00213 550 12 34 56"
 * -> 213550123456
 *
 * "550123456"
 * -> 0550123456
 */
function normalizeImportedPhone(value) {
  let digits = String(value ?? "").replace(/\D/g, "");

  if (!digits) return "";

  /*
   * First handle exact common formats.
   */

  if (/^00213[567]\d{8}$/.test(digits)) {
    return digits.slice(2);
  }

  if (/^213[567]\d{8}$/.test(digits)) {
    return digits;
  }

  if (/^0[567]\d{8}$/.test(digits)) {
    return digits;
  }

  /*
   * Excel may store a phone as a number and remove
   * the leading zero.
   *
   * 550123456 -> 0550123456
   */
  if (/^[567]\d{8}$/.test(digits)) {
    return `0${digits}`;
  }

  /*
   * If the Excel cell contained textual/noisy content,
   * try to extract a valid Algerian number from the digits.
   */

  const international00213 = digits.match(/00213[567]\d{8}/);

  if (international00213) {
    return international00213[0].slice(2);
  }

  const international213 = digits.match(/213[567]\d{8}/);

  if (international213) {
    return international213[0];
  }

  const local = digits.match(/0[567]\d{8}/);

  if (local) {
    return local[0];
  }

  /*
   * Last fallback:
   * remove non-numeric characters as requested.
   *
   * Strict validation later will still reject the row if
   * the remaining digits are not a valid Algerian number.
   */
  return digits;
}

/*
 * Mobile2 is optional.
 *
 * Invalid garbage in Mobile2 should not make an otherwise
 * valid order fail during materialize().
 */
function validImportedPhoneOrEmpty(value) {
  const phone = normalizeImportedPhone(value);

  if (!phone) return "";

  try {
    normalizePhone(phone);
    return phone;
  } catch {
    return "";
  }
}

function normalizedWilaya(value) {
  return normalizeImportText(value).replace(/^\d{1,2}\s*/, "");
}

function normalizedProductText(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\bstande?s?\b/g, "stand")
    .replace(/\bplaques?\b/g, "plaque")
    .replace(/(\d)\s*[x*/×]\s*(\d)/g, "$1x$2")
    .replace(/[^a-z0-9+&;,]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function productDimension(value) {
  const normalized = normalizedProductText(value);

  for (const size of [15, 20]) {
    if (
      new RegExp(`\\b${size}\\s*x\\s*${size}\\b`).test(normalized) ||
      new RegExp(`\\b${size}\\s*cm\\b`).test(normalized) ||
      (normalized.includes("plaque") &&
        new RegExp(`\\b${size}\\b`).test(normalized))
    ) {
      return size;
    }
  }

  return null;
}

function productKind(value) {
  const normalized = normalizedProductText(value);
  const dimension = productDimension(normalized);

  if (
    normalized.includes("plaque") ||
    (dimension && !normalized.includes("stand"))
  ) {
    return {
      type: "PLAQUE",
      dimension,
      mini: false,
    };
  }

  if (/\bstand\b/.test(normalized)) {
    return {
      type: "STAND",
      dimension: null,
      mini: /\bmini\b/.test(normalized),
    };
  }

  return null;
}

function productSegments(value) {
  return String(value ?? "")
    .split(/\s*(?:\+|&|;|,|\bet\b)\s*/i)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const quantityMatch = part.match(/^0*(\d+)\s+(?=[a-zA-ZÀ-ÿ])/);
      const quantity = quantityMatch ? Number(quantityMatch[1]) : 1;

      return {
        value: quantityMatch ? part.slice(quantityMatch[0].length) : part,
        quantity,
      };
    });
}

function automaticProductCandidate(value, context) {
  const segments = productSegments(value);

  if (!segments.length) return null;

  const resolved = [];

  for (const segment of segments) {
    if (
      !Number.isInteger(segment.quantity) ||
      segment.quantity < 1 ||
      segment.quantity > 10000
    ) {
      return null;
    }

    const comparable = normalizedProductText(segment.value)
      .replace(/\bnfc\b/g, "")
      .replace(/\bbureau\b/g, "")
      .trim()
      .replace(/\s+/g, " ");

    let candidates = [...context.catalog.values()].filter((item) => {
      const itemComparable = normalizedProductText(item.name)
        .replace(/\bnfc\b/g, "")
        .replace(/\bbureau\b/g, "")
        .trim()
        .replace(/\s+/g, " ");

      return itemComparable === comparable;
    });

    if (candidates.length !== 1) {
      const sourceKind = productKind(segment.value);

      if (!sourceKind) return null;

      candidates = context.products.filter((item) => {
        const catalogKind = productKind(item.name);

        if (!catalogKind || catalogKind.type !== sourceKind.type) {
          return false;
        }

        if (sourceKind.type === "PLAQUE") {
          return (
            sourceKind.dimension != null &&
            catalogKind.dimension === sourceKind.dimension
          );
        }

        if (sourceKind.mini) {
          return catalogKind.mini;
        }

        return !catalogKind.mini;
      });

      if (!candidates.length && sourceKind.type === "STAND") {
        candidates = context.products.filter(
          (item) => productKind(item.name)?.type === "STAND",
        );
      }
    }

    if (candidates.length !== 1) return null;

    const item = candidates[0];

    const existing = resolved.find(
      (candidate) => String(candidate.catalogItemId) === String(item._id),
    );

    if (existing) {
      existing.quantity += segment.quantity;
    } else {
      resolved.push({
        business: item.business || "LOGIX",
        catalogItemId: String(item._id),
        quantity: segment.quantity,
      });
    }
  }

  return resolved.every((item) => item.quantity <= 10000) ? resolved : null;
}

function trackingValue(value) {
  return String(value ?? "").trim();
}

function trackingKey(value) {
  return trackingValue(value).toUpperCase();
}

function fingerprintFor(row) {
  let phone;

  try {
    phone = normalizePhone(row.mobile1);
  } catch {
    phone = normalizeImportedPhone(row.mobile1);
  }

  const stable = [
    phone,
    row.date ? row.date.toISOString().slice(0, 10) : "",
    row.total ?? "",
    normalizeImportText(row.product),
    normalizedWilaya(row.wilaya),
  ].join("|");

  return createHash("sha256").update(stable).digest("hex");
}

export function parseImportWorkbook(buffer, filename) {
  const cleanName = safeFilename(filename);
  const extension = path.extname(cleanName).slice(1).toLowerCase();

  assert(["xls", "xlsx"].includes(extension), "Upload an .xls or .xlsx file.");

  assert(
    Buffer.isBuffer(buffer) && buffer.length > 0,
    "The uploaded file is empty.",
  );

  const signature = buffer.subarray(0, 8).toString("hex");

  assert(
    extension === "xlsx"
      ? signature.startsWith("504b0304")
      : signature === "d0cf11e0a1b11ae1",
    "The uploaded content does not match its Excel file extension.",
  );

  let workbook;

  try {
    workbook = XLSX.read(buffer, {
      type: "buffer",
      cellDates: true,
      dense: true,
      WTF: true,
    });
  } catch {
    throw new AppError("The Excel file is malformed or unsupported.", 400);
  }

  assert(workbook.SheetNames?.length, "The Excel file has no worksheets.");

  const sheet = workbook.Sheets[workbook.SheetNames[0]];

  const matrix = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    raw: false,
    defval: "",
    blankrows: false,
    dateNF: "yyyy-mm-dd",
  });

  assert(matrix.length > 1, "The Excel worksheet has no data rows.");

  let headerIndex = -1;
  let headerMap;

  for (let index = 0; index < Math.min(10, matrix.length); index++) {
    const candidate = new Map();

    matrix[index].forEach((value, column) => {
      const key = normalizedAliases.get(normalizeImportText(value));

      if (key && !candidate.has(key)) {
        candidate.set(key, column);
      }
    });

    if (candidate.size > (headerMap?.size || 0)) {
      headerIndex = index;
      headerMap = candidate;
    }
  }

  const missing = CRITICAL_COLUMNS.filter((key) => !headerMap?.has(key));

  assert(
    !missing.length,
    `Missing critical columns: ${missing
      .map((key) => COLUMN_ALIASES[key][0])
      .join(", ")}.`,
  );

  const rows = matrix
    .slice(headerIndex + 1)
    .map((values, offset) => {
      const get = (key) =>
        headerMap.has(key) ? (values[headerMap.get(key)] ?? "") : "";

      /*
       * Keep untouched Excel values for auditing/originalData.
       */
      const original = Object.fromEntries(
        [...headerMap].map(([key]) => [key, get(key)]),
      );

      const wilaya = String(get("wilaya") || "").trim();
      const rawCommune = String(get("commune") || "").trim();

      const row = {
        rowNumber: headerIndex + offset + 2,

        tracking: trackingValue(get("tracking")),

        excelId: String(get("excelId") || "").trim(),

        client: String(get("client") || "").trim(),

        /*
         * Normalize Mobile1 immediately.
         *
         * Letters, spaces and punctuation are removed.
         */
        mobile1: normalizeImportedPhone(get("mobile1")),

        /*
         * Mobile2 is optional.
         * Keep only a valid normalized Algerian phone.
         */
        mobile2: validImportedPhoneOrEmpty(get("mobile2")),

        address: String(get("address") || "").trim(),

        wilaya,

        /*
         * IMPORTANT:
         *
         * If Commune is missing/empty, automatically use
         * the Wilaya name as the Commune.
         */
        commune: rawCommune || wilaya,

        product: String(get("product") || "").trim(),

        note: String(get("note") || "").trim(),

        situation: String(get("situation") || "").trim(),

        comment: String(get("comment") || "").trim(),

        date: excelDate(get("date")),

        actionDate: excelDate(get("actionDate")),

        total: moneyValue(get("total")),

        deliveryFee: moneyValue(get("deliveryFee")) ?? 0,

        original,
      };

      row.situationMapping = mapImportSituation(row.situation);
      row.trackingKey = trackingKey(row.tracking);
      row.fingerprint = fingerprintFor(row);

      return row;
    })
    .filter((row) =>
      [
        row.client,
        row.mobile1,
        row.wilaya,
        row.commune,
        row.product,
        row.situation,
        row.tracking,
      ].some(Boolean),
    );

  assert(rows.length, "The Excel worksheet has no usable data rows.");

  assert(
    rows.length <= MAX_ROWS,
    `Import files are limited to ${MAX_ROWS} rows.`,
  );

  return {
    filename: cleanName,
    fileType: extension,
    fileHash: createHash("sha256").update(buffer).digest("hex"),
    sheetName: workbook.SheetNames[0],
    rows,
  };
}

function rowValidation(row) {
  const errors = [];

  /*
   * Defensive normalization.
   *
   * Even though parseImportWorkbook already does this,
   * keeping it here prevents alternate/imported row sources
   * from bypassing normalization.
   */
  row.mobile1 = normalizeImportedPhone(row.mobile1);
  row.mobile2 = validImportedPhoneOrEmpty(row.mobile2);

  /*
   * Missing Commune automatically becomes Wilaya.
   */
  if (!row.commune && row.wilaya) {
    row.commune = row.wilaya;
  }

  if (row.client.length < 2) {
    errors.push("Client is required");
  }

  if (row.client.length > 150) {
    errors.push("Client is too long");
  }

  try {
    normalizePhone(row.mobile1);
  } catch (error) {
    errors.push(error.message);
  }

  if (!row.wilaya) {
    errors.push("Wilaya is required");
  }

  /*
   * This should only happen when BOTH Commune and Wilaya
   * are missing.
   */
  if (!row.commune) {
    errors.push("Commune is required");
  }

  if (row.commune.length > 150) {
    errors.push("Commune is too long");
  }

  if (row.address.length > 500) {
    errors.push("Address is too long");
  }

  if (!row.product) {
    errors.push("Product is required");
  }

  if (row.product.length > 500) {
    errors.push("Product is too long");
  }

  if (!row.situation) {
    errors.push("Situation is required");
  }

  if (row.situation.length > 300) {
    errors.push("Situation is too long");
  }

  if (row.tracking.length > 150 || hasControlCharacters(row.tracking)) {
    errors.push("Tracking is malformed or too long");
  }

  if (row.excelId.length > 150) {
    errors.push("Excel ID is too long");
  }

  if (row.mobile1.length > 30 || row.mobile2.length > 30) {
    errors.push("Phone number is too long");
  }

  if (Number.isNaN(row.total) || (row.total != null && row.total < 0)) {
    errors.push("Total must be a positive amount");
  }

  if (Number.isNaN(row.deliveryFee) || row.deliveryFee < 0) {
    errors.push("Delivery fee must be a positive amount");
  }

  if (row.total != null && row.total < row.deliveryFee) {
    errors.push("Total cannot be lower than the delivery fee");
  }

  return errors;
}

async function contextFor(user, supplied = {}) {
  const allowedBusinesses = ["LOGIX", "TAMQO"].filter((business) =>
    hasBusinessAccess(user, business),
  );

  assert(allowedBusinesses.length, "Business access denied", 403);

  const [wilayas, products, plans, savedMappings] = await Promise.all([
    Wilaya.find({ active: true }).sort({ name: 1 }).lean(),

    allowedBusinesses.includes("LOGIX")
      ? LogixProduct.find({ active: true }).sort({ name: 1 }).lean()
      : [],

    allowedBusinesses.includes("TAMQO")
      ? TamqoPlan.find({ active: true }).sort({ name: 1 }).lean()
      : [],

    ImportMapping.find().lean(),
  ]);

  const catalog = new Map([
    ...products.map((item) => [
      String(item._id),
      {
        ...item,
        business: "LOGIX",
        type: "PRODUCT",
      },
    ]),

    ...plans.map((item) => [
      String(item._id),
      {
        ...item,
        business: "TAMQO",
        type: "PLAN",
      },
    ]),
  ]);

  const saved = new Map(
    savedMappings.map((mapping) => [mapping.normalizedValue, mapping]),
  );

  const wilayaByName = new Map();

  for (const wilaya of wilayas) {
    const key = normalizedWilaya(wilaya.name);

    if (!wilayaByName.has(key)) {
      wilayaByName.set(key, []);
    }

    wilayaByName.get(key).push(wilaya);
  }

  return {
    allowedBusinesses,
    catalog,
    products,
    plans,
    wilayas,
    wilayaByName,
    saved,
    suppliedProductMappings: supplied.productMappings || {},
    suppliedWilayaMappings: supplied.wilayaMappings || {},
  };
}

function resolveProduct(row, context) {
  const key = normalizeImportText(row.product);

  const hasSupplied = Object.prototype.hasOwnProperty.call(
    context.suppliedProductMappings,
    key,
  );

  const saved = context.saved.get(key)?.items;

  const automatic = automaticProductCandidate(row.product, context);

  const candidate = hasSupplied
    ? context.suppliedProductMappings[key]
    : saved || automatic;

  const mappingSource = hasSupplied
    ? "SUPPLIED"
    : saved
      ? "SAVED"
      : automatic
        ? "AUTOMATIC"
        : null;

  if (!Array.isArray(candidate) || !candidate.length) {
    return {
      key,
      items: [],
      needsMapping: true,
      mappingSource: null,
    };
  }

  const items = [];

  for (const raw of candidate) {
    const catalog = context.catalog.get(String(raw.catalogItemId));

    const quantity = Number(raw.quantity);

    if (
      !catalog ||
      catalog.business !== raw.business ||
      !Number.isInteger(quantity) ||
      quantity < 1 ||
      quantity > 10000
    ) {
      return {
        key,
        items: [],
        needsMapping: true,
        mappingSource: null,
      };
    }

    items.push({
      business: catalog.business,
      type: catalog.type,
      catalogItemId: String(catalog._id),
      name: catalog.name,
      unitPrice: catalog.price,
      quantity,
      subtotal: round(catalog.price * quantity),
      durationDays: catalog.durationDays,
      isRenewal: false,
    });
  }

  return {
    key,
    items,
    needsMapping: false,
    mappingSource,
  };
}

function resolveWilaya(row, context) {
  const key = normalizedWilaya(row.wilaya);

  const suppliedId = context.suppliedWilayaMappings[key];

  if (suppliedId) {
    const wilaya = context.wilayas.find(
      (candidate) => String(candidate._id) === String(suppliedId),
    );

    return {
      key,
      wilaya,
      needsMapping: !wilaya,
    };
  }

  const candidates = context.wilayaByName.get(key) || [];

  return {
    key,
    wilaya: candidates.length === 1 ? candidates[0] : null,
    needsMapping: candidates.length !== 1,
  };
}

function accessibleOrder(user, order) {
  return orderBusinesses(order).every((business) =>
    hasBusinessAccess(user, business),
  );
}

export async function analyzeImport(parsed, user, supplied = {}) {
  const context = await contextFor(user, supplied);

  const trackingCounts = new Map();
  const fingerprintCounts = new Map();

  for (const row of parsed.rows) {
    if (row.tracking) {
      trackingCounts.set(
        row.trackingKey,
        (trackingCounts.get(row.trackingKey) || 0) + 1,
      );
    } else {
      fingerprintCounts.set(
        row.fingerprint,
        (fingerprintCounts.get(row.fingerprint) || 0) + 1,
      );
    }
  }

  const trackingKeys = [...trackingCounts.keys()];

  const shipments = trackingKeys.length
    ? await Shipment.find({
        $or: [
          {
            trackingKey: {
              $in: trackingKeys,
            },
          },
          {
            $expr: {
              $in: [
                {
                  $toUpper: "$tracking",
                },
                trackingKeys,
              ],
            },
          },
        ],
      }).lean()
    : [];

  const existingOrders = await Order.find({
    $or: [
      {
        _id: {
          $in: shipments.map((shipment) => shipment.orderId),
        },
      },
      {
        importFingerprint: {
          $in: [...fingerprintCounts.keys()],
        },
      },
    ],
  }).lean();

  const orderById = new Map(
    existingOrders.map((order) => [String(order._id), order]),
  );

  const orderByTracking = new Map(
    shipments.map((shipment) => [
      trackingKey(shipment.tracking),
      orderById.get(String(shipment.orderId)),
    ]),
  );

  const orderByFingerprint = new Map(
    existingOrders
      .filter((order) => order.importFingerprint)
      .map((order) => [order.importFingerprint, order]),
  );

  const feeOrderIds = await Expense.distinct("sourceOrderId", {
    systemGenerated: true,
    sourceType: "DELIVERY_FAILURE_FEE",
    sourceOrderId: {
      $in: existingOrders.map((order) => order._id),
    },
  });

  const feeOrders = new Set(feeOrderIds.map(String));

  const seenTracking = new Set();
  const seenFingerprints = new Set();

  const rows = parsed.rows.map((row) => {
    /*
     * Defensive normalization before any analysis.
     */
    row.mobile1 = normalizeImportedPhone(row.mobile1);
    row.mobile2 = validImportedPhoneOrEmpty(row.mobile2);

    if (!row.commune && row.wilaya) {
      row.commune = row.wilaya;
    }

    const product = resolveProduct(row, context);
    const wilaya = resolveWilaya(row, context);

    const errors = rowValidation(row);

    const businesses = [...new Set(product.items.map((item) => item.business))];

    if (
      businesses.length &&
      !businesses.every((business) =>
        context.allowedBusinesses.includes(business),
      )
    ) {
      errors.push("Business access denied");
    }

    const duplicateKey = row.trackingKey || row.fingerprint;

    const seen = row.tracking ? seenTracking : seenFingerprints;

    const inFileDuplicate = seen.has(duplicateKey);

    seen.add(duplicateKey);

    const existing = row.tracking
      ? orderByTracking.get(row.trackingKey)
      : orderByFingerprint.get(row.fingerprint);

    const existingAccessible = !existing || accessibleOrder(user, existing);

    if (!existingAccessible) {
      errors.push("The matching order is outside your business access");
    }

    const visibleExisting = existingAccessible ? existing : null;

    let action = "CREATE";
    let validationResult = "Ready to import";

    if (row.situationMapping.delivered) {
      action = "IGNORE_DELIVERED";
      validationResult = "Delivered row will be ignored";
    } else if (errors.length) {
      action = "INVALID";
      validationResult = errors.join("; ");
    } else if (inFileDuplicate) {
      action = "DUPLICATE";
      validationResult =
        "Potential duplicate in this file; exclude or keep one row";
    } else if (product.needsMapping || wilaya.needsMapping) {
      action = "NEEDS_MAPPING";

      validationResult = [
        product.needsMapping ? "Product mapping required" : "",
        wilaya.needsMapping ? "Wilaya mapping required" : "",
      ]
        .filter(Boolean)
        .join("; ");
    } else if (existing) {
      const sameStatus = existing.status === row.situationMapping.status;

      const canUpdate = canProviderTransition(
        existing.status,
        row.situationMapping.status,
      );

      const needsFee =
        row.situationMapping.fee && !feeOrders.has(String(existing._id));

      if (sameStatus && needsFee) {
        action = "UPDATE_EXISTING";
        validationResult = "Existing order; missing system fee will be created";
      } else if (!sameStatus && canUpdate) {
        action = "UPDATE_EXISTING";
        validationResult = `Existing order can safely update from ${existing.status}`;
      } else {
        action = "DUPLICATE";

        validationResult = sameStatus
          ? "Existing order already has this status"
          : `Existing ${existing.status} status will not be overwritten`;
      }
    }

    if (!row.situationMapping.known && action !== "INVALID") {
      validationResult += "; unknown Situation mapped safely to CONFIRMED";
    }

    return {
      rowNumber: row.rowNumber,
      tracking: row.tracking,
      client: row.client,

      /*
       * Preview now receives the normalized phone.
       */
      phone: row.mobile1,

      wilaya: row.wilaya,

      /*
       * Preview receives Wilaya when original Commune was absent.
       */
      commune: row.commune,

      product: row.product,
      situation: row.situation,
      mappedStatus: row.situationMapping.status,
      unknownStatus: !row.situationMapping.known,
      total: row.total,
      deliveryFee: row.deliveryFee,
      action,
      validationResult,
      errors,
      productMappingKey: product.key,
      productItems: product.items,
      needsProductMapping: product.needsMapping,
      productMappingSource: product.mappingSource,
      wilayaMappingKey: wilaya.key,
      wilayaId: wilaya.wilaya ? String(wilaya.wilaya._id) : "",
      needsWilayaMapping: wilaya.needsMapping,
      existingOrderId: visibleExisting ? String(visibleExisting._id) : null,
      existingStatus: visibleExisting?.status || null,
      existingCanUpdate: visibleExisting
        ? canProviderTransition(
            visibleExisting.status,
            row.situationMapping.status,
          )
        : false,
      inFileDuplicate,
      feeRequired:
        Boolean(row.situationMapping.fee) &&
        (!visibleExisting || !feeOrders.has(String(visibleExisting._id))),
    };
  });

  const eligible = rows.filter((row) =>
    ["CREATE", "UPDATE_EXISTING"].includes(row.action),
  );

  const productMappings = Object.values(
    Object.fromEntries(
      rows.map((row) => [
        row.productMappingKey,
        {
          key: row.productMappingKey,
          originalValue: row.product,
          items: row.productItems,
          needsMapping: row.needsProductMapping,
          mappingSource: row.productMappingSource,
        },
      ]),
    ),
  );

  const wilayaMappings = Object.values(
    Object.fromEntries(
      rows.map((row) => [
        row.wilayaMappingKey,
        {
          key: row.wilayaMappingKey,
          originalValue: row.wilaya,
          wilayaId: row.wilayaId,
          needsMapping: row.needsWilayaMapping,
        },
      ]),
    ),
  );

  return {
    filename: parsed.filename,
    fileType: parsed.fileType,
    fileHash: parsed.fileHash,

    summary: {
      totalRows: rows.length,

      eligibleRows: eligible.length,

      deliveredIgnored: rows.filter((row) => row.action === "IGNORE_DELIVERED")
        .length,

      returnedRows: rows.filter((row) => row.mappedStatus === "RETURNED")
        .length,

      cancelledRows: rows.filter((row) => row.mappedStatus === "CANCELLED")
        .length,

      duplicates: rows.filter((row) => row.action === "DUPLICATE").length,

      invalidRows: rows.filter((row) => row.action === "INVALID").length,

      productMappingsRequired: productMappings.filter(
        (item) => item.needsMapping,
      ).length,

      wilayaMappingsRequired: wilayaMappings.filter((item) => item.needsMapping)
        .length,

      automaticFeeCount: rows.filter(
        (row) =>
          row.feeRequired &&
          !["INVALID", "DUPLICATE", "IGNORE_DELIVERED"].includes(row.action),
      ).length,

      automaticFeeAmount:
        rows.filter(
          (row) =>
            row.feeRequired &&
            !["INVALID", "DUPLICATE", "IGNORE_DELIVERED"].includes(row.action),
        ).length * FAILURE_FEE,
    },

    rows,
    productMappings,
    wilayaMappings,

    catalogOptions: [
      ...context.products.map((item) => ({
        _id: String(item._id),
        name: item.name,
        business: "LOGIX",
        type: "PRODUCT",
      })),

      ...context.plans.map((item) => ({
        _id: String(item._id),
        name: item.name,
        business: "TAMQO",
        type: "PLAN",
      })),
    ],

    wilayaOptions: context.wilayas.map((item) => ({
      _id: String(item._id),
      name: item.name,
      agencyId: item.agencyId,
    })),
  };
}

function importedFinancials(data, row) {
  if (row.total == null) {
    return data;
  }

  const productTotal = round(row.total - row.deliveryFee);

  const currentTotal = data.items.reduce((sum, item) => sum + item.subtotal, 0);

  let assigned = 0;

  const items = data.items.map((item, index) => {
    const subtotal =
      index === data.items.length - 1
        ? round(productTotal - assigned)
        : round(
            currentTotal
              ? productTotal * (item.subtotal / currentTotal)
              : productTotal / data.items.length,
          );

    assigned = round(assigned + subtotal);

    return {
      ...item,
      unitPrice: round(subtotal / item.quantity),
      subtotal,
    };
  });

  return {
    ...data,
    items,

    ...calculateFinancials(items, row.deliveryFee, {
      method: "COD",
      amountPaidOnline: 0,
    }),
  };
}

async function createImportedOrder(
  row,
  resolved,
  batch,
  actor,
  session,
  orderNumber,
) {
  /*
   * Final defensive normalization before materialize().
   */
  row.mobile1 = normalizeImportedPhone(row.mobile1);
  row.mobile2 = validImportedPhoneOrEmpty(row.mobile2);

  if (!row.commune && row.wilaya) {
    row.commune = row.wilaya;
  }

  const note = [row.note, row.comment]
    .filter(Boolean)
    .join("\n")
    .slice(0, 2000);

  let data = await materialize(
    {
      customer: {
        name: row.client,
        phoneA: row.mobile1,
        phoneB: row.mobile2,
      },

      location: {
        wilayaId: resolved.wilayaId,

        /*
         * Guaranteed fallback.
         */
        commune: row.commune || row.wilaya,

        address: row.address || `Imported order - ${row.commune || row.wilaya}`,
      },

      items: resolved.items.map((item) => ({
        business: item.business,
        catalogItemId: item.catalogItemId,
        quantity: item.quantity,
      })),

      delivery: {
        type: "HOME",
        exchange: false,
      },

      deliveryCharged: row.deliveryFee,

      payment: {
        method: "COD",
        amountPaidOnline: 0,
      },

      note,
    },
    session,
  );

  data = importedFinancials(data, row);

  const observedAt = row.actionDate || row.date || undefined;

  const [order] = await Order.create(
    [
      {
        ...data,

        orderNumber,

        status: row.situationMapping.status,

        createdBy: actor,
        lastUpdatedBy: actor,

        statusHistory: [
          {
            status: row.situationMapping.status,
            at: observedAt,
            actor,
          },
        ],

        importBatchId: batch._id,

        importFingerprint: row.tracking ? undefined : row.fingerprint,

        importedAt: new Date(),

        originalData: {
          import: {
            batchId: String(batch._id),
            filename: batch.filename,
            rowNumber: row.rowNumber,
            sheetSituation: row.situation,
            excelDate: row.date,
            excelActionDate: row.actionDate,
            tracking: row.tracking,
            excelId: row.excelId,
            comment: row.comment,

            /*
             * Preserve the corrected values too.
             */
            normalizedPhone: row.mobile1,
            normalizedPhoneB: row.mobile2,
            resolvedCommune: row.commune || row.wilaya,
          },

          excel: row.original,
        },
      },
    ],
    {
      session,
    },
  );

  await Shipment.create(
    [
      {
        orderId: order._id,

        agencyId: order.delivery.agencyId,
        agencyName: order.delivery.agencyName,

        provider: "EXCEL_IMPORT",
        origin: "EXCEL_IMPORT",

        tracking: row.tracking || undefined,
        trackingKey: row.trackingKey || undefined,

        externalId: row.excelId || row.tracking || undefined,

        status: row.situationMapping.status,

        providerStatus: row.situation,

        syncStatus: "SYNCED",

        providerAccepted: false,
        uncertain: false,

        importBatchId: batch._id,

        importRowNumber: row.rowNumber,
      },
    ],
    {
      session,
    },
  );

  await OrderEvent.create(
    [
      {
        orderId: order._id,

        kind: "CREATED",

        type: "ORDER_IMPORTED",

        source: "EXCEL_IMPORT",

        actor,

        toStatus: row.situationMapping.status,

        message: `Imported with observed status ${row.situation}`,

        data: {
          importBatchId: batch._id,
          rowNumber: row.rowNumber,
          observedAt,
          originalSituation: row.situation,
          excelDate: row.date,
          excelActionDate: row.actionDate,
          tracking: row.tracking,
          excelId: row.excelId,
          comment: row.comment,
          normalizedPhone: row.mobile1,
          commune: row.commune || row.wilaya,
        },
      },
    ],
    {
      session,
    },
  );

  await audit(
    actor,
    "ORDER_IMPORTED",
    "Order",
    order._id,
    order.businessType,
    {
      importBatchId: batch._id,
      rowNumber: row.rowNumber,
    },
    session,
  );

  return order;
}

async function failureFee(order, row, batch, actor, session) {
  if (!row.situationMapping.fee) {
    return {
      created: false,
      amount: 0,
    };
  }

  const existing = await Expense.exists({
    systemGenerated: true,
    sourceType: "DELIVERY_FAILURE_FEE",
    sourceOrderId: order._id,
  }).session(session);

  if (existing) {
    return {
      created: false,
      amount: 0,
    };
  }

  const totals = new Map();

  for (const item of order.items) {
    totals.set(
      item.business,
      round((totals.get(item.business) || 0) + item.subtotal),
    );
  }

  const businesses = [...totals.keys()];

  const all = [...totals.values()].reduce((sum, value) => sum + value, 0);

  let assigned = 0;

  const baseKey = `DELIVERY_FAILURE_FEE:${row.trackingKey || row.fingerprint}`;

  const allocations = businesses.map((business, index) => {
    const amount =
      index === businesses.length - 1
        ? round(FAILURE_FEE - assigned)
        : round(
            FAILURE_FEE *
              (all ? totals.get(business) / all : 1 / businesses.length),
          );

    assigned = round(assigned + amount);

    return {
      business,
      amount,
    };
  });

  let createdAmount = 0;

  for (const allocation of allocations) {
    if (allocation.amount <= 0) {
      continue;
    }

    const sourceKey =
      allocations.length === 1 ? baseKey : `${baseKey}:${allocation.business}`;

    const result = await Expense.updateOne(
      {
        sourceKey,
      },
      {
        $setOnInsert: {
          business: allocation.business,

          title: "Delivery Return / Cancellation Fee",

          description: [
            `Tracking: ${row.tracking || "Unavailable"}`,
            `Client: ${row.client}`,
            `Original Situation: ${row.situation}`,
            `Import source: ${batch.filename}`,
          ].join("\n"),

          amount: allocation.amount,

          date: row.actionDate || row.date || new Date(),

          expenseDate: row.actionDate || row.date || new Date(),

          paymentMethod: "CASH",

          note: `System generated by import ${batch._id}`,

          createdBy: actor,
          updatedBy: actor,

          systemGenerated: true,

          sourceType: "DELIVERY_FAILURE_FEE",

          sourceOrderId: order._id,

          sourceTracking: row.tracking || undefined,

          sourceKey,

          sourceGroupKey: baseKey,

          importBatchId: batch._id,
        },
      },
      {
        upsert: true,
        session,
        runValidators: true,
      },
    );

    if (result.upsertedCount) {
      createdAmount = round(createdAmount + allocation.amount);

      await audit(
        actor,
        "IMPORT_RETURN_FEE_CREATED",
        "Expense",
        result.upsertedId,
        allocation.business,
        {
          importBatchId: batch._id,
          orderId: order._id,
          sourceKey,
          amount: allocation.amount,
        },
        session,
      );
    }
  }

  return {
    created: createdAmount > 0,
    amount: createdAmount,
  };
}

async function updateImportedStatus(order, row, batch, actor, session) {
  if (order.status === row.situationMapping.status) {
    return false;
  }

  if (!canProviderTransition(order.status, row.situationMapping.status)) {
    return false;
  }

  const fromStatus = order.status;

  order.status = row.situationMapping.status;

  order.lastUpdatedBy = actor;

  order.statusHistory.push({
    status: row.situationMapping.status,
    at: row.actionDate || row.date || undefined,
    actor,
  });

  order.revision++;

  await order.save({
    session,
  });

  await Shipment.updateOne(
    {
      orderId: order._id,
    },
    {
      $set: {
        status: row.situationMapping.status,

        providerStatus: row.situation,

        importBatchId: batch._id,

        importRowNumber: row.rowNumber,
      },
    },
    {
      session,
    },
  );

  await OrderEvent.create(
    [
      {
        orderId: order._id,

        kind: "STATUS",

        type: "ORDER_IMPORT_STATUS_UPDATED",

        source: "EXCEL_IMPORT",

        fromStatus,

        toStatus: row.situationMapping.status,

        actor,

        message:
          `${fromStatus} → ` +
          `${row.situationMapping.status} ` +
          `from imported Situation ${row.situation}`,

        data: {
          importBatchId: batch._id,
          rowNumber: row.rowNumber,
          originalSituation: row.situation,
          excelDate: row.date,
          excelActionDate: row.actionDate,
          tracking: row.tracking,
          excelId: row.excelId,
          comment: row.comment,
        },
      },
    ],
    {
      session,
    },
  );

  await audit(
    actor,
    "ORDER_IMPORT_STATUS_UPDATED",
    "Order",
    order._id,
    order.businessType,
    {
      importBatchId: batch._id,
      fromStatus,
      toStatus: order.status,
    },
    session,
  );

  return true;
}

async function recordImportObservation(order, row, batch, actor, session) {
  await OrderEvent.create(
    [
      {
        orderId: order._id,

        kind: "IMPORT",

        type: "ORDER_IMPORT_OBSERVED",

        source: "EXCEL_IMPORT",

        fromStatus: order.status,
        toStatus: order.status,

        actor,

        message: `Imported observation confirmed existing status ${order.status}`,

        data: {
          importBatchId: batch._id,
          rowNumber: row.rowNumber,
          originalSituation: row.situation,
          excelDate: row.date,
          excelActionDate: row.actionDate,
          tracking: row.tracking,
          excelId: row.excelId,
          comment: row.comment,
        },
      },
    ],
    {
      session,
    },
  );
}

async function saveMappings(analysis, supplied, actor) {
  const usedKeys = new Set(
    analysis.rows
      .filter((row) => ["CREATE", "UPDATE_EXISTING"].includes(row.action))
      .map((row) => row.productMappingKey),
  );

  for (const key of usedKeys) {
    if (!supplied.productMappings?.[key]) {
      continue;
    }

    const mapping = analysis.productMappings.find((item) => item.key === key);

    if (!mapping || mapping.needsMapping) {
      continue;
    }

    await transaction(async (session) => {
      const existing = await ImportMapping.findOne({
        normalizedValue: key,
      }).session(session);

      const data = {
        normalizedValue: key,
        originalValue: mapping.originalValue,
        items: mapping.items,
        updatedBy: actor,
      };

      const saved = existing
        ? await ImportMapping.findByIdAndUpdate(
            existing._id,
            {
              $set: data,
            },
            {
              new: true,
              session,
              runValidators: true,
            },
          )
        : (
            await ImportMapping.create(
              [
                {
                  ...data,
                  createdBy: actor,
                },
              ],
              {
                session,
              },
            )
          )[0];

      await audit(
        actor,
        existing ? "IMPORT_MAPPING_UPDATED" : "IMPORT_MAPPING_CREATED",
        "ImportMapping",
        saved._id,
        undefined,
        {
          normalizedValue: key,
        },
        session,
      );
    });
  }
}

export async function commitImport(parsed, user, actor, input) {
  /*
   * Defensive re-normalization.
   *
   * Preview and commit must follow exactly the same rules.
   */
  for (const row of parsed.rows) {
    row.mobile1 = normalizeImportedPhone(row.mobile1);

    row.mobile2 = validImportedPhoneOrEmpty(row.mobile2);

    if (!row.commune && row.wilaya) {
      row.commune = row.wilaya;
    }

    /*
     * Recalculate fingerprint after normalization.
     */
    row.fingerprint = fingerprintFor(row);
  }

  for (const items of Object.values(input.productMappings || {})) {
    assert(
      items.every((item) => hasBusinessAccess(user, item.business)),
      "Business access denied",
      403,
    );
  }

  const analysis = await analyzeImport(parsed, user, input);

  const selected = new Set(input.selectedRows || []);

  assert(selected.size, "Select at least one eligible row to import.");

  const unknownRows = [...selected].filter(
    (rowNumber) => !analysis.rows.some((row) => row.rowNumber === rowNumber),
  );

  assert(!unknownRows.length, "The selected rows do not match this file.");

  const unresolvedSelected = analysis.rows.filter(
    (row) =>
      selected.has(row.rowNumber) &&
      ["INVALID", "NEEDS_MAPPING"].includes(row.action),
  );

  assert(
    !unresolvedSelected.length,
    `${unresolvedSelected.length} selected row${
      unresolvedSelected.length === 1 ? " is" : "s are"
    } not ready. Resolve or deselect ${
      unresolvedSelected.length === 1 ? "it" : "them"
    } before importing.`,
    409,
  );

  const businesses = [
    ...new Set(
      analysis.rows
        .filter((row) => selected.has(row.rowNumber))
        .flatMap((row) => row.productItems.map((item) => item.business)),
    ),
  ];

  assert(
    businesses.every((business) => hasBusinessAccess(user, business)),
    "Business access denied",
    403,
  );

  const batch = await ImportBatch.create({
    filename: parsed.filename,
    fileType: parsed.fileType,
    fileHash: parsed.fileHash,
    importedBy: actor,
    businesses,
    totalRows: parsed.rows.length,
    feeAmount: 0,
  });

  const result = {
    batchId: String(batch._id),

    imported: 0,

    updatedExisting: 0,

    returned: 0,

    cancelled: 0,

    feesCreated: 0,

    totalFees: 0,

    deliveredIgnored: analysis.summary.deliveredIgnored,

    duplicatesSkipped: analysis.rows.filter((row) => row.action === "DUPLICATE")
      .length,

    invalidSkipped: analysis.rows.filter((row) =>
      ["INVALID", "NEEDS_MAPPING"].includes(row.action),
    ).length,

    excluded: analysis.rows.filter(
      (row) =>
        !selected.has(row.rowNumber) &&
        ["CREATE", "UPDATE_EXISTING"].includes(row.action),
    ).length,

    failures: [],
  };

  await saveMappings(analysis, input, actor);

  const parsedByRow = new Map(parsed.rows.map((row) => [row.rowNumber, row]));

  for (const previewRow of analysis.rows) {
    if (previewRow.action === "IGNORE_DELIVERED") {
      continue;
    }

    if (!selected.has(previewRow.rowNumber)) {
      continue;
    }

    if (previewRow.action === "DUPLICATE") {
      continue;
    }

    if (!["CREATE", "UPDATE_EXISTING"].includes(previewRow.action)) {
      result.failures.push({
        rowNumber: previewRow.rowNumber,
        tracking: previewRow.tracking,
        message: previewRow.validationResult,
      });

      continue;
    }

    const row = parsedByRow.get(previewRow.rowNumber);

    /*
     * One more safety fallback immediately before writing.
     */
    row.mobile1 = normalizeImportedPhone(row.mobile1);

    row.mobile2 = validImportedPhoneOrEmpty(row.mobile2);

    if (!row.commune && row.wilaya) {
      row.commune = row.wilaya;
    }

    const resolved = {
      wilayaId: previewRow.wilayaId,

      items: previewRow.productItems,
    };

    const orderNumber =
      previewRow.action === "CREATE" ? await allocateOrderNumber() : undefined;

    try {
      const rowResult = await transaction(async (session) => {
        let order;

        if (row.tracking) {
          const shipment = await Shipment.findOne({
            $or: [
              {
                trackingKey: row.trackingKey,
              },
              {
                $expr: {
                  $eq: [
                    {
                      $toUpper: "$tracking",
                    },
                    row.trackingKey,
                  ],
                },
              },
            ],
          }).session(session);

          if (shipment) {
            order = await Order.findById(shipment.orderId).session(session);
          }
        } else {
          order = await Order.findOne({
            importFingerprint: row.fingerprint,
          }).session(session);
        }

        if (order) {
          assert(accessibleOrder(user, order), "Business access denied", 403);

          const updated = await updateImportedStatus(
            order,
            row,
            batch,
            actor,
            session,
          );

          const fee =
            order.status === row.situationMapping.status
              ? await failureFee(order, row, batch, actor, session)
              : {
                  created: false,
                  amount: 0,
                };

          if (!updated && fee.created) {
            await recordImportObservation(order, row, batch, actor, session);
          }

          return {
            created: false,
            updated,
            duplicate: !updated && !fee.created,
            fee,
            order,
          };
        }

        const created = await createImportedOrder(
          row,
          resolved,
          batch,
          actor,
          session,
          orderNumber,
        );

        const fee = await failureFee(created, row, batch, actor, session);

        return {
          created: true,
          updated: false,
          duplicate: false,
          fee,
          order: created,
        };
      });

      if (rowResult.created) {
        result.imported++;
      } else if (rowResult.updated) {
        result.updatedExisting++;
      } else if (rowResult.duplicate) {
        result.duplicatesSkipped++;
      }

      if (rowResult.fee.created) {
        result.feesCreated++;

        result.totalFees = round(result.totalFees + rowResult.fee.amount);
      }

      if (rowResult.order.status === "RETURNED") {
        result.returned++;
      }

      if (rowResult.order.status === "CANCELLED") {
        result.cancelled++;
      }
    } catch (error) {
      result.invalidSkipped++;

      result.failures.push({
        rowNumber: row.rowNumber,

        tracking: row.tracking,

        message:
          error instanceof AppError || error.name === "ValidationError"
            ? error.message
            : error.code === 11000
              ? "This order or fee was already imported"
              : "The row could not be imported",
      });
    }
  }

  const processed = result.imported + result.updatedExisting;

  batch.importedRows = result.imported;

  batch.updatedRows = result.updatedExisting;

  batch.ignoredRows = result.deliveredIgnored + result.excluded;

  batch.duplicateRows = result.duplicatesSkipped;

  batch.invalidRows = result.invalidSkipped;

  batch.returnedRows = result.returned;

  batch.cancelledRows = result.cancelled;

  batch.feesCreated = result.feesCreated;

  batch.feeAmount = result.totalFees;

  batch.failures = result.failures.slice(0, 200);

  batch.status = result.failures.length
    ? processed
      ? "PARTIAL"
      : "FAILED"
    : "COMPLETED";

  await batch.save();

  await audit(
    actor,
    "IMPORT_EXECUTED",
    "ImportBatch",
    batch._id,

    businesses.length === 1
      ? businesses[0]
      : businesses.length
        ? "PARTNERSHIP"
        : undefined,

    {
      imported: result.imported,

      updatedExisting: result.updatedExisting,

      feesCreated: result.feesCreated,

      totalFees: result.totalFees,

      invalidSkipped: result.invalidSkipped,
    },
  );

  return result;
}

export async function importHistory(user, limit = 20) {
  const allowed = ["LOGIX", "TAMQO"].filter((business) =>
    hasBusinessAccess(user, business),
  );

  const filter =
    user.role === "SUPER_ADMIN"
      ? {}
      : {
          $or: [
            {
              $and: [
                {
                  businesses: {
                    $ne: [],
                  },
                },
                {
                  $expr: {
                    $setIsSubset: ["$businesses", allowed],
                  },
                },
              ],
            },
            {
              businesses: [],
              "importedBy.userId": user._id,
            },
          ],
        };

  return ImportBatch.find(filter)
    .sort({
      createdAt: -1,
      _id: -1,
    })
    .limit(Math.min(Math.max(Number(limit) || 20, 1), 100))
    .lean();
}

export async function previewImport(parsed, user, actor) {
  /*
   * Ensure preview receives exactly the same repaired values
   * that Commit will use.
   */
  for (const row of parsed.rows) {
    row.mobile1 = normalizeImportedPhone(row.mobile1);

    row.mobile2 = validImportedPhoneOrEmpty(row.mobile2);

    if (!row.commune && row.wilaya) {
      row.commune = row.wilaya;
    }

    row.fingerprint = fingerprintFor(row);
  }

  const analysis = await analyzeImport(parsed, user);

  await audit(
    actor,
    "IMPORT_PREVIEWED",
    "ImportPreview",
    parsed.fileHash,
    undefined,
    {
      filename: parsed.filename,
      totalRows: parsed.rows.length,
    },
  );

  return analysis;
}
