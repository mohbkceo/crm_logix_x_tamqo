import mongoose from "mongoose";
import { ROLES, BUSINESSES, PERMISSIONS } from "../../../shared/permissions.js";
const { Schema } = mongoose;
export const actorSchema = new Schema(
  { userId: { type: Schema.Types.ObjectId, ref: "User" }, name: String },
  { _id: false },
);
const userSchema = new Schema(
  {
    name: { type: String, required: true },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, enum: ROLES, default: "EMPLOYEE", index: true },
    status: {
      type: String,
      enum: ["ACTIVE", "DISABLED"],
      default: "ACTIVE",
      index: true,
    },
    businessAccess: [{ type: String, enum: BUSINESSES }],
    permissions: [{ type: String, enum: PERMISSIONS }],
    lastLoginAt: Date,
    createdBy: actorSchema,
  },
  { timestamps: true, optimisticConcurrency: true },
);
userSchema.index({ businessAccess: 1 });
export const User = mongoose.model("User", userSchema);
const sessionSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", index: true },
    tokenHash: { type: String, unique: true, select: false },
    ip: String,
    userAgent: String,
    lastSeenAt: Date,
    expiresAt: Date,
    revokedAt: { type: Date, default: null, index: true },
  },
  { timestamps: true },
);
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const Session = mongoose.model("Session", sessionSchema);
export const RegistrationSetting = mongoose.model(
  "RegistrationSetting",
  new Schema(
    {
      _id: { type: String, default: "registration" },
      registrationEnabled: { type: Boolean, default: false },
      registrationKeyHash: { type: String, select: false },
      registrationKeyUpdatedAt: Date,
      registrationKeyUpdatedBy: actorSchema,
      registrationKeyExpiresAt: Date,
    },
    { timestamps: true },
  ),
);
const auditSchema = new Schema({
  actorId: { type: Schema.Types.ObjectId, index: true },
  actorName: String,
  action: { type: String, index: true },
  resourceType: { type: String, index: true },
  resourceId: { type: String, index: true },
  business: String,
  metadata: Schema.Types.Mixed,
  createdAt: { type: Date, default: Date.now, index: true },
});
auditSchema.index({ resourceType: 1, resourceId: 1, createdAt: -1 });
auditSchema.index({ action: 1, createdAt: -1 });
export const AuditLog = mongoose.model("AuditLog", auditSchema);
function safeMetadata(value) {
  if (Array.isArray(value)) return value.map(safeMetadata);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        ([key]) =>
          !/(password|secret|token|credential|registrationKey|encryptionKey)/i.test(
            key,
          ),
      )
      .map(([key, child]) => [key, safeMetadata(child)]),
  );
}
export async function audit(
  actor,
  action,
  resourceType,
  resourceId,
  business,
  metadata = {},
  session,
) {
  return AuditLog.create(
    [
      {
        actorId: actor?.userId,
        actorName: actor?.name || "System",
        action,
        resourceType,
        resourceId: resourceId == null ? undefined : String(resourceId),
        business,
        metadata: safeMetadata(metadata),
      },
    ],
    { session },
  );
}
