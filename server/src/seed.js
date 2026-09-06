import mongoose from "mongoose";
import { pathToFileURL } from "node:url";
import { config } from "./config.js";
import {
  TamqoPlan,
  LogixProduct,
  OrderSource,
  Wilaya,
  ExpenseCategory,
  SettingLock,
} from "./models/index.js";
export async function seed() {
  for (const [index, [name, price, durationDays]] of [
    ["1 Year", 12000, 365],
    ["3 Months", 4000, 90],
    ["1 Month", 1500, 30],
    ["7 Days", 500, 7],
  ].entries())
    await TamqoPlan.updateOne(
      { name },
      {
        $setOnInsert: {
          name,
          price,
          durationDays,
          active: true,
          sortOrder: index,
        },
      },
      { upsert: true },
    );
  for (const [index, [name, price]] of [
    ["20cm Plaque", 3500],
    ["30cm Plaque", 5000],
    ["Stand", 2500],
  ].entries())
    await LogixProduct.updateOne(
      { name },
      { $setOnInsert: { name, price, active: true, sortOrder: index } },
      { upsert: true },
    );
  if (!(await OrderSource.exists({ isDefault: true, active: true })))
    await OrderSource.updateOne(
      { name: "Messages" },
      {
        $set: { active: true, isDefault: true },
        $setOnInsert: { sortOrder: 0 },
      },
      { upsert: true },
    );
  for (const [agencyId, name, homeShippingPrice, deskShippingPrice] of [
    ["16", "Alger", 500, 300],
    ["31", "Oran", 650, 400],
    ["25", "Constantine", 650, 400],
  ])
    await Wilaya.updateOne(
      { agencyId },
      {
        $setOnInsert: {
          agencyId,
          name,
          homeShippingPrice,
          deskShippingPrice,
          active: true,
        },
      },
      { upsert: true },
    );
  for (const [business, names] of [
    [
      "TAMQO",
      ["Hosting", "APIs", "Software", "Marketing", "Operations", "Other"],
    ],
    [
      "LOGIX",
      [
        "Materials",
        "Printing",
        "Packaging",
        "Production",
        "Marketing",
        "Operations",
        "Other",
      ],
    ],
  ])
    for (const [sortOrder, name] of names.entries())
      await ExpenseCategory.updateOne(
        { business, name },
        { $setOnInsert: { active: true, sortOrder } },
        { upsert: true },
      );
  await SettingLock.updateOne(
    { _id: "default-source" },
    { $setOnInsert: { version: 0 } },
    { upsert: true },
  );
  console.log(
    "Configurable sample catalogs seeded. No customer or order data was fabricated.",
  );
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  if (!config.mongoUri) throw new Error("Set MONGODB_URI before seeding.");
  await mongoose.connect(config.mongoUri);
  await seed();
  await mongoose.disconnect();
}
