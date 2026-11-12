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
import { abexCapabilities } from "./services/delivery/deliveryProviderFactory.js";
import { migrateTracking } from "./services/trackingMigration.js";
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
        apiProvider: "ABEX",
        capabilities: abexCapabilities,
      },
    },
    { upsert: true, new: true },
  );
  for (const w of await Wilaya.find().lean())
    await DeliveryRate.updateOne(
      { agencyId: agency._id, wilayaId: w._id },
      {
        $setOnInsert: {
          homePrice: w.homeShippingPrice || 0,
          deskPrice: w.deskShippingPrice || 0,
          active: w.active,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      },
      { upsert: true, timestamps: false },
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
      providerParcelId: { $exists: false },
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
  await migrateTracking();
}

export async function cutoverAbexAgency() {
  return mongoose.connection.transaction(async (session) => {
    const agency = await DeliveryAgency.findOne({
      code: "ABEX",
      integrationType: "API",
      apiProvider: "PROCOLIS",
    })
      .select(
        "+encryptedCredentials +encryptedLegacyCredentials +legacyBaseUrl",
      )
      .session(session);
    if (!agency) return false;
    if (
      await Shipment.exists({
        agencyId: agency._id,
        lockUntil: { $gt: new Date() },
      }).session(session)
    )
      throw new Error(
        "Wait for in-flight courier operations before switching the ABEX agency.",
      );

    // Older installations used ABEX as the name of the Procolis contract.
    await Shipment.updateMany(
      {
        agencyId: agency._id,
        provider: { $in: ["ABEX", null] },
        providerParcelId: { $exists: false },
      },
      { $set: { provider: "PROCOLIS" } },
      { session },
    );
    agency.encryptedLegacyCredentials = agency.encryptedCredentials;
    agency.legacyBaseUrl = agency.config?.baseUrl;
    agency.legacyTracking = Boolean(agency.capabilities?.tracking);
    agency.encryptedCredentials = undefined;
    agency.credentialsConfigured = false;
    agency.apiProvider = "ABEX";
    agency.config.baseUrl = undefined;
    agency.capabilities.updateShipment = false;
    agency.capabilities.deleteShipment = false;
    await agency.save({ session });
    return true;
  });
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await mongoose.connect(config.mongoUri);
  try {
    await migrate();
    if (process.argv.includes("--abex"))
      console.log(
        (await cutoverAbexAgency())
          ? "ABEX agency switched to TMS. Configure credentials before enabling writes."
          : "No Procolis-backed ABEX agency required a switch.",
      );
    console.log(
      "Migration complete. Existing creators and shipments preserved.",
    );
  } finally {
    await mongoose.disconnect();
  }
}
