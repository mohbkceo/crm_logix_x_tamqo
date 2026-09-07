import mongoose from "mongoose";
import { actorSchema } from "./security.js";
import {
  BUSINESS,
  BUSINESS_TYPES,
  STATUSES,
  PAYMENT_METHODS,
  DELIVERY_TYPES,
} from "../constants.js";
const { Schema } = mongoose;
const money = { type: Number, required: true, min: 0 };
const ref = (name) => ({
  type: Schema.Types.ObjectId,
  ref: name,
  required: true,
});
const create = (name, fields, indexes = []) => {
  const s = new Schema(fields, {
    timestamps: true,
    optimisticConcurrency: true,
  });
  for (const [key, options] of indexes) s.index(key, options);
  return mongoose.model(name, s);
};
const catalog = {
  name: { type: String, required: true, trim: true },
  price: money,
  active: { type: Boolean, default: true },
  sortOrder: { type: Number, default: 0 },
};
export const TamqoPlan = create("TamqoPlan", {
  ...catalog,
  durationDays: { type: Number, min: 1, required: true },
});
export const LogixProduct = create("LogixProduct", catalog);
export const OrderSource = create(
  "OrderSource",
  {
    name: { type: String, required: true, trim: true },
    active: { type: Boolean, default: true },
    isDefault: { type: Boolean, default: false },
    sortOrder: { type: Number, default: 0 },
  },
  [
    [
      { isDefault: 1 },
      { unique: true, partialFilterExpression: { isDefault: true } },
    ],
  ],
);
export const Wilaya = create("Wilaya", {
  agencyId: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  homeShippingPrice: money,
  deskShippingPrice: money,
  active: { type: Boolean, default: true },
});
export const ExpenseCategory = create(
  "ExpenseCategory",
  {
    business: { type: String, enum: BUSINESS, required: true },
    name: { type: String, required: true },
    active: { type: Boolean, default: true },
    sortOrder: { type: Number, default: 0 },
  },
  [[{ business: 1, name: 1 }, { unique: true }]],
);
export const Customer = create(
  "Customer",
  {
    name: { type: String, required: true },
    phoneA: { type: String, required: true },
    normalizedPhone: { type: String, unique: true, required: true },
    phoneB: String,
    normalizedPhoneB: String,
  },
  [[{ name: 1 }, {}]],
);
const itemSchema = new Schema(
  {
    business: { type: String, enum: BUSINESS, required: true },
    type: { type: String, enum: ["PLAN", "PRODUCT"], required: true },
    catalogItemId: { type: Schema.Types.ObjectId, required: true },
    name: { type: String, required: true },
    unitPrice: money,
    quantity: { type: Number, required: true, min: 1 },
    subtotal: money,
    durationDays: Number,
    isRenewal: { type: Boolean, default: false },
  },
  { _id: false },
);
const historySchema = new Schema(
  {
    status: { type: String, enum: STATUSES },
    at: Date,
    actor: Schema.Types.Mixed,
  },
  { _id: false },
);
export const Order = create(
  "Order",
  {
    orderNumber: {
      type: String,
      unique: true,
      required: true,
      immutable: true,
    },
    createdBy: { type: actorSchema, immutable: true },
    lastUpdatedBy: actorSchema,
    customerId: ref("Customer"),
    customer: {
      name: String,
      phoneA: String,
      phoneB: String,
      normalizedPhone: String,
      normalizedPhoneB: String,
    },
    location: {
      wilayaId: ref("Wilaya"),
      wilayaName: String,
      agencyId: String,
      commune: String,
      address: String,
    },
    note: String,
    source: { id: ref("OrderSource"), name: String },
    businessType: { type: String, enum: BUSINESS_TYPES, required: true },
    items: { type: [itemSchema], required: true },
    tamqoRevenue: money,
    logixRevenue: money,
    productRevenue: money,
    deliveryCharged: money,
    totalOrderValue: money,
    delivery: {
      agencyId: { type: Schema.Types.ObjectId, ref: "DeliveryAgency" },
      agencyName: String,
      charged: Number,
      type: { type: String, enum: DELIVERY_TYPES, required: true },
      exchange: Boolean,
    },
    payment: {
      method: { type: String, enum: PAYMENT_METHODS, required: true },
      amountPaidOnline: money,
      amountToCollect: money,
      amountCollected: { type: Number, default: 0, min: 0 },
    },
    tamqoActivatedAt: Date,
    status: { type: String, enum: STATUSES, default: "NEW" },
    statusHistory: [historySchema],
    originalData: { type: Schema.Types.Mixed, immutable: true },
    revision: { type: Number, default: 0 },
  },
  [
    [{ "createdBy.userId": 1, createdAt: -1 }, {}],
    [{ createdAt: -1, _id: -1 }, {}],
    [{ status: 1, createdAt: -1 }, {}],
    [{ businessType: 1, createdAt: -1 }, {}],
    [{ "source.id": 1, createdAt: -1 }, {}],
    [{ "customer.normalizedPhone": 1 }, {}],
    [{ customerId: 1, createdAt: 1 }, {}],
    [{ "location.wilayaId": 1, createdAt: -1 }, {}],
    [{ "location.commune": 1 }, {}],
    [{ "items.business": 1, createdAt: -1 }, {}],
    [{ "items.catalogItemId": 1 }, {}],
  ],
);
export const OrderEvent = create(
  "OrderEvent",
  {
    orderId: ref("Order"),
    kind: {
      type: String,
      enum: ["CREATED", "STATUS", "EDITED", "ACTIVATED", "PAYMENT", "SHIPMENT"],
      required: true,
    },
    type: String,
    fromStatus: String,
    toStatus: String,
    actor: Schema.Types.Mixed,
    source: { type: String, default: "INTERNAL" },
    message: String,
    data: Schema.Types.Mixed,
  },
  [[{ orderId: 1, createdAt: 1 }, {}]],
);
export const Shipment = create("Shipment", {
  orderId: { ...ref("Order"), unique: true },
  agencyId: { type: Schema.Types.ObjectId, ref: "DeliveryAgency", index: true },
  agencyName: String,
  provider: { type: String, default: "PROCOLIS" },
  tracking: { type: String, unique: true, sparse: true },
  externalId: String,
  status: String,
  providerStatus: String,
  messageRetour: String,
  syncStatus: {
    type: String,
    enum: ["PENDING", "SYNCED", "ERROR"],
    default: "PENDING",
  },
  lastSyncedAt: Date,
  providerCreatedAt: Date,
  providerUpdatedAt: Date,
  lastError: String,
  sanitizedProviderData: Schema.Types.Mixed,
  creationAttemptedAt: Date,
  providerAccepted: { type: Boolean, default: false },
  uncertain: { type: Boolean, default: false },
  lockUntil: Date,
});
export const Expense = create(
  "Expense",
  {
    business: { type: String, enum: BUSINESS, required: true },
    title: { type: String, required: true },
    description: { type: String, default: "" },
    date: { type: Date, default: Date.now },
    createdBy: { type: actorSchema, immutable: true },
    updatedBy: actorSchema,
    categoryId: { type: Schema.Types.ObjectId, ref: "ExpenseCategory" },
    category: String,
    amount: money,
    expenseDate: { type: Date, default: Date.now },
    paymentMethod: {
      type: String,
      enum: ["CASH", "BANK", "CARD", "ONLINE"],
      default: "CASH",
    },
    note: String,
  },
  [
    [{ business: 1, expenseDate: -1 }, {}],
    [{ business: 1, date: -1 }, {}],
    [{ "createdBy.userId": 1, date: -1 }, {}],
    [{ categoryId: 1 }, {}],
    [{ paymentMethod: 1 }, {}],
  ],
);
export const Counter = mongoose.model(
  "Counter",
  new Schema({ _id: String, value: { type: Number, default: 0 } }),
);
export const SettingLock = mongoose.model(
  "SettingLock",
  new Schema({ _id: String, version: Number }),
);
export const configModels = {
  plans: TamqoPlan,
  products: LogixProduct,
  sources: OrderSource,
  wilayas: Wilaya,
  "expense-categories": ExpenseCategory,
};
