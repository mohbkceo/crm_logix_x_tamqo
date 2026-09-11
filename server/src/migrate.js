import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import { pathToFileURL } from "node:url";
import { config } from "./config.js";
import { User, RegistrationSetting } from "./models/security.js";
import { DeliveryAgency, DeliveryRate } from "./models/delivery.js";
import {
  Order,
  Shipment,
  Wilaya,
  Expense,
  ImportBatch,
  ImportMapping,
} from "./models/index.js";
import { encryptCredentials } from "./services/delivery/credentials.js";
export async function bootstrap() {
  const email = (
    process.env.BOOTSTRAP_SUPER_ADMIN_EMAIL ||
    process.env.ADMIN_EMAIL ||
    ""
  )
    .trim()
    .toLowerCase();
  const password = process.env.BOOTSTRAP_SUPER_ADMIN_PASSWORD;
  if (!email || (await User.exists({ role: "SUPER_ADMIN" }))) return;
  const passwordHash = password
    ? password.length >= 12 && password.length <= 72
      ? await bcrypt.hash(password, 12)
      : null
    : process.env.ADMIN_PASSWORD_HASH;
  if (!passwordHash)
    throw new Error(
      "Bootstrap requires a password of 12–72 characters or a legacy password hash.",
    );
  if (await User.exists({ email }))
    throw new Error(
      "Bootstrap email already belongs to a user. No privileges were changed.",
    );
  await User.create({
    name: process.env.BOOTSTRAP_SUPER_ADMIN_NAME || "Super Admin",
    email,
    passwordHash,
    role: "SUPER_ADMIN",
    businessAccess: ["LOGIX", "TAMQO"],
    permissions: [],
  });
}
export async function migrate() {
  await Promise.all([
    DeliveryAgency.init(),
    DeliveryRate.init(),
    User.init(),
    Order.init(),
    Shipment.init(),
    Expense.init(),
    ImportBatch.init(),
    ImportMapping.init(),
  ]);
  const agency = await DeliveryAgency.findOneAndUpdate(
    { code: "ABEX" },
    {
      $setOnInsert: {
        name: "ABEX",
        active: true,
        businesses: ["LOGIX", "TAMQO"],
        integrationType: "API",
        apiProvider: "PROCOLIS",
        config: { baseUrl: "https://procolis.com/api_v1" },
        capabilities: {
          createShipment: true,
          tracking: true,
          readyToShip: true,
          pricing: true,
        },
      },
    },
    { upsert: true, new: true },
  );
  if (
    process.env.DELIVERY_API_TOKEN &&
    process.env.DELIVERY_API_KEY &&
    process.env.DELIVERY_CREDENTIALS_ENCRYPTION_KEY &&
    !agency.credentialsConfigured
  )
    await DeliveryAgency.updateOne(
      { _id: agency._id, credentialsConfigured: false },
      {
        $set: {
          encryptedCredentials: encryptCredentials({
            token: process.env.DELIVERY_API_TOKEN,
            key: process.env.DELIVERY_API_KEY,
          }),
          credentialsConfigured: true,
        },
      },
    );
  for (const w of await Wilaya.find().lean())
    await DeliveryRate.updateOne(
      { agencyId: agency._id, wilayaId: w._id },
      {
        $setOnInsert: {
          homePrice: w.homeShippingPrice || 0,
          deskPrice: w.deskShippingPrice || 0,
          active: w.active,
        },
      },
      { upsert: true },
    );
  await Order.updateMany(
    { "delivery.agencyId": { $exists: false } },
    {
      $set: {
        "delivery.agencyId": agency._id,
        "delivery.agencyName": agency.name,
      },
    },
  );
  await Shipment.updateMany(
    {
      agencyId: { $exists: false },
      provider: { $in: ["ABEX", "PROCOLIS", null] },
    },
    {
      $set: {
        agencyId: agency._id,
        agencyName: agency.name,
        provider: "PROCOLIS",
      },
    },
  );
  await Shipment.collection.updateMany(
    { tracking: { $type: "string" }, trackingKey: { $exists: false } },
    [{ $set: { trackingKey: { $toUpper: "$tracking" } } }],
  );
  // Pipeline updates preserve legacy data and never assign an invented employee.
  await Expense.collection.updateMany({ date: { $exists: false } }, [
    {
      $set: {
        date: { $ifNull: ["$expenseDate", "$createdAt"] },
        description: { $ifNull: ["$note", ""] },
      },
    },
  ]);
  await RegistrationSetting.updateOne(
    { _id: "registration" },
    { $setOnInsert: { registrationEnabled: false } },
    { upsert: true },
  );
  await bootstrap();
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await mongoose.connect(config.mongoUri);
  try {
    await migrate();
    console.log(
      "Migration complete. Existing creators and shipments preserved.",
    );
  } finally {
    await mongoose.disconnect();
  }
}
