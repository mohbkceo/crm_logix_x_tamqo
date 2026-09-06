import mongoose from "mongoose";
import { actorSchema } from "./security.js";
const { Schema } = mongoose;
export const DeliveryAgency = mongoose.model(
  "DeliveryAgency",
  new Schema(
    {
      name: { type: String, required: true },
      code: { type: String, required: true, unique: true },
      active: { type: Boolean, default: true, index: true },
      businesses: {
        type: [{ type: String, enum: ["LOGIX", "TAMQO"] }],
        validate: (v) => v.length > 0,
        index: true,
      },
      integrationType: {
        type: String,
        enum: ["API", "MANUAL"],
        required: true,
      },
      apiProvider: { type: String, enum: ["PROCOLIS", "MANUAL"], index: true },
      config: { baseUrl: String, notes: String },
      encryptedCredentials: { type: String, select: false },
      credentialsConfigured: { type: Boolean, default: false },
      capabilities: {
        createShipment: Boolean,
        tracking: Boolean,
        readyToShip: Boolean,
        pricing: Boolean,
      },
      createdBy: actorSchema,
    },
    { timestamps: true, optimisticConcurrency: true },
  ),
);
const rate = new Schema(
  {
    agencyId: {
      type: Schema.Types.ObjectId,
      ref: "DeliveryAgency",
      required: true,
    },
    wilayaId: { type: Schema.Types.ObjectId, ref: "Wilaya", required: true },
    homePrice: { type: Number, min: 0, required: true },
    deskPrice: { type: Number, min: 0, required: true },
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);
rate.index({ agencyId: 1, wilayaId: 1 }, { unique: true });
export const DeliveryRate = mongoose.model("DeliveryRate", rate);
