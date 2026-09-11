import { before, after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import supertest from "supertest";
import * as XLSX from "xlsx";
import { app } from "../src/app.js";
import { seed } from "../src/seed.js";
import {
  Order,
  OrderEvent,
  Shipment,
  Customer,
  TamqoPlan,
  LogixProduct,
  OrderSource,
  Wilaya,
  Expense,
  ExpenseCategory,
  ImportBatch,
  ImportMapping,
  Sale,
} from "../src/models/index.js";
import { createOrder, transition } from "../src/services/orderService.js";
import { DeliverySyncService } from "../src/services/delivery/deliverySyncService.js";
import { AppError } from "../src/errors.js";
import bcrypt from "bcryptjs";
import {
  AuditLog,
  RegistrationSetting,
  Session,
  User,
} from "../src/models/security.js";
import {
  DeliveryAgency,
  DeliveryRate,
  DeliverySyncItem,
  DeliverySyncLock,
  DeliverySyncRun,
} from "../src/models/delivery.js";
import { migrate } from "../src/migrate.js";
import { P } from "../../shared/permissions.js";
import { createServer } from "node:http";
import { encryptCredentials } from "../src/services/delivery/credentials.js";
import { providerFor } from "../src/services/delivery/deliveryProviderFactory.js";
import { deliveryService } from "../src/services/delivery/deliveryService.js";
let replica, plan, product, plaque15, stand, source, wilaya, apiAgent;
const request = () => apiAgent;
before(
  async () => {
    // Automatic order shipping must never use a developer's live credentials.
    delete process.env.DELIVERY_API_TOKEN;
    delete process.env.DELIVERY_API_KEY;
    replica = await MongoMemoryReplSet.create({
      replSet: { count: 1, storageEngine: "wiredTiger" },
    });
    await mongoose.connect(replica.getUri("test_workspace"));
    await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
    await seed();
    // Production seed now owns only Wilaya rates. Domain fixtures belong here.
    await TamqoPlan.create([
      { name: "3 Months", price: 4000, durationDays: 90 },
      { name: "6 Months", price: 7000, durationDays: 180 },
    ]);
    await LogixProduct.create([
      { name: "15cm Plaque", price: 2500 },
      { name: "20cm Plaque", price: 3500 },
      { name: "Stand", price: 1500 },
    ]);
    await OrderSource.create({ name: "Messages", isDefault: true });
    await ExpenseCategory.create([
      { business: "LOGIX", name: "Materials" },
      { business: "TAMQO", name: "Software" },
    ]);
    await migrate();
    const abex = await DeliveryAgency.findOne({ code: "ABEX" });
    const testWilaya = await Wilaya.findOne({ agencyId: "16" });
    await DeliveryRate.updateOne(
      { agencyId: abex._id, wilayaId: testWilaya._id },
      { homePrice: 500, deskPrice: 300 },
    );
    const passwordHash = await bcrypt.hash("test-only-password", 4);
    await User.create({
      name: "Test Super Admin",
      email: "qa@example.com",
      passwordHash,
      role: "SUPER_ADMIN",
      status: "ACTIVE",
      businessAccess: ["LOGIX", "TAMQO"],
      permissions: [],
    });
    apiAgent = supertest.agent(app);
    expectOk(
      await apiAgent
        .post("/api/auth/login")
        .send({ email: "qa@example.com", password: "test-only-password" }),
    );
    plan = await TamqoPlan.findOne({ name: "3 Months" });
    product = await LogixProduct.findOne({ name: "20cm Plaque" });
    plaque15 = await LogixProduct.findOne({ name: "15cm Plaque" });
    stand = await LogixProduct.findOne({ name: "Stand" });
    source = await OrderSource.findOne({ isDefault: true });
    wilaya = await Wilaya.findOne({ agencyId: "16" });
  },
  { timeout: 300000 },
);
after(async () => {
  await mongoose.disconnect();
  await replica?.stop();
});
beforeEach(async () => {
  for (const Model of [
    Order,
    OrderEvent,
    Shipment,
    Customer,
    Expense,
    Sale,
    ImportBatch,
    ImportMapping,
    DeliverySyncItem,
    DeliverySyncLock,
    DeliverySyncRun,
  ])
    await Model.deleteMany({});
});
function input(kind = "PARTNERSHIP", overrides = {}) {
  return {
    customer: { name: "Test Customer", phoneA: "0550123456", phoneB: "" },
    location: {
      wilayaId: String(wilaya._id),
      commune: "Alger Centre",
      address: "12 Test Street",
    },
    sourceId: String(source._id),
    items: [
      ...(kind !== "LOGIX_ONLY"
        ? [{ business: "TAMQO", catalogItemId: String(plan._id), quantity: 1 }]
        : []),
      ...(kind !== "TAMQO_ONLY"
        ? [
            {
              business: "LOGIX",
              catalogItemId: String(product._id),
              quantity: 2,
            },
          ]
        : []),
    ],
    delivery: { type: "HOME", exchange: false },
    payment: { method: "COD", amountPaidOnline: 0 },
    note: "Test order",
    ...overrides,
  };
}
const expectOk = (r) => {
  assert.ok(r.status < 300, JSON.stringify(r.body));
  return r.body;
};
const importHeaders = [
  "Date",
  "Tracking",
  "ID",
  "Client",
  "Mobile1",
  "Mobile2",
  "adresse",
  "Wilaya",
  "Commune",
  "Produit",
  "Note",
  "Situation",
  "Commentaire",
  "Date Action",
  "Total",
  "Frais de livraison",
];
function importRow(overrides = {}) {
  return {
    Date: "08/09/2026",
    Tracking: "IMPORT-001",
    ID: "EXT-001",
    Client: "Imported Customer",
    Mobile1: "0550123456",
    Mobile2: "",
    adresse: "12 Import Street",
    Wilaya: "16 - Alger",
    Commune: "Alger Centre",
    Produit: "Plaque 20*20",
    Note: "Imported note",
    Situation: "En livraison",
    Commentaire: "External comment",
    "Date Action": "08/09/2026",
    Total: 4000,
    "Frais de livraison": 500,
    ...overrides,
  };
}
function importWorkbook(rows, bookType = "xlsx", headers = importHeaders) {
  const sheet = XLSX.utils.aoa_to_sheet([
    headers,
    ...rows.map((row) => headers.map((header) => row[header] ?? "")),
  ]);
  return XLSX.write(
    { SheetNames: ["Orders"], Sheets: { Orders: sheet } },
    { type: "buffer", bookType },
  );
}
async function previewWorkbook(agent, rows, bookType = "xlsx", headers) {
  const buffer = importWorkbook(rows, bookType, headers);
  const response = await agent
    .post("/api/imports/orders/preview")
    .attach("file", buffer, {
      filename: `orders.${bookType}`,
      contentType: "application/octet-stream",
    });
  return { response, buffer };
}
function importOptions(
  preview,
  selectedRows = preview.rows.map((row) => row.rowNumber),
) {
  return {
    selectedRows,
    productMappings: Object.fromEntries(
      preview.productMappings.map((mapping) => [
        mapping.key,
        [
          {
            business: "LOGIX",
            catalogItemId: String(product._id),
            quantity: 1,
          },
        ],
      ]),
    ),
    wilayaMappings: Object.fromEntries(
      preview.wilayaMappings.map((mapping) => [
        mapping.key,
        String(wilaya._id),
      ]),
    ),
  };
}
async function commitWorkbook(agent, buffer, bookType, options) {
  return agent
    .post("/api/imports/orders/commit")
    .field("options", JSON.stringify(options))
    .attach("file", buffer, {
      filename: `orders.${bookType}`,
      contentType: "application/octet-stream",
    });
}
test("seeds 58 Wilayas and fixtures provide one active default", async () => {
  assert.equal(await Wilaya.countDocuments(), 58);
  assert.equal(
    await OrderSource.countDocuments({ active: true, isDefault: true }),
    1,
  );
});
test("Tamqo-only, Logix-only and partnership use server catalog prices", async () => {
  for (const kind of ["TAMQO_ONLY", "LOGIX_ONLY", "PARTNERSHIP"]) {
    const r = expectOk(
      await request(app)
        .post("/api/orders")
        .send({ ...input(kind), productRevenue: 1, businessType: "WRONG" }),
    );
    assert.equal(r.businessType, kind);
    assert.equal(r.deliveryCharged, 500);
    assert.equal(
      r.productRevenue,
      kind === "TAMQO_ONLY" ? 4000 : kind === "LOGIX_ONLY" ? 7000 : 11000,
    );
    assert.match(r.orderNumber, /^ORD-\d{4}-\d{6}$/);
  }
});
test("manual prices, quantities, delivery overrides and stop desk defaults", async () => {
  const data = input();
  data.items[0].unitPrice = 3000;
  data.items[0].quantity = 2;
  data.deliveryCharged = 123.5;
  const r = expectOk(await request(app).post("/api/orders").send(data));
  assert.equal(r.tamqoRevenue, 6000);
  assert.equal(r.totalOrderValue, 13123.5);
  const desk = expectOk(
    await request(app)
      .post("/api/orders")
      .send(
        input("LOGIX_ONLY", {
          delivery: { type: "STOP_DESK", exchange: true },
        }),
      ),
  );
  assert.equal(desk.deliveryCharged, 300);
});
test("online and mixed orders preserve internal revenue", async () => {
  for (const [method, paid, collect] of [
    ["ONLINE", 11500, 0],
    ["MIXED", 11000, 500],
  ]) {
    const r = expectOk(
      await request(app)
        .post("/api/orders")
        .send(
          input("PARTNERSHIP", { payment: { method, amountPaidOnline: paid } }),
        ),
    );
    assert.equal(r.productRevenue, 11000);
    assert.equal(r.payment.amountToCollect, collect);
  }
});
test("invalid order data never writes orders or customer records", async () => {
  const data = input();
  data.items[0].quantity = 0;
  assert.equal((await request(app).post("/api/orders").send(data)).status, 400);
  assert.equal(await Order.countDocuments(), 0);
  assert.equal(await Customer.countDocuments(), 0);
  assert.equal(
    (
      await request(app)
        .post("/api/orders")
        .send(
          input("PARTNERSHIP", {
            payment: { method: "MIXED", amountPaidOnline: 50000 },
          }),
        )
    ).status,
    400,
  );
  assert.equal(await Customer.countDocuments(), 0);
});
test("normalized phone identity joins formatted repeat purchases", async () => {
  await createOrder(input());
  await createOrder(
    input("TAMQO_ONLY", {
      customer: { name: "Same Customer", phoneA: "+213550123456" },
    }),
  );
  assert.equal(await Customer.countDocuments(), 1);
  const customers = expectOk(await request(app).get("/api/customers"));
  assert.equal(customers.items[0].orders, 2);
});
test(".xls and .xlsx imports parse normalized columns and ignore delivered rows", async () => {
  for (const bookType of ["xls", "xlsx"]) {
    const { response } = await previewWorkbook(
      apiAgent,
      [
        importRow({
          Tracking: `DELIVERED-${bookType}`,
          Situation: " Livrée [Encaisser] ",
        }),
      ],
      bookType,
    );
    const preview = expectOk(response);
    assert.equal(preview.summary.totalRows, 1);
    assert.equal(preview.summary.deliveredIgnored, 1);
    assert.equal(preview.summary.eligibleRows, 0);
    assert.equal(preview.rows[0].action, "IGNORE_DELIVERED");
  }
});

test("common LOGIX descriptions, quantities and Wilaya variants map automatically", async () => {
  const cases = [
    {
      Tracking: "AUTO-MAP-001",
      Wilaya: "16 Alger",
      Produit: "Plaque NFC 15X15",
      expected: [[plaque15, 1]],
    },
    {
      Tracking: "AUTO-MAP-002",
      Wilaya: "ALGER",
      Produit: "2 plaque 20*20 + stand",
      expected: [
        [product, 2],
        [stand, 1],
      ],
    },
    {
      Tracking: "AUTO-MAP-003",
      Wilaya: "16Alger",
      Produit: "02 stande bureau + 02 plaques 20X20",
      expected: [
        [stand, 2],
        [product, 2],
      ],
    },
  ];
  const preview = expectOk(
    (
      await previewWorkbook(
        apiAgent,
        cases.map(({ expected: _expected, ...row }) => importRow(row)),
      )
    ).response,
  );
  assert.equal(preview.summary.productMappingsRequired, 0);
  assert.equal(preview.summary.wilayaMappingsRequired, 0);
  for (const [index, expectedCase] of cases.entries()) {
    const row = preview.rows[index];
    assert.equal(row.action, "CREATE");
    assert.equal(row.needsProductMapping, false);
    assert.equal(row.productMappingSource, "AUTOMATIC");
    assert.equal(row.needsWilayaMapping, false);
    assert.equal(row.wilayaId, String(wilaya._id));
    assert.deepEqual(
      row.productItems.map((item) => [item.catalogItemId, item.quantity]),
      expectedCase.expected.map(([item, quantity]) => [
        String(item._id),
        quantity,
      ]),
    );
  }
});

test("returned imports create one internal order and one positive idempotent 150 DA expense", async () => {
  let courierCalls = 0;
  const originalAutomatic = deliveryService.createAutomatically;
  deliveryService.createAutomatically = async () => {
    courierCalls++;
    throw new Error("Importer must never create a provider parcel");
  };
  try {
    const row = importRow({
      Tracking: "RETURN-001",
      Situation: "Retour Client",
      Mobile1: "0550 12 34 56",
    });
    const { response, buffer } = await previewWorkbook(apiAgent, [row]);
    const preview = expectOk(response);
    assert.equal(preview.rows[0].mappedStatus, "RETURNED");
    assert.equal(preview.summary.automaticFeeAmount, 150);
    const first = expectOk(
      await commitWorkbook(apiAgent, buffer, "xlsx", importOptions(preview)),
    );
    assert.equal(first.imported, 1);
    assert.equal(first.returned, 1);
    assert.equal(first.feesCreated, 1);
    assert.equal(first.totalFees, 150);
    const order = await Order.findOne();
    const shipment = await Shipment.findOne({ orderId: order._id });
    const expense = await Expense.findOne({ sourceOrderId: order._id });
    assert.equal(order.status, "RETURNED");
    assert.equal(order.originalData.import.sheetSituation, "Retour Client");
    assert.equal(shipment.tracking, "RETURN-001");
    assert.equal(shipment.origin, "EXCEL_IMPORT");
    assert.equal(shipment.provider, "EXCEL_IMPORT");
    assert.equal(shipment.creationAttemptedAt, undefined);
    assert.equal(expense.amount, 150);
    assert.equal(expense.business, "LOGIX");
    assert.equal(expense.systemGenerated, true);
    assert.equal(expense.sourceKey, "DELIVERY_FAILURE_FEE:RETURN-001");
    const batch = await ImportBatch.findById(first.batchId);
    assert.equal(batch.importedRows, 1);
    assert.equal(batch.feesCreated, 1);
    assert.equal(batch.feeAmount, 150);
    assert.equal(await ImportMapping.countDocuments(), 1);
    assert.equal(
      await AuditLog.countDocuments({
        resourceId: String(batch._id),
        action: "IMPORT_EXECUTED",
      }),
      1,
    );
    assert.equal(
      await OrderEvent.countDocuments({
        orderId: order._id,
        type: "ORDER_IMPORTED",
        source: "EXCEL_IMPORT",
      }),
      1,
    );
    assert.equal(courierCalls, 0);

    const secondPreview = expectOk(
      (await previewWorkbook(apiAgent, [row])).response,
    );
    const second = expectOk(
      await commitWorkbook(
        apiAgent,
        buffer,
        "xlsx",
        importOptions(secondPreview),
      ),
    );
    assert.equal(second.imported, 0);
    assert.equal(second.feesCreated, 0);
    assert.equal(await Order.countDocuments(), 1);
    assert.equal(await Expense.countDocuments(), 1);
    assert.equal(courierCalls, 0);
  } finally {
    deliveryService.createAutomatically = originalAutomatic;
  }
});

test("partnership failure fees use positive underlying-business expenses totaling 150 DA", async () => {
  const row = importRow({
    Tracking: "PARTNER-RETURN-001",
    Produit: "Plan plus plaque",
    Situation: "Retour Livreur",
    Total: 11500,
  });
  const { response, buffer } = await previewWorkbook(apiAgent, [row]);
  const preview = expectOk(response);
  const options = importOptions(preview);
  options.productMappings = {
    [preview.productMappings[0].key]: [
      {
        business: "TAMQO",
        catalogItemId: String(plan._id),
        quantity: 1,
      },
      {
        business: "LOGIX",
        catalogItemId: String(product._id),
        quantity: 2,
      },
    ],
  };
  const result = expectOk(
    await commitWorkbook(apiAgent, buffer, "xlsx", options),
  );
  assert.equal(result.imported, 1);
  assert.equal(result.feesCreated, 1);
  assert.equal(result.totalFees, 150);
  const order = await Order.findOne();
  assert.equal(order.businessType, "PARTNERSHIP");
  const expenses = await Expense.find({ sourceOrderId: order._id });
  assert.equal(expenses.length, 2);
  assert.deepEqual(
    [...new Set(expenses.map((expense) => expense.business))].sort(),
    ["LOGIX", "TAMQO"],
  );
  assert.equal(
    expenses.reduce((sum, expense) => sum + expense.amount, 0),
    150,
  );
  assert.ok(expenses.every((expense) => expense.amount > 0));
});

test("Annuler par le Client imports CANCELLED and never duplicates its 150 DA fee", async () => {
  const row = importRow({
    Tracking: "CANCEL-001",
    Situation: "Annuler par le Client",
  });
  const { response, buffer } = await previewWorkbook(apiAgent, [row]);
  const preview = expectOk(response);
  assert.equal(preview.rows[0].mappedStatus, "CANCELLED");
  const first = expectOk(
    await commitWorkbook(apiAgent, buffer, "xlsx", importOptions(preview)),
  );
  assert.equal(first.cancelled, 1);
  assert.equal(first.feesCreated, 1);
  const repeated = expectOk(
    await commitWorkbook(apiAgent, buffer, "xlsx", importOptions(preview)),
  );
  assert.equal(repeated.feesCreated, 0);
  assert.equal(await Order.countDocuments(), 1);
  assert.equal(await Expense.countDocuments(), 1);
  assert.equal((await Expense.findOne()).amount, 150);
});

test("tracking deduplicates orders while Algerian phone normalization deduplicates customers", async () => {
  const rows = [
    importRow({ Tracking: "PHONE-001", Mobile1: "0550123456" }),
    importRow({
      Tracking: "PHONE-002",
      ID: "EXT-002",
      Mobile1: "+213550123456",
    }),
  ];
  const { response, buffer } = await previewWorkbook(apiAgent, rows);
  const preview = expectOk(response);
  const result = expectOk(
    await commitWorkbook(apiAgent, buffer, "xlsx", importOptions(preview)),
  );
  assert.equal(result.imported, 2);
  assert.equal(await Order.countDocuments(), 2);
  assert.equal(await Customer.countDocuments(), 1);
  const importedOrder = await Order.findOne({
    importBatchId: result.batchId,
  });
  const existingShipment = expectOk(
    await apiAgent.post(`/api/orders/${importedOrder._id}/shipment`),
  );
  assert.equal(existingShipment.tracking, "PHONE-001");
  assert.equal(await Shipment.countDocuments({ orderId: importedOrder._id }), 1);

  await Shipment.updateOne(
    { tracking: "PHONE-001" },
    { $set: { tracking: "phone-001" } },
  );
  const oneRow = await previewWorkbook(apiAgent, [rows[0]]);
  const duplicatePreview = expectOk(oneRow.response);
  assert.equal(duplicatePreview.rows[0].existingOrderId != null, true);
  expectOk(
    await commitWorkbook(
      apiAgent,
      oneRow.buffer,
      "xlsx",
      importOptions(duplicatePreview),
    ),
  );
  assert.equal(await Order.countDocuments(), 2);
  assert.equal(await Customer.countDocuments(), 1);
});

test("unknown Wilaya and Product block rows, and malformed Excel is rejected", async () => {
  const unresolved = await previewWorkbook(apiAgent, [
    importRow({ Wilaya: "Atlantis", Produit: "Unknown automatic product" }),
  ]);
  const unknown = expectOk(unresolved.response);
  assert.equal(unknown.rows[0].needsWilayaMapping, true);
  assert.equal(unknown.rows[0].needsProductMapping, true);
  assert.equal(unknown.rows[0].action, "NEEDS_MAPPING");
  assert.equal(unknown.summary.eligibleRows, 0);
  const unresolvedCommit = await commitWorkbook(
    apiAgent,
    unresolved.buffer,
    "xlsx",
    {
      selectedRows: [unknown.rows[0].rowNumber],
      productMappings: {},
      wilayaMappings: {},
    },
  );
  assert.equal(unresolvedCommit.status, 409);
  assert.match(unresolvedCommit.body.error.message, /selected row.*not ready/i);
  assert.equal(await ImportBatch.countDocuments(), 0);

  const invalidHeaders = importHeaders.filter((header) => header !== "Client");
  const invalid = await previewWorkbook(
    apiAgent,
    [importRow()],
    "xlsx",
    invalidHeaders,
  );
  assert.equal(invalid.response.status, 400);
  assert.match(invalid.response.body.error.message, /Missing critical columns/);

  const malformed = await apiAgent
    .post("/api/imports/orders/preview")
    .attach("file", Buffer.from([0, 1, 2, 3, 4]), "broken.xlsx");
  assert.equal(malformed.status, 400);
  assert.equal(await Order.countDocuments(), 0);
});

test("imports.view, imports.execute and business access are enforced independently", async () => {
  const viewUser = expectOk(
    await apiAgent.post("/api/users").send({
      name: "Import Preview User",
      email: "import-preview@example.com",
      password: "employee-password",
      businessAccess: ["LOGIX"],
      permissions: [P.imports.view],
    }),
  );
  const executeUser = expectOk(
    await apiAgent.post("/api/users").send({
      name: "Import Execute User",
      email: "import-execute@example.com",
      password: "employee-password",
      businessAccess: ["LOGIX"],
      permissions: [P.imports.execute],
    }),
  );
  const viewAgent = supertest.agent(app);
  const executeAgent = supertest.agent(app);
  expectOk(
    await viewAgent.post("/api/auth/login").send({
      email: viewUser.email,
      password: "employee-password",
    }),
  );
  expectOk(
    await executeAgent.post("/api/auth/login").send({
      email: executeUser.email,
      password: "employee-password",
    }),
  );
  const { response, buffer } = await previewWorkbook(viewAgent, [
    importRow({ Tracking: "PERMISSION-001" }),
  ]);
  const preview = expectOk(response);
  assert.equal(
    (await commitWorkbook(viewAgent, buffer, "xlsx", importOptions(preview)))
      .status,
    403,
  );
  assert.equal(
    (await previewWorkbook(executeAgent, [importRow()])).response.status,
    403,
  );
  const executeResult = expectOk(
    await commitWorkbook(executeAgent, buffer, "xlsx", importOptions(preview)),
  );
  assert.equal(executeResult.imported, 1);

  const forbiddenOptions = importOptions(preview);
  forbiddenOptions.selectedRows = [2];
  forbiddenOptions.productMappings = {
    [preview.productMappings[0].key]: [
      {
        business: "TAMQO",
        catalogItemId: String(plan._id),
        quantity: 1,
      },
    ],
  };
  assert.equal(
    (await commitWorkbook(executeAgent, buffer, "xlsx", forbiddenOptions))
      .status,
    403,
  );
});
test("catalog renames and price changes do not mutate order snapshots", async () => {
  const order = await createOrder(input());
  expectOk(
    await request(app)
      .patch("/api/config/plans/" + plan._id)
      .send({ price: 4500, name: "Quarterly plan" }),
  );
  const saved = await Order.findById(order._id);
  assert.equal(saved.items[0].name, "3 Months");
  assert.equal(saved.items[0].unitPrice, 4000);
  const edited = input();
  edited.revision = 0;
  edited.items[0].unitPrice = 4000;
  const result = expectOk(
    await request(app)
      .patch("/api/orders/" + order._id)
      .send(edited),
  );
  assert.equal(result.items[0].name, "3 Months");
  await TamqoPlan.updateOne(
    { _id: plan._id },
    { $set: { price: 4000, name: "3 Months" } },
  );
});
test("source switching maintains exactly one active default", async () => {
  const second = expectOk(
    await request(app)
      .post("/api/config/sources")
      .send({ name: "Website", active: true, isDefault: false, sortOrder: 1 }),
  );
  expectOk(
    await request(app)
      .patch("/api/config/sources/" + second._id)
      .send({ isDefault: true }),
  );
  assert.equal(
    await OrderSource.countDocuments({ active: true, isDefault: true }),
    1,
  );
  assert.equal(
    (await request(app).delete("/api/config/sources/" + second._id)).status,
    400,
  );
  expectOk(
    await request(app)
      .patch("/api/config/sources/" + source._id)
      .send({ isDefault: true }),
  );
});
test("configuration ordering persists atomically", async () => {
  const plans = await TamqoPlan.find().sort({ sortOrder: 1 });
  expectOk(
    await request(app)
      .post("/api/config/plans/reorder")
      .send({ ids: plans.map((p) => String(p._id)).reverse() }),
  );
  const after = await TamqoPlan.find().sort({ sortOrder: 1 });
  assert.equal(String(after[0]._id), String(plans.at(-1)._id));
  assert.equal(
    (
      await request(app)
        .post("/api/config/plans/reorder")
        .send({ ids: [String(plan._id)] })
    ).status,
    400,
  );
});
test("concurrent numbers are unique, immutable and status history is not duplicated", async () => {
  const results = await Promise.all(
    Array.from({ length: 5 }, (_, i) =>
      createOrder(
        input("TAMQO_ONLY", {
          customer: { name: "Customer " + i, phoneA: "055012345" + i },
        }),
      ),
    ),
  );
  assert.equal(new Set(results.map((o) => o.orderNumber)).size, 5);
  const id = results[0]._id;
  await transition(id, "CONFIRMED");
  await transition(id, "CONFIRMED");
  assert.equal(
    await OrderEvent.countDocuments({ orderId: id, kind: "STATUS" }),
    1,
  );
  assert.equal(
    (
      await request(app)
        .post(`/api/orders/${id}/status`)
        .send({ status: "SHIPPED" })
    ).status,
    409,
  );
});
test("optimistic revisions reject stale editing and edits are audited", async () => {
  const order = await createOrder(input());
  const data = { ...input(), note: "Edited", revision: 0 };
  expectOk(
    await request(app)
      .patch("/api/orders/" + order._id)
      .send(data),
  );
  assert.equal(
    (
      await request(app)
        .patch("/api/orders/" + order._id)
        .send(data)
    ).status,
    409,
  );
  assert.equal(
    await OrderEvent.countDocuments({ orderId: order._id, kind: "EDITED" }),
    1,
  );
  assert.equal(
    (await Order.findById(order._id)).originalData.note,
    "Test order",
  );
});
test("courier failure preserves the order and retries with lire only", async () => {
  const o = await createOrder(input());
  await transition(o._id, "CONFIRMED");
  let calls = 0;
  const service = new DeliverySyncService({
    ensureConfigured() {},
    async createPackages() {
      calls++;
      throw new AppError("Courier timed out.", 502);
    },
  });
  await assert.rejects(service.create(o._id));
  assert.ok(await Order.findById(o._id));
  const s = await Shipment.findOne({ orderId: o._id });
  assert.equal(s.syncStatus, "ERROR");
  assert.equal(s.uncertain, true);
  const retry = await service.create(o._id);
  assert.equal(retry.syncStatus, "PENDING");
  assert.equal(retry.uncertain, true);
  assert.equal(calls, 1);
});
test("missing credentials allow safe retry without an external creation attempt", async () => {
  const o = await createOrder(input());
  await transition(o._id, "CONFIRMED");
  const service = new DeliverySyncService({
    ensureConfigured() {
      throw new AppError("Not configured", 503);
    },
  });
  await assert.rejects(service.create(o._id));
  const s = await Shipment.findOne({ orderId: o._id });
  assert.equal(s.syncStatus, "ERROR");
  assert.equal(s.creationAttemptedAt, undefined);
});
test("shipment tracking refresh updates mapped status once and retains unknown values", async () => {
  const o = await createOrder(input());
  await transition(o._id, "CONFIRMED");
  await transition(o._id, "PREPARING");
  let providerStatus = "ready-code",
    calls = 0;
  process.env.DELIVERY_STATUS_MAP = JSON.stringify({
    "ready-code": "READY_TO_SHIP",
    "shipped-code": "SHIPPED",
  });
  const client = {
    ensureConfigured() {},
    async createPackages() {
      calls++;
      return {
        Colis: [
          { MessageRetour: "Good", Tracking: "AAA001", Statut: providerStatus },
        ],
      };
    },
    async readPackages() {
      return {
        Colis: [
          { MessageRetour: "Good", Tracking: "AAA001", Statut: providerStatus },
        ],
      };
    },
  };
  const service = new DeliverySyncService(client);
  await service.create(o._id);
  await service.create(o._id);
  assert.equal(calls, 1);
  await service.refresh(o._id);
  assert.equal((await Order.findById(o._id)).status, "READY_TO_SHIP");
  assert.equal(
    await OrderEvent.countDocuments({
      orderId: o._id,
      toStatus: "READY_TO_SHIP",
    }),
    1,
  );
  providerStatus = "shipped-code";
  await service.refresh(o._id);
  assert.equal((await Order.findById(o._id)).status, "SHIPPED");
  providerStatus = "undocumented";
  await service.refresh(o._id);
  assert.equal((await Order.findById(o._id)).status, "SHIPPED");
  assert.equal(
    (await Shipment.findOne({ orderId: o._id })).providerStatus,
    "undocumented",
  );
  assert.equal(
    (await Shipment.findOne({ orderId: o._id })).syncStatus,
    "SYNCED",
  );
  assert.equal((await Shipment.findOne({ orderId: o._id })).lastError, "");
  assert.equal((await Shipment.findOne({ orderId: o._id })).status, null);
  await service.refresh(o._id);
  assert.equal((await Order.findById(o._id)).status, "SHIPPED");
  delete process.env.DELIVERY_STATUS_MAP;
});
test("real ABEX lire status updates provider metadata and maps Situation", async () => {
  const order = await createOrder(input());
  await transition(order._id, "CONFIRMED");
  await transition(order._id, "PREPARING");
  await Shipment.create({
    orderId: order._id,
    agencyId: order.delivery.agencyId,
    agencyName: order.delivery.agencyName,
    provider: "PROCOLIS",
    tracking: "ABVIN086R",
    trackingKey: "ABVIN086R",
    status: "PREPARING",
  });
  const raw = {
    Colis: [
      {
        Tracking: "ABVIN086R",
        IDSituation: 28,
        Situation: "Dispatcher",
        DateH_Action: "2026-09-10T21:32:18.858",
      },
    ],
  };
  const service = new DeliverySyncService({
    async readPackages() {
      return raw;
    },
  });
  const shipment = await service.refresh(order._id);
  assert.equal(shipment.providerStatus, "Dispatcher");
  assert.equal(shipment.providerSituationId, "28");
  assert.equal(
    shipment.providerUpdatedAt.getTime(),
    new Date("2026-09-10T21:32:18.858").getTime(),
  );
  assert.equal(shipment.status, "SHIPPED");
  assert.equal(shipment.syncStatus, "SYNCED");
  assert.equal(shipment.lastError, "");
  assert.deepEqual(shipment.sanitizedProviderData, raw);
  assert.equal((await Order.findById(order._id)).status, "SHIPPED");
});
test("pagination and detailed filters are enforced server-side", async () => {
  await createOrder(input("TAMQO_ONLY"));
  await createOrder(input("LOGIX_ONLY"));
  await createOrder(input());
  const p = expectOk(await request(app).get("/api/orders?limit=1&page=2"));
  assert.equal(p.items.length, 1);
  assert.equal(p.total, 3);
  assert.equal(p.page, 2);
  for (const query of [
    "business=PARTNERSHIP",
    "commune=Alger&payment=COD",
    "source=" + source._id,
    "wilaya=" + wilaya._id,
    "catalog=" + plan._id,
    "phone=0550",
    "customer=Test",
    "search=ORD-",
  ]) {
    const r = expectOk(await request(app).get("/api/orders?" + query));
    assert.ok(r.total > 0, query);
  }
  assert.equal(
    (await request(app).get("/api/orders?business=invalid")).status,
    400,
  );
});
test("business analytics use scoped realized revenue and partnership-only orders", async () => {
  const partnership = await createOrder(input());
  for (const status of [
    "CONFIRMED",
    "PREPARING",
    "READY_TO_SHIP",
    "SHIPPED",
    "DELIVERED",
  ])
    await transition(partnership._id, status);
  const tamqo = await createOrder(input("TAMQO_ONLY"));
  await transition(tamqo._id, "CONFIRMED");
  await transition(tamqo._id, "DELIVERED");
  for (const [scope, revenue, orders] of [
    ["tamqo", 8000, 2],
    ["logix", 7000, 1],
    ["partnership", 11000, 1],
  ]) {
    const r = expectOk(
      await request(app).get(`/api/analytics/${scope}?period=today`),
    );
    assert.equal(r.metrics.netSales, revenue);
    assert.equal(r.metrics.totalOrders, orders);
  }
  const p = expectOk(
    await request(app).get("/api/analytics/partnership?period=today"),
  );
  assert.equal(p.metrics.tamqoRevenueShare, 36.36);
  assert.equal(p.metrics.logixRevenueShare, 63.64);
});
test("expense CRUD, filters, pagination and business isolation leave revenue untouched", async () => {
  const o = await createOrder(input());
  const category = await ExpenseCategory.findOne({ business: "TAMQO" }),
    logixCategory = await ExpenseCategory.findOne({ business: "LOGIX" });
  const date = new Date(Date.now() + 3600000).toISOString().slice(0, 10);
  const body = {
    business: "TAMQO",
    title: "Hosting expense",
    categoryId: String(category._id),
    amount: 500,
    expenseDate: date,
    paymentMethod: "BANK",
    note: "test",
  };
  const expense = expectOk(await request(app).post("/api/expenses").send(body));
  expectOk(
    await request(app)
      .post("/api/expenses")
      .send({
        ...body,
        business: "LOGIX",
        categoryId: String(logixCategory._id),
        amount: 1000,
      }),
  );
  const filtered = expectOk(
    await request(app).get(
      `/api/expenses?business=TAMQO&period=today&category=${category._id}&search=Hosting&paymentMethod=BANK&limit=1`,
    ),
  );
  assert.equal(filtered.total, 1);
  assert.equal(filtered.summary.totalExpenses, 500);
  assert.equal((await Order.findById(o._id)).productRevenue, 11000);
  expectOk(
    await request(app)
      .patch("/api/expenses/" + expense._id)
      .send({ ...body, amount: 600 }),
  );
  assert.equal(
    (
      await request(app)
        .post("/api/expenses")
        .send({ ...body, business: "PARTNERSHIP" })
    ).status,
    400,
  );
  assert.equal(
    (
      await request(app)
        .post("/api/expenses")
        .send({ ...body, categoryId: String(logixCategory._id) })
    ).status,
    400,
  );
  assert.equal(
    (await request(app).delete("/api/expenses/" + expense._id)).status,
    204,
  );
});
test("direct sale CRUD snapshots catalog names and never creates fulfillment records", async () => {
  const snapshotProduct = await LogixProduct.create({
      name: "Snapshot Plaque",
      price: 2500,
    }),
    actor = await User.findOne({ email: "qa@example.com" }),
    today = new Date(Date.now() + 3600000).toISOString().slice(0, 10),
    created = expectOk(
      await request(app)
        .post("/api/sales")
        .send({
          fullName: "Direct Customer",
          phoneNumber: "0559000000",
          amount: 5000,
          business: "LOGIX",
          catalogItemId: String(snapshotProduct._id),
          createdBy: {
            userId: new mongoose.Types.ObjectId(),
            name: "Impostor",
          },
        }),
    );
  assert.equal(created.quantity, 1);
  assert.equal(created.address, "");
  assert.equal(created.itemName, "Snapshot Plaque");
  assert.equal(created.createdBy.userId, String(actor._id));
  assert.equal(created.createdBy.name, actor.name);
  assert.equal(
    new Date(created.saleDate).toISOString().slice(0, 10),
    new Date(today + "T00:00:00+01:00").toISOString().slice(0, 10),
  );
  assert.equal(await Order.countDocuments(), 0);
  assert.equal(await OrderEvent.countDocuments(), 0);
  assert.equal(await Shipment.countDocuments(), 0);

  const filtered = expectOk(
    await request(app).get(
      `/api/sales?business=LOGIX&period=today&search=0559&addedBy=${actor._id}&limit=1`,
    ),
  );
  assert.equal(filtered.total, 1);
  assert.equal(filtered.items[0]._id, created._id);
  assert.equal(filtered.page, 1);
  assert.equal(filtered.limit, 1);

  snapshotProduct.name = "Renamed Plaque";
  await snapshotProduct.save();
  const updated = expectOk(
    await request(app)
      .patch(`/api/sales/${created._id}`)
      .send({ amount: 5500 }),
  );
  assert.equal(updated.itemName, "Snapshot Plaque");
  assert.equal(updated.amount, 5500);
  assert.equal(
    (
      await request(app)
        .patch(`/api/sales/${created._id}`)
        .send({
          business: "LOGIX",
          catalogItemId: String(plan._id),
        })
    ).status,
    400,
  );
  const moved = expectOk(
    await request(app)
      .patch(`/api/sales/${created._id}`)
      .send({
        business: "TAMQO",
        catalogItemId: String(plan._id),
      }),
  );
  assert.equal(moved.business, "TAMQO");
  assert.equal(moved.itemName, plan.name);

  assert.equal(
    (await request(app).delete(`/api/sales/${created._id}`)).status,
    204,
  );
  assert.equal(await Sale.countDocuments(), 0);
  assert.deepEqual(
    (
      await AuditLog.find({ resourceType: "Sale", resourceId: created._id })
        .sort({ createdAt: 1 })
        .lean()
    ).map((entry) => entry.action),
    ["SALE_CREATED", "SALE_UPDATED", "SALE_UPDATED", "SALE_DELETED"],
  );
});

test("direct sales contribute only to revenue, sold units, catalog and employee analytics", async () => {
  expectOk(
    await request(app)
      .post("/api/sales")
      .send({
        fullName: "Logix Direct",
        phoneNumber: "0559111111",
        amount: 5000,
        quantity: 2,
        business: "LOGIX",
        catalogItemId: String(product._id),
      }),
  );
  expectOk(
    await request(app)
      .post("/api/sales")
      .send({
        fullName: "Tamqo Direct",
        phoneNumber: "0559222222",
        amount: 4000,
        business: "TAMQO",
        catalogItemId: String(plan._id),
      }),
  );
  const all = expectOk(
    await request(app).get("/api/analytics/all?period=today"),
  );
  assert.equal(all.metrics.totalOrders, 0);
  assert.equal(all.metrics.confirmedOrders, 0);
  assert.equal(all.metrics.deliveredOrders, 0);
  assert.equal(all.metrics.grossSales, 9000);
  assert.equal(all.metrics.netSales, 9000);
  assert.equal(all.metrics.totalUnitsSold, 3);
  assert.equal(all.metrics.totalUnitsOrdered, 0);
  assert.equal(all.metrics.directSalesCount, 2);
  assert.equal(all.metrics.directSalesRevenue, 9000);
  assert.equal(all.metrics.directSalesUnits, 3);
  assert.equal(all.metrics.deliverySuccessRate, 0);
  assert.equal(all.metrics.totalDeliveryCharged, 0);
  assert.deepEqual(all.agencies, []);
  assert.deepEqual(all.delivery, []);
  assert.equal(
    all.products.find((row) => row.name === product.name).revenue,
    5000,
  );
  assert.equal(all.products.find((row) => row.name === product.name).units, 2);
  assert.equal(
    all.products.find((row) => row.name === plan.name).revenue,
    4000,
  );
  assert.equal(all.employees[0].netSales, 9000);
  assert.equal(all.employees[0].totalOrders, 0);
  assert.equal(all.employees[0].directSalesCount, 2);

  const tamqo = expectOk(
      await request(app).get("/api/analytics/tamqo?period=today"),
    ),
    partnership = expectOk(
      await request(app).get("/api/analytics/partnership?period=today"),
    ),
    sourceFiltered = expectOk(
      await request(app).get(
        `/api/analytics/all?period=today&source=${source._id}`,
      ),
    );
  assert.equal(tamqo.metrics.netSales, 4000);
  assert.equal(tamqo.metrics.totalUnitsSold, 1);
  assert.equal(partnership.metrics.netSales, 0);
  assert.equal(partnership.metrics.totalUnitsSold, 0);
  assert.equal(sourceFiltered.metrics.netSales, 0);

  const team = expectOk(
    await request(app).get("/api/analytics/employees?period=today&scope=ALL"),
  );
  assert.equal(team.items.length, 1);
  assert.equal(team.items[0].metrics.netSales, 9000);
  assert.equal(team.items[0].metrics.totalOrders, 0);
  assert.equal(team.items[0].metrics.directSalesCount, 2);
});

test("current balance is all-time, scoped, excludes unrealized orders, and counts direct sales once", async () => {
  const realized = await createOrder(input()),
    pending = await createOrder(input()),
    cancelled = await createOrder(input()),
    returned = await createOrder(input());
  await Promise.all([
    Order.updateOne({ _id: realized._id }, { $set: { status: "DELIVERED" } }),
    Order.updateOne({ _id: pending._id }, { $set: { status: "NEW" } }),
    Order.updateOne({ _id: cancelled._id }, { $set: { status: "CANCELLED" } }),
    Order.updateOne({ _id: returned._id }, { $set: { status: "RETURNED" } }),
    Sale.create({
      fullName: "Tamqo Direct",
      phoneNumber: "0550111111",
      amount: 4000,
      quantity: 1,
      business: "TAMQO",
      catalogItemId: plan._id,
      itemName: plan.name,
    }),
    Sale.create({
      fullName: "Logix Direct",
      phoneNumber: "0550222222",
      amount: 5000,
      quantity: 1,
      business: "LOGIX",
      catalogItemId: product._id,
      itemName: product.name,
    }),
    Expense.create({
      business: "TAMQO",
      title: "Tamqo expense",
      amount: 1000,
    }),
    Expense.create({
      business: "LOGIX",
      title: "Logix expense",
      amount: 2000,
    }),
  ]);
  const query = "period=custom&start=2020-01-01&end=2020-01-01",
    all = expectOk(await apiAgent.get(`/api/analytics/all?${query}`)),
    tamqo = expectOk(await apiAgent.get(`/api/analytics/tamqo?${query}`)),
    logix = expectOk(await apiAgent.get(`/api/analytics/logix?${query}`));
  assert.equal(all.metrics.netSales, 0);
  assert.deepEqual(all.balance, {
    realizedOrderRevenue: 11000,
    directSalesRevenue: 9000,
    totalRevenue: 20000,
    totalExpenses: 3000,
    currentBalance: 17000,
  });
  assert.deepEqual(tamqo.balance, {
    realizedOrderRevenue: 4000,
    directSalesRevenue: 4000,
    totalRevenue: 8000,
    totalExpenses: 1000,
    currentBalance: 7000,
  });
  assert.deepEqual(logix.balance, {
    realizedOrderRevenue: 7000,
    directSalesRevenue: 5000,
    totalRevenue: 12000,
    totalExpenses: 2000,
    currentBalance: 10000,
  });
});

test("balance permission, analytics scope, and business access are enforced server-side", async () => {
  const employee = expectOk(
      await apiAgent.post("/api/users").send({
        name: "Logix analyst",
        email: "balance-analyst@example.com",
        password: "employee-password",
        businessAccess: ["LOGIX"],
        permissions: [P.analytics.viewBusiness],
      }),
    ),
    agent = supertest.agent(app);
  expectOk(
    await agent.post("/api/auth/login").send({
      email: employee.email,
      password: "employee-password",
    }),
  );
  let report = expectOk(await agent.get("/api/analytics/logix?period=today"));
  assert.equal("balance" in report, false);
  assert.equal("totalExpenses" in report.metrics, false);
  await apiAgent.patch(`/api/users/${employee._id}`).send({
    permissions: [P.analytics.viewBusiness, P.finance.viewBalance],
  });
  report = expectOk(await agent.get("/api/analytics/logix?period=today"));
  assert.equal("balance" in report, true);
  assert.equal(
    (await agent.get("/api/analytics/tamqo?period=today")).status,
    403,
  );
  assert.equal(
    "balance" in expectOk(await agent.get("/api/analytics/all?period=today")),
    false,
  );
});

test("direct sale own/all permissions and business access are enforced", async () => {
  const ownUser = expectOk(
      await apiAgent.post("/api/users").send({
        name: "Own Sales Employee",
        email: "own-sales@example.com",
        password: "employee-password",
        businessAccess: ["LOGIX"],
        permissions: [
          P.sales.viewOwn,
          P.sales.create,
          P.sales.updateOwn,
          P.sales.deleteOwn,
        ],
      }),
    ),
    allUser = expectOk(
      await apiAgent.post("/api/users").send({
        name: "All Sales Employee",
        email: "all-sales@example.com",
        password: "employee-password",
        businessAccess: ["LOGIX"],
        permissions: [P.sales.viewAll, P.sales.updateAll, P.sales.deleteAll],
      }),
    ),
    ownAgent = supertest.agent(app),
    allAgent = supertest.agent(app);
  expectOk(
    await ownAgent.post("/api/auth/login").send({
      email: ownUser.email,
      password: "employee-password",
    }),
  );
  expectOk(
    await allAgent.post("/api/auth/login").send({
      email: allUser.email,
      password: "employee-password",
    }),
  );
  assert.equal((await ownAgent.get("/api/config/products")).status, 200);
  assert.equal((await ownAgent.get("/api/config/plans")).status, 403);

  const otherSale = expectOk(
      await apiAgent.post("/api/sales").send({
        fullName: "Other Owner",
        phoneNumber: "0559333333",
        amount: 1000,
        business: "LOGIX",
        catalogItemId: String(product._id),
      }),
    ),
    tamqoSale = expectOk(
      await apiAgent.post("/api/sales").send({
        fullName: "Tamqo Owner",
        phoneNumber: "0559444444",
        amount: 2000,
        business: "TAMQO",
        catalogItemId: String(plan._id),
      }),
    ),
    ownSale = expectOk(
      await ownAgent.post("/api/sales").send({
        fullName: "Own Customer",
        phoneNumber: "0559555555",
        amount: 3000,
        business: "LOGIX",
        catalogItemId: String(product._id),
        createdBy: { userId: allUser._id, name: allUser.name },
      }),
    );
  assert.equal(ownSale.createdBy.userId, ownUser._id);
  const ownList = expectOk(
    await ownAgent.get("/api/sales?business=LOGIX&period=today"),
  );
  assert.equal(ownList.total, 1);
  assert.equal(ownList.items[0]._id, ownSale._id);
  assert.equal(
    (
      await ownAgent.get(
        `/api/sales?business=LOGIX&period=today&addedBy=${otherSale.createdBy.userId}`,
      )
    ).body.total,
    0,
  );
  assert.equal((await ownAgent.get(`/api/sales/${otherSale._id}`)).status, 403);
  assert.equal(
    (await ownAgent.patch(`/api/sales/${otherSale._id}`).send({ amount: 1 }))
      .status,
    403,
  );
  assert.equal(
    (await ownAgent.delete(`/api/sales/${otherSale._id}`)).status,
    403,
  );
  assert.equal(
    (
      await ownAgent.post("/api/sales").send({
        fullName: "Forbidden Tamqo",
        phoneNumber: "0559666666",
        amount: 1000,
        business: "TAMQO",
        catalogItemId: String(plan._id),
      })
    ).status,
    403,
  );

  expectOk(await allAgent.get(`/api/sales/${ownSale._id}`));
  const updated = expectOk(
    await allAgent.patch(`/api/sales/${ownSale._id}`).send({ amount: 3500 }),
  );
  assert.equal(updated.amount, 3500);
  assert.equal(
    (
      await allAgent.patch(`/api/sales/${ownSale._id}`).send({
        business: "TAMQO",
        catalogItemId: String(plan._id),
      })
    ).status,
    403,
  );
  assert.equal((await allAgent.get(`/api/sales/${tamqoSale._id}`)).status, 403);
  assert.equal(
    (await allAgent.delete(`/api/sales/${ownSale._id}`)).status,
    204,
  );
});
test("date-range boundaries, collection audit and customer lifetime revenue", async () => {
  const o = await createOrder(input("TAMQO_ONLY"));
  await transition(o._id, "CONFIRMED");
  await transition(o._id, "DELIVERED");
  expectOk(
    await request(app)
      .post(`/api/orders/${o._id}/payment`)
      .send({ amountCollected: 4500 }),
  );
  const c = expectOk(await request(app).get("/api/customers"));
  assert.equal(c.items[0].lifetimeRevenue, 4000);
  const today = new Date(Date.now() + 3600000).toISOString().slice(0, 10);
  const r = expectOk(
    await request(app).get(
      `/api/analytics/tamqo?period=custom&start=${today}&end=${today}`,
    ),
  );
  assert.equal(r.metrics.totalOrders, 1);
  assert.equal(r.metrics.amountOutstanding, 0);
  const old = expectOk(
    await request(app).get(
      "/api/analytics/tamqo?period=custom&start=2020-01-01&end=2020-01-01",
    ),
  );
  assert.equal(old.metrics.totalOrders, 0);
});
test("secrets never appear in integration status, errors, or shipment response data", async () => {
  process.env.DELIVERY_API_TOKEN = "test-token-secret";
  process.env.DELIVERY_API_KEY = "test-key-secret";
  const r = expectOk(await request(app).get("/api/delivery/status"));
  assert.equal(JSON.stringify(r).includes("test-token-secret"), false);
  const response = await request(app)
    .post("/api/orders")
    .set("Origin", "https://hostile.example")
    .send(input());
  assert.equal(response.status, 403);
  delete process.env.DELIVERY_API_TOKEN;
  delete process.env.DELIVERY_API_KEY;
});
test("administrator authentication protects records and rejects cross-origin writes", async () => {
  const raw = supertest(app);
  assert.equal((await raw.get("/api/orders")).status, 401);
  assert.equal(
    (
      await raw
        .post("/api/auth/login")
        .send({ email: "qa@example.com", password: "incorrect" })
    ).status,
    401,
  );
  const agent = supertest.agent(app);
  expectOk(
    await agent
      .post("/api/auth/login")
      .send({ email: "qa@example.com", password: "test-only-password" }),
  );
  expectOk(await agent.get("/api/orders"));
  assert.equal(
    (
      await agent
        .post("/api/orders")
        .set("Origin", "https://other.example")
        .send(input())
    ).status,
    403,
  );
  assert.equal((await agent.post("/api/auth/logout")).status, 204);
  assert.equal((await agent.get("/api/orders")).status, 401);
});
test("concurrent shipment creation sends exactly one external request", async () => {
  const order = await createOrder(input());
  await transition(order._id, "CONFIRMED");
  let calls = 0;
  const service = new DeliverySyncService({
    ensureConfigured() {},
    async createPackages() {
      calls++;
      await new Promise((resolve) => setTimeout(resolve, 40));
      return { Colis: [{ MessageRetour: "Good", Tracking: "CONCURRENT-1" }] };
    },
  });
  await Promise.allSettled([
    service.create(order._id),
    service.create(order._id),
  ]);
  assert.equal(calls, 1);
  assert.equal(await Shipment.countDocuments({ orderId: order._id }), 1);
});
test("provider forward jumps record only observed statuses and cannot reopen a terminal order", async () => {
  const order = await createOrder(input());
  await transition(order._id, "CONFIRMED");
  process.env.DELIVERY_STATUS_MAP = JSON.stringify({
    delivered: "DELIVERED",
    shipped: "SHIPPED",
  });
  let status = "delivered";
  try {
    const service = new DeliverySyncService({
      ensureConfigured() {},
      async createPackages() {
        return {
          Colis: [
            { MessageRetour: "Good", Tracking: "FORWARD-1", Statut: status },
          ],
        };
      },
      async readPackages() {
        return {
          Colis: [
            { MessageRetour: "Good", Tracking: "FORWARD-1", Statut: status },
          ],
        };
      },
    });
    await service.create(order._id);
    const saved = await Order.findById(order._id);
    assert.equal(saved.status, "DELIVERED");
    assert.deepEqual(
      saved.statusHistory.map((h) => h.status),
      ["NEW", "CONFIRMED", "DELIVERED"],
    );
    status = "shipped";
    await service.refresh(order._id);
    assert.equal((await Order.findById(order._id)).status, "DELIVERED");
    assert.equal(
      (await Shipment.findOne({ orderId: order._id })).syncStatus,
      "ERROR",
    );
  } finally {
    delete process.env.DELIVERY_STATUS_MAP;
  }
});
test("ready calls only pret and transitions the prepared order", async () => {
  const order = await createOrder(input());
  await transition(order._id, "CONFIRMED");
  await transition(order._id, "PREPARING");
  let readyCalls = 0,
    providerStatus = "preparing",
    readCalls = 0;
  process.env.DELIVERY_STATUS_MAP = JSON.stringify({
    preparing: "PREPARING",
    ready: "READY_TO_SHIP",
  });
  try {
    const service = new DeliverySyncService({
      ensureConfigured() {},
      async createPackages() {
        return {
          Colis: [
            {
              MessageRetour: "Good",
              Tracking: "READY-1",
              Statut: providerStatus,
            },
          ],
        };
      },
      async readPackages() {
        readCalls++;
        return {
          Colis: [
            {
              MessageRetour: "Good",
              Tracking: "READY-1",
              Statut: providerStatus,
            },
          ],
        };
      },
      async readyPackages() {
        readyCalls++;
        providerStatus = "ready";
        return { Colis: [{ Tracking: "READY-1", MessageRetour: "Good" }] };
      },
    });
    await service.create(order._id);
    await service.ready(order._id);
    assert.equal(readyCalls, 1);
    assert.equal(readCalls, 0);
    assert.equal((await Order.findById(order._id)).status, "READY_TO_SHIP");
  } finally {
    delete process.env.DELIVERY_STATUS_MAP;
  }
});
test("calendar rollovers and fractional catalog cents are rejected", async () => {
  assert.equal(
    (
      await request(app).get(
        "/api/analytics/tamqo?period=custom&start=2026-02-30&end=2026-03-05",
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await request(app)
        .patch("/api/config/plans/" + plan._id)
        .send({ price: 0.001 })
    ).status,
    400,
  );
});

test("registration key is backend-only and creates an unprivileged employee", async () => {
  const key = "registration-key-for-tests";
  const settings = expectOk(
    await apiAgent.patch("/api/settings/registration").send({
      registrationKey: key,
      registrationEnabled: true,
    }),
  );
  assert.equal("registrationKeyHash" in settings, false);
  assert.equal(JSON.stringify(settings).includes(key), false);

  assert.equal(
    (
      await supertest(app).post("/api/auth/register").send({
        name: "Wrong Key",
        email: "wrong-key@example.com",
        password: "employee-password",
        registrationKey: "incorrect-registration-key",
      })
    ).status,
    403,
  );

  const employeeAgent = supertest.agent(app);
  const registration = expectOk(
    await employeeAgent.post("/api/auth/register").send({
      name: "Registered Employee",
      email: "registered@example.com",
      password: "employee-password",
      registrationKey: key,
      role: "SUPER_ADMIN",
      businessAccess: ["LOGIX", "TAMQO"],
      permissions: [P.orders.viewAll],
    }),
  );
  assert.equal(registration.user.role, "EMPLOYEE");
  assert.deepEqual(registration.user.businessAccess, []);
  assert.deepEqual(registration.user.permissions, []);
  assert.equal((await employeeAgent.get("/api/orders")).status, 403);
  assert.equal(
    JSON.stringify(await RegistrationSetting.findById("registration")).includes(
      key,
    ),
    false,
  );
});

test("order creator is derived from session and own scope cannot be bypassed", async () => {
  const employee = expectOk(
    await apiAgent.post("/api/users").send({
      name: "Order Employee",
      email: "orders@example.com",
      password: "employee-password",
      role: "EMPLOYEE",
      businessAccess: ["TAMQO"],
      permissions: [P.orders.create, P.orders.viewOwn, P.analytics.viewOwn],
    }),
  );
  const employeeAgent = supertest.agent(app);
  expectOk(
    await employeeAgent.post("/api/auth/login").send({
      email: employee.email,
      password: "employee-password",
    }),
  );
  await createOrder(input("TAMQO_ONLY"), {
    userId: (await User.findOne({ email: "qa@example.com" }))._id,
    name: "Test Super Admin",
  });
  const created = expectOk(
    await employeeAgent.post("/api/orders").send({
      ...input("TAMQO_ONLY"),
      createdBy: { userId: new mongoose.Types.ObjectId(), name: "Impostor" },
    }),
  );
  assert.equal(created.createdBy.userId, employee._id);
  assert.equal(created.createdBy.name, employee.name);
  const list = expectOk(await employeeAgent.get("/api/orders"));
  assert.equal(list.total, 1);
  assert.equal(list.items[0]._id, created._id);
  const report = expectOk(
    await employeeAgent.get("/api/analytics/all?period=today"),
  );
  assert.equal(report.metrics.totalOrders, 1);
});

test("business access blocks direct expense API calls", async () => {
  const employee = expectOk(
    await apiAgent.post("/api/users").send({
      name: "Logix Expense Employee",
      email: "logix-expenses@example.com",
      password: "employee-password",
      businessAccess: ["LOGIX"],
      permissions: [P.expenses.create, P.expenses.view],
    }),
  );
  const employeeAgent = supertest.agent(app);
  expectOk(
    await employeeAgent.post("/api/auth/login").send({
      email: employee.email,
      password: "employee-password",
    }),
  );
  assert.equal(
    (
      await employeeAgent.post("/api/expenses").send({
        business: "TAMQO",
        title: "Forbidden expense",
        amount: 100,
      })
    ).status,
    403,
  );
  const created = expectOk(
    await employeeAgent.post("/api/expenses").send({
      business: "LOGIX",
      title: "Allowed expense",
      amount: 100,
    }),
  );
  assert.equal(created.createdBy.userId, employee._id);
  assert.equal(created.business, "LOGIX");
});

test("admins cannot escalate privileges or modify a Super Admin", async () => {
  const admin = expectOk(
    await apiAgent.post("/api/users").send({
      name: "Restricted Admin",
      email: "restricted-admin@example.com",
      password: "employee-password",
      role: "ADMIN",
      businessAccess: ["LOGIX"],
      permissions: [
        P.users.view,
        P.users.create,
        P.users.update,
        P.users.disable,
        P.users.permissions,
      ],
    }),
  );
  const adminAgent = supertest.agent(app);
  expectOk(
    await adminAgent.post("/api/auth/login").send({
      email: admin.email,
      password: "employee-password",
    }),
  );
  assert.equal(
    (
      await adminAgent.post("/api/users").send({
        name: "Escalated User",
        email: "escalated@example.com",
        password: "employee-password",
        role: "SUPER_ADMIN",
        businessAccess: ["LOGIX"],
        permissions: [],
      })
    ).status,
    403,
  );
  const superAdmin = await User.findOne({ email: "qa@example.com" });
  assert.equal(
    (
      await adminAgent.patch(`/api/users/${superAdmin._id}`).send({
        status: "DISABLED",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await apiAgent.patch(`/api/users/${superAdmin._id}`).send({
        permissions: [],
      })
    ).status,
    403,
  );
  assert.equal((await User.findById(superAdmin._id)).status, "ACTIVE");
});

test("revoked and disabled sessions stop authorizing immediately", async () => {
  const employee = expectOk(
    await apiAgent.post("/api/users").send({
      name: "Session Employee",
      email: "sessions@example.com",
      password: "employee-password",
      businessAccess: [],
      permissions: [P.sessions.viewOwn, P.sessions.revokeOwn],
    }),
  );
  const employeeAgent = supertest.agent(app);
  expectOk(
    await employeeAgent.post("/api/auth/login").send({
      email: employee.email,
      password: "employee-password",
    }),
  );
  const sessions = expectOk(await employeeAgent.get("/api/auth/sessions"));
  assert.equal(sessions.length, 1);
  assert.equal("tokenHash" in sessions[0], false);
  assert.equal(
    (await employeeAgent.delete(`/api/auth/sessions/${sessions[0]._id}`))
      .status,
    204,
  );
  assert.equal((await employeeAgent.get("/api/auth/me")).status, 401);

  const disabledAgent = supertest.agent(app);
  expectOk(
    await disabledAgent.post("/api/auth/login").send({
      email: employee.email,
      password: "employee-password",
    }),
  );
  expectOk(
    await apiAgent
      .patch(`/api/users/${employee._id}`)
      .send({ status: "DISABLED" }),
  );
  assert.equal((await disabledAgent.get("/api/auth/me")).status, 401);
  assert.equal(
    await Session.countDocuments({ userId: employee._id, revokedAt: null }),
    0,
  );
});

test("migration creates one ABEX agency and per-Wilaya rates idempotently", async () => {
  await migrate();
  await migrate();
  const agencies = await DeliveryAgency.find({ code: "ABEX" });
  assert.equal(agencies.length, 1);
  assert.deepEqual([...agencies[0].businesses].sort(), ["LOGIX", "TAMQO"]);
  assert.equal(
    await DeliveryRate.countDocuments({ agencyId: agencies[0]._id }),
    await Wilaya.countDocuments(),
  );
  assert.ok(await AuditLog.exists({ action: "USER_CREATED" }));
});

test("delivery agency viewing uses any assigned business while assignments require all", async () => {
  const agencies = {};
  for (const [key, businesses] of [
    ["logix", ["LOGIX"]],
    ["tamqo", ["TAMQO"]],
    ["shared", ["LOGIX", "TAMQO"]],
  ]) {
    agencies[key] = expectOk(
      await apiAgent.post("/api/delivery-agencies").send({
        name: `${key} access courier`,
        code: `${key.toUpperCase()}_ACCESS_COURIER`,
        businesses,
        integrationType: "MANUAL",
      }),
    );
    expectOk(
      await apiAgent
        .post(`/api/delivery-agencies/${agencies[key]._id}/rates`)
        .send({
          wilayaId: String(wilaya._id),
          homePrice: 600,
          deskPrice: 400,
          active: true,
        }),
    );
  }

  async function employeeAgentFor(name, businessAccess, permissions) {
    const email = `${name.toLowerCase()}-agency-access@example.com`;
    const employee = expectOk(
      await apiAgent.post("/api/users").send({
        name: `${name} Agency Employee`,
        email,
        password: "employee-password",
        businessAccess,
        permissions,
      }),
    );
    const agent = supertest.agent(app);
    expectOk(
      await agent.post("/api/auth/login").send({
        email,
        password: "employee-password",
      }),
    );
    return { employee, agent };
  }

  const logix = await employeeAgentFor(
    "Logix",
    ["LOGIX"],
    [P.deliveryAgencies.view],
  );
  const tamqo = await employeeAgentFor(
    "Tamqo",
    ["TAMQO"],
    [P.deliveryAgencies.view],
  );
  const shared = await employeeAgentFor(
    "Shared",
    ["LOGIX", "TAMQO"],
    [P.deliveryAgencies.view, P.deliveryAgencies.assignBusinesses],
  );

  const visibleCodes = async (agent) =>
    expectOk(await agent.get("/api/delivery-agencies")).map(
      (agency) => agency.code,
    );
  const logixCodes = await visibleCodes(logix.agent);
  assert.ok(logixCodes.includes(agencies.logix.code));
  assert.ok(logixCodes.includes(agencies.shared.code));
  assert.equal(logixCodes.includes(agencies.tamqo.code), false);
  const tamqoCodes = await visibleCodes(tamqo.agent);
  assert.ok(tamqoCodes.includes(agencies.tamqo.code));
  assert.ok(tamqoCodes.includes(agencies.shared.code));
  assert.equal(tamqoCodes.includes(agencies.logix.code), false);
  const sharedCodes = await visibleCodes(shared.agent);
  assert.ok(
    [agencies.logix.code, agencies.tamqo.code, agencies.shared.code].every(
      (code) => sharedCodes.includes(code),
    ),
  );

  for (const { agent, allowed, denied } of [
    {
      agent: logix.agent,
      allowed: [agencies.logix, agencies.shared],
      denied: agencies.tamqo,
    },
    {
      agent: tamqo.agent,
      allowed: [agencies.tamqo, agencies.shared],
      denied: agencies.logix,
    },
  ]) {
    for (const agency of allowed) {
      expectOk(await agent.get(`/api/delivery-agencies/${agency._id}`));
      const rates = expectOk(
        await agent.get(`/api/delivery-agencies/${agency._id}/rates`),
      );
      assert.equal(rates.length, 1);
    }
    assert.equal(
      (await agent.get(`/api/delivery-agencies/${denied._id}`)).status,
      403,
    );
    assert.equal(
      (await agent.get(`/api/delivery-agencies/${denied._id}/rates`)).status,
      403,
    );
  }

  await apiAgent.patch(`/api/users/${logix.employee._id}`).send({
    permissions: [P.deliveryAgencies.view, P.deliveryAgencies.assignBusinesses],
  });
  const refreshedSession = expectOk(await logix.agent.get("/api/auth/session"));
  assert.ok(
    refreshedSession.user.permissions.includes(
      P.deliveryAgencies.assignBusinesses,
    ),
  );
  assert.equal(
    (
      await logix.agent
        .patch(`/api/delivery-agencies/${agencies.shared._id}`)
        .send({ businesses: ["LOGIX"] })
    ).status,
    403,
  );
  expectOk(
    await shared.agent
      .patch(`/api/delivery-agencies/${agencies.tamqo._id}`)
      .send({ businesses: ["LOGIX", "TAMQO"] }),
  );
});

test("agency assignment, rates, manual shipments, snapshots and credentials are safe", async () => {
  const manual = expectOk(
    await apiAgent.post("/api/delivery-agencies").send({
      name: "Logix Manual Courier",
      code: "LOGIX_MANUAL",
      businesses: ["LOGIX"],
      integrationType: "MANUAL",
    }),
  );
  expectOk(
    await apiAgent.post(`/api/delivery-agencies/${manual._id}/rates`).send({
      wilayaId: String(wilaya._id),
      homePrice: 777,
      deskPrice: 555,
      active: true,
    }),
  );
  const logixAgencies = expectOk(
    await apiAgent.get("/api/delivery-agencies?business=LOGIX"),
  );
  assert.ok(logixAgencies.some((agency) => agency._id === manual._id));
  const tamqoAgencies = expectOk(
    await apiAgent.get("/api/delivery-agencies?business=TAMQO"),
  );
  assert.equal(
    tamqoAgencies.some((agency) => agency._id === manual._id),
    false,
  );
  const partnershipAgencies = expectOk(
    await apiAgent.get("/api/delivery-agencies?business=PARTNERSHIP"),
  );
  assert.equal(
    partnershipAgencies.every(
      (agency) =>
        agency.businesses.includes("LOGIX") &&
        agency.businesses.includes("TAMQO"),
    ),
    true,
  );

  const order = expectOk(
    await apiAgent.post("/api/orders").send({
      ...input("LOGIX_ONLY"),
      delivery: {
        type: "HOME",
        exchange: false,
        agencyId: manual._id,
      },
    }),
  );
  assert.equal(order.deliveryCharged, 777);
  assert.equal(order.delivery.agencyName, manual.name);
  expectOk(await apiAgent.post(`/api/orders/${order._id}/confirm`));
  const shipment = expectOk(
    await apiAgent
      .post(`/api/orders/${order._id}/shipment`)
      .send({ tracking: "MANUAL-TRACKING-1" }),
  );
  assert.equal(shipment.provider, "MANUAL");
  assert.equal(shipment.agencyName, manual.name);
  assert.equal(
    (await apiAgent.delete(`/api/delivery-agencies/${manual._id}`)).status,
    409,
  );
  const disabled = expectOk(
    await apiAgent
      .patch(`/api/delivery-agencies/${manual._id}`)
      .send({ active: false }),
  );
  assert.equal(disabled.active, false);
  assert.equal(
    (await Order.findById(order._id)).delivery.agencyName,
    manual.name,
  );
  const connection = expectOk(
    await apiAgent.post(`/api/delivery-agencies/${manual._id}/test`),
  );
  assert.equal(connection.success, true);

  const previousKey = process.env.DELIVERY_CREDENTIALS_ENCRYPTION_KEY;
  process.env.DELIVERY_CREDENTIALS_ENCRYPTION_KEY =
    "7062cd732174631a214045d0843c9a767114180397e4a67c9a242e7b894d759f";
  try {
    const apiAgency = expectOk(
      await apiAgent.post("/api/delivery-agencies").send({
        name: "API Courier",
        code: "API_COURIER",
        businesses: ["LOGIX", "TAMQO"],
        integrationType: "API",
        apiProvider: "PROCOLIS",
        config: { baseUrl: "https://procolis.com/api_v1" },
        credentials: {
          token: "provider-token-secret",
          key: "provider-key-secret",
        },
      }),
    );
    const responseText = JSON.stringify(apiAgency);
    assert.equal(responseText.includes("provider-token-secret"), false);
    assert.equal(responseText.includes("provider-key-secret"), false);
    assert.equal(apiAgency.credentialsConfigured, true);
    const stored = await DeliveryAgency.findById(apiAgency._id).select(
      "+encryptedCredentials",
    );
    assert.ok(stored.encryptedCredentials);
    assert.equal(
      stored.encryptedCredentials.includes("provider-token-secret"),
      false,
    );
    assert.equal(
      JSON.stringify(
        await AuditLog.find({ resourceId: String(apiAgency._id) }),
      ).includes("provider-token-secret"),
      false,
    );
  } finally {
    if (previousKey === undefined)
      delete process.env.DELIVERY_CREDENTIALS_ENCRYPTION_KEY;
    else process.env.DELIVERY_CREDENTIALS_ENCRYPTION_KEY = previousKey;
  }
});

test("customer updates require permission and preserve order snapshots", async () => {
  const order = expectOk(
    await apiAgent.post("/api/orders").send(input("TAMQO_ONLY")),
  );
  const customer = expectOk(
    await apiAgent.get(`/api/customers/${order.customerId}`),
  );
  const updated = expectOk(
    await apiAgent.patch(`/api/customers/${customer._id}`).send({
      name: "Updated Customer",
      phoneA: "0660123456",
      phoneB: "",
    }),
  );
  assert.equal(updated.name, "Updated Customer");
  assert.equal(updated.normalizedPhone, "+213660123456");
  const historical = await Order.findById(order._id);
  assert.equal(historical.customer.name, "Test Customer");
  assert.equal(historical.customer.normalizedPhone, "+213550123456");
});

// Real HTTP boundary with per-agency encrypted credentials, never live ABEX.
async function courierFixture(
  t,
  reply,
  { manual = false, enabled = true, timeout = 1000 } = {},
) {
  const previousKey = process.env.DELIVERY_CREDENTIALS_ENCRYPTION_KEY;
  const previousTimeout = process.env.DELIVERY_TIMEOUT_MS;
  process.env.DELIVERY_CREDENTIALS_ENCRYPTION_KEY = "a1".repeat(32);
  process.env.DELIVERY_TIMEOUT_MS = String(timeout);
  const calls = [];
  const server = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const body = text ? JSON.parse(text) : null;
    const committed = body?.Colis?.[0]?.id_Externe
      ? await Order.findOne({ orderNumber: body.Colis[0].id_Externe }).lean()
      : null;
    calls.push({
      method: req.method,
      url: req.url,
      headers: req.headers,
      body,
      committed,
    });
    reply(req, res, calls.length, body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const agency = await DeliveryAgency.create({
    name: "HTTP test courier",
    code: "HTTP_TEST",
    businesses: ["LOGIX", "TAMQO"],
    integrationType: manual ? "MANUAL" : "API",
    apiProvider: manual ? "MANUAL" : "PROCOLIS",
    capabilities: {
      createShipment: enabled,
      tracking: true,
      readyToShip: true,
      pricing: true,
    },
    config: { baseUrl: `http://127.0.0.1:${server.address().port}` },
    encryptedCredentials: manual
      ? undefined
      : encryptCredentials({
          token: "agency-token-private",
          key: "agency-key-private",
        }),
    credentialsConfigured: !manual,
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await DeliveryAgency.deleteOne({ _id: agency._id });
    if (previousKey === undefined)
      delete process.env.DELIVERY_CREDENTIALS_ENCRYPTION_KEY;
    else process.env.DELIVERY_CREDENTIALS_ENCRYPTION_KEY = previousKey;
    if (previousTimeout === undefined) delete process.env.DELIVERY_TIMEOUT_MS;
    else process.env.DELIVERY_TIMEOUT_MS = previousTimeout;
  });
  return {
    agency,
    calls,
    input: input("LOGIX_ONLY", {
      delivery: { agencyId: String(agency._id), type: "HOME", exchange: false },
      deliveryCharged: 500,
    }),
  };
}
function jsonReply(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

test("API order automatically creates one unconfirmed parcel after local commit", async (t) => {
  const f = await courierFixture(t, (_req, res) =>
    jsonReply(res, 200, {
      Colis: [{ Tracking: "AUTO-001", MessageRetour: "Good" }],
      metadata: { token: "private" },
    }),
  );
  const response = await apiAgent.post("/api/orders").send(f.input);
  assert.equal(response.status, 201);
  const o = response.body,
    s = await Shipment.findOne({ orderId: o._id });
  assert.equal(o.status, "NEW");
  assert.equal(o.shipment.tracking, "AUTO-001");
  assert.equal(o.shipmentSync.success, true);
  assert.equal(s.syncStatus, "SYNCED");
  assert.equal(s.uncertain, false);
  assert.equal(s.providerAccepted, true);
  assert.deepEqual(s.sanitizedProviderData, {
    Colis: [{ Tracking: "AUTO-001", MessageRetour: "Good" }],
    metadata: {},
  });
  assert.equal(f.calls.length, 1);
  const call = f.calls[0],
    parcel = call.body.Colis[0];
  assert.equal(call.method, "POST");
  assert.equal(call.url, "/add_colis");
  assert.equal(call.headers.token, "agency-token-private");
  assert.equal(call.headers.key, "agency-key-private");
  assert.match(call.headers["content-type"], /^application\/json/);
  assert.equal(String(call.committed._id), o._id);
  assert.equal(call.committed.status, "NEW");
  assert.equal(parcel.Confrimee, "0");
  assert.equal(parcel.IDWilaya, "16");
  assert.equal(parcel.Total, "7500");
  assert.equal(parcel.id_Externe, o.orderNumber);
  assert.equal(parcel.Tracking, o.orderNumber);
  assert.equal(call.headers.authorization, undefined);
  assert.equal("Package" in call.body, false);
  assert.equal(o.revision, (await Order.findById(o._id)).revision);
  expectOk(await apiAgent.post(`/api/orders/${o._id}/shipment`));
  assert.equal(f.calls.length, 1);
  assert.equal(
    (
      await apiAgent
        .patch(`/api/orders/${o._id}`)
        .send({ ...f.input, revision: o.revision })
    ).status,
    409,
  );
  assert.equal(
    (await apiAgent.post(`/api/orders/${o._id}/cancel`).send({})).status,
    409,
  );
});

test("manual and capability-disabled agencies do not automatically send parcels", async (t) => {
  const f = await courierFixture(t, (_req, res) => jsonReply(res, 500, {}), {
    manual: true,
  });
  let o = expectOk(await apiAgent.post("/api/orders").send(f.input));
  assert.equal(o.shipment, null);
  assert.equal(o.shipmentSync.attempted, false);
  assert.equal(await (await providerFor(f.agency._id)).testCredentials(), true);
  expectOk(await apiAgent.post(`/api/orders/${o._id}/confirm`));
  assert.equal(
    expectOk(await apiAgent.post(`/api/orders/${o._id}/shipment`).send({}))
      .provider,
    "MANUAL",
  );
  await DeliveryAgency.updateOne(
    { _id: f.agency._id },
    {
      integrationType: "API",
      apiProvider: "PROCOLIS",
      "capabilities.createShipment": false,
    },
  );
  o = expectOk(await apiAgent.post("/api/orders").send(f.input));
  assert.equal(o.shipment, null);
  assert.equal(f.calls.length, 0);
});

test("unknown success is retained and retries only read deterministic tracking", async (t) => {
  const f = await courierFixture(t, (req, res, _n, body) =>
    jsonReply(
      res,
      200,
      req.url === "/add_colis"
        ? { result: "received agency-token-private" }
        : { Colis: [{ Tracking: body.Colis[0].Tracking, Statut: "unknown" }] },
    ),
  );
  const o = expectOk(await apiAgent.post("/api/orders").send(f.input));
  assert.equal(o.shipment.syncStatus, "PENDING");
  assert.equal(o.shipment.providerAccepted, false);
  const linked = expectOk(
    await apiAgent.post("/api/orders/" + o._id + "/shipment"),
  );
  assert.equal(linked.tracking, o.orderNumber);
  assert.equal(linked.uncertain, false);
  assert.equal(linked.syncStatus, "SYNCED");
  assert.equal(linked.lastError, "");
  assert.equal(linked.providerStatus, "unknown");
  assert.equal((await Order.findById(o._id)).status, "NEW");
  assert.deepEqual(
    f.calls.map((c) => c.url),
    ["/add_colis", "/lire"],
  );
  assert.deepEqual(f.calls[1].body, { Colis: [{ Tracking: o.orderNumber }] });
  assert.equal(await Order.countDocuments(), 1);
});

for (const status of [400, 401, 500])
  test(`HTTP ${status} preserves order and sanitized provider diagnostics`, async (t) => {
    const f = await courierFixture(t, (_req, res) =>
      jsonReply(res, status, {
        message: "Invalid parcel agency-token-private agency-key-private",
        token: "secret",
        cookies: "secret",
      }),
    );
    const response = await apiAgent.post("/api/orders").send(f.input);
    assert.equal(response.status, 201);
    const o = response.body,
      s = await Shipment.findOne({ orderId: o._id });
    assert.equal(await Order.countDocuments(), 1);
    assert.equal(o.shipmentSync.success, false);
    assert.equal(s.syncStatus, "ERROR");
    assert.equal(s.providerAccepted, false);
    assert.match(s.lastError, /Invalid parcel/);
    assert.equal(s.sanitizedProviderData.status, status);
    assert.equal(s.sanitizedProviderData.endpoint, "/add_colis");
    assert.equal(JSON.stringify(s).includes("private"), false);
    assert.equal(JSON.stringify(s).includes("secret"), false);
    assert.equal(
      (await apiAgent.post(`/api/orders/${o._id}/shipment`)).status,
      200,
    );
    assert.equal(f.calls.length, 2);
    assert.equal(f.calls[1].url, "/lire");
  });

test("HTTP timeout keeps one recoverable order and retries with lire", async (t) => {
  const f = await courierFixture(t, () => {}, { timeout: 100 });
  const response = await apiAgent.post("/api/orders").send(f.input);
  assert.equal(response.status, 201);
  const o = response.body;
  assert.equal(await Order.countDocuments(), 1);
  assert.equal(o.shipment.syncStatus, "ERROR");
  assert.equal(o.shipment.uncertain, true);
  assert.match(o.shipment.lastError, /timed out/);
  assert.equal(
    (await apiAgent.post(`/api/orders/${o._id}/shipment`)).status,
    200,
  );
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].url, "/lire");
});

test("credential test uses GET token with agency headers and validates activated Statut", async (t) => {
  const f = await courierFixture(t, (_req, res) =>
    jsonReply(res, 200, { Statut: "Acc\u00e8s activ\u00e9" }),
  );
  expectOk(await apiAgent.post(`/api/delivery-agencies/${f.agency._id}/test`));
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].method, "GET");
  assert.equal(f.calls[0].url, "/token");
  assert.equal(f.calls[0].headers.token, "agency-token-private");
  assert.equal(f.calls[0].headers.key, "agency-key-private");
});

test("credential test rejects an explicit non-activated HTTP 200 response", async (t) => {
  const f = await courierFixture(t, (_req, res) =>
    jsonReply(res, 200, { Statut: "Acc\u00e8s refus\u00e9" }),
  );
  const response = await apiAgent.post(
    `/api/delivery-agencies/${f.agency._id}/test`,
  );
  assert.equal(response.status, 422);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, "/token");
});

test("Double Tracking reconciles with lire and never repeats add_colis", async (t) => {
  const f = await courierFixture(t, (req, res, _n, body) =>
    jsonReply(
      res,
      200,
      req.url === "/add_colis"
        ? {
            Colis: [
              {
                Tracking: body.Colis[0].Tracking,
                MessageRetour: "Double Tracking",
              },
            ],
          }
        : {
            Colis: [
              {
                Tracking: body.Colis[0].Tracking,
                Statut: "existing",
              },
            ],
          },
    ),
  );
  const order = expectOk(await apiAgent.post("/api/orders").send(f.input));
  assert.equal(order.shipment.syncStatus, "SYNCED");
  assert.equal(order.shipment.lastError, "");
  assert.equal(order.shipment.providerStatus, "existing");
  assert.equal(order.shipment.uncertain, false);
  assert.equal(order.shipment.tracking, order.orderNumber);
  assert.equal(order.shipment.messageRetour, "Double Tracking");
  assert.deepEqual(
    f.calls.map((call) => call.url),
    ["/add_colis", "/lire"],
  );
  assert.equal(f.calls.filter((call) => call.url === "/add_colis").length, 1);
  assert.deepEqual(f.calls[1].body, {
    Colis: [{ Tracking: order.orderNumber }],
  });
});

test("explicit provider rejection on HTTP success remains a recoverable error", async (t) => {
  const f = await courierFixture(t, (_req, res) =>
    jsonReply(res, 200, {
      Colis: [{ MessageRetour: "Some provider error" }],
    }),
  );
  const o = expectOk(await apiAgent.post("/api/orders").send(f.input));
  const shipment = await Shipment.findOne({ orderId: o._id }).lean();
  assert.equal(shipment.syncStatus, "ERROR");
  assert.equal(shipment.providerAccepted, false);
  assert.equal(shipment.lastError, "Some provider error");
  assert.equal(shipment.sanitizedProviderData.status, 200);
  assert.equal(shipment.sanitizedProviderData.statusText, "OK");
  assert.equal(
    shipment.sanitizedProviderData.body.Colis[0].MessageRetour,
    "Some provider error",
  );
  assert.equal(
    (await apiAgent.post(`/api/orders/${o._id}/shipment`)).status,
    409,
  );
  assert.equal(f.calls.length, 1);
});

test("uncertain parcel can be linked with documented tracking lookup and then refreshed", async (t) => {
  let externalId;
  const f = await courierFixture(t, (req, res) =>
    jsonReply(
      res,
      200,
      req.url === "/add_colis"
        ? { received: true }
        : { Colis: [{ Tracking: "LINK-001", id_Externe: externalId }] },
    ),
  );
  const o = expectOk(await apiAgent.post("/api/orders").send(f.input));
  externalId = "WRONG-ORDER";
  assert.equal(
    (
      await apiAgent
        .post(`/api/orders/${o._id}/shipment/reconcile`)
        .send({ tracking: "LINK-001" })
    ).status,
    409,
  );
  externalId = o.orderNumber;
  const linked = expectOk(
    await apiAgent
      .post(`/api/orders/${o._id}/shipment/reconcile`)
      .send({ tracking: "LINK-001" }),
  );
  assert.equal(linked.tracking, "LINK-001");
  assert.equal(linked.uncertain, false);
  assert.equal(linked.syncStatus, "SYNCED");
  expectOk(await apiAgent.post(`/api/orders/${o._id}/shipment/refresh`));
  assert.equal(f.calls.filter((c) => c.url === "/add_colis").length, 1);
  assert.ok(f.calls.slice(1).every((c) => c.url === "/lire"));
});

test("stale tracking reconciliation cannot replace a new in-flight reservation", async () => {
  const o = await createOrder(input());
  let releaseLookup,
    lookupStarted,
    releaseCreate,
    createStarted,
    calls = 0;
  const lookupReady = new Promise((resolve) => {
    lookupStarted = resolve;
  });
  const createReady = new Promise((resolve) => {
    createStarted = resolve;
  });
  const service = new DeliverySyncService({
    ensureConfigured() {},
    async createPackages() {
      calls++;
      if (calls === 1) return {};
      createStarted();
      return new Promise((resolve) => {
        releaseCreate = resolve;
      });
    },
    async readPackages() {
      lookupStarted();
      return new Promise((resolve) => {
        releaseLookup = resolve;
      });
    },
  });
  await service.create(o._id);
  const lookup = service.reconcile(o._id, "OLD-TRACKING");
  await lookupReady;
  await service.reconcile(o._id, undefined, true);
  const retry = service.create(o._id);
  await createReady;
  releaseLookup({ Tracking: "OLD-TRACKING" });
  await assert.rejects(lookup, /Shipment changed/);
  await assert.rejects(
    service.reconcile(o._id, undefined, true),
    /still in progress/,
  );
  releaseCreate({ Tracking: "CURRENT-TRACKING", MessageRetour: "Good" });
  assert.equal((await retry).tracking, "CURRENT-TRACKING");
  assert.equal(calls, 2);
});

test("delivery sync batches by agency, uses order terminal state, persists outcomes, and isolates failures", async (t) => {
  const previousMap = process.env.DELIVERY_STATUS_MAP;
  process.env.DELIVERY_STATUS_MAP = JSON.stringify({
    " delivered ": "DELIVERED",
  });
  t.after(() => {
    if (previousMap === undefined) delete process.env.DELIVERY_STATUS_MAP;
    else process.env.DELIVERY_STATUS_MAP = previousMap;
  });
  const fixture = await courierFixture(t, (req, res, _call, body) => {
      assert.equal(req.url, "/lire");
      jsonReply(res, 200, {
        Colis: body.Colis.flatMap(({ Tracking }) =>
          Tracking === "SYNC-A"
            ? [{ Tracking, Statut: "Delivered", MessageRetour: "Good" }]
            : Tracking === "SYNC-B"
              ? [
                  {
                    Tracking,
                    Statut: "  Mystery   Status  ",
                    MessageRetour: "Good",
                  },
                ]
              : [],
        ),
      });
    }),
    orders = await Promise.all([
      createOrder(fixture.input),
      createOrder(fixture.input),
      createOrder(fixture.input),
      createOrder(fixture.input),
    ]);
  await Order.updateMany(
    { _id: { $in: orders.slice(0, 3).map((order) => order._id) } },
    { $set: { status: "SHIPPED" } },
  );
  await Order.updateOne(
    { _id: orders[3]._id },
    { $set: { status: "DELIVERED" } },
  );
  await Shipment.create(
    orders.map((order, index) => ({
      orderId: order._id,
      agencyId: fixture.agency._id,
      agencyName: fixture.agency.name,
      provider: "PROCOLIS",
      tracking: ["SYNC-A", "SYNC-B", "SYNC-C", "SYNC-TERMINAL"][index],
      trackingKey: ["SYNC-A", "SYNC-B", "SYNC-C", "SYNC-TERMINAL"][index],
      // Deliberately opposite for two records: eligibility must use Order.status.
      status: index === 0 ? "DELIVERED" : "SHIPPED",
    })),
  );
  const logs = [],
    originalLog = console.log;
  console.log = (...parts) => logs.push(parts.join(" "));
  let run;
  try {
    run = await deliveryService.syncBatch({ trigger: "CRON" });
  } finally {
    console.log = originalLog;
  }
  assert.equal(fixture.calls.length, 1);
  assert.equal(fixture.calls[0].url, "/lire");
  assert.deepEqual(
    fixture.calls[0].body.Colis.map((row) => row.Tracking).sort(),
    ["SYNC-A", "SYNC-B", "SYNC-C"],
  );
  assert.equal(run.status, "PARTIAL");
  assert.deepEqual(
    {
      scanned: run.scanned,
      eligible: run.eligible,
      attempted: run.attempted,
      successful: run.successful,
      changed: run.changed,
      unchanged: run.unchanged,
      terminalReached: run.terminalReached,
      unknownStatuses: run.unknownStatuses,
      failed: run.failed,
      skipped: run.skipped,
    },
    {
      scanned: 3,
      eligible: 3,
      attempted: 3,
      successful: 2,
      changed: 2,
      unchanged: 1,
      terminalReached: 1,
      unknownStatuses: 1,
      failed: 1,
      skipped: 0,
    },
  );
  assert.deepEqual(run.skipReasons, {
    noShipment: 0,
    noTracking: 0,
    missingAgency: 0,
    manualAgency: 0,
    trackingDisabled: 0,
  });
  assert.equal(logs.length, 1);
  assert.match(logs[0], /^\[DELIVERY SYNC\] trigger=CRON/);
  assert.equal(logs[0].includes("agency-token-private"), false);
  assert.equal(logs[0].includes("agency-key-private"), false);
  const storedRun = await DeliverySyncRun.findById(run.runId),
    items = await DeliverySyncItem.find({ runId: run.runId }).sort({
      tracking: 1,
    });
  assert.equal(storedRun.status, "PARTIAL");
  assert.equal(items.length, 3);
  assert.deepEqual(
    items.map((item) => item.result),
    ["SUCCESS", "UNKNOWN_STATUS", "ERROR"],
  );
  assert.deepEqual(
    {
      beforeProviderStatus: items[0].beforeProviderStatus || null,
      afterProviderStatus: items[0].afterProviderStatus,
      beforeOrderStatus: items[0].beforeOrderStatus,
      afterOrderStatus: items[0].afterOrderStatus,
      changed: items[0].changed,
      terminalReached: items[0].terminalReached,
    },
    {
      beforeProviderStatus: null,
      afterProviderStatus: "Delivered",
      beforeOrderStatus: "SHIPPED",
      afterOrderStatus: "DELIVERED",
      changed: true,
      terminalReached: true,
    },
  );
  assert.equal(items[1].afterProviderStatus, "Mystery   Status");
  assert.equal(items[1].afterOrderStatus, "SHIPPED");
  assert.equal(items[1].error, null);
  assert.equal(
    (await Shipment.findOne({ tracking: "SYNC-B" })).syncStatus,
    "SYNCED",
  );
  assert.equal((await Shipment.findOne({ tracking: "SYNC-B" })).status, null);
  assert.equal((await Order.findById(orders[2]._id)).status, "SHIPPED");
  assert.ok((await Shipment.findOne({ tracking: "SYNC-A" })).lastSyncedAt);
  assert.ok((await Shipment.findOne({ tracking: "SYNC-B" })).lastSyncedAt);
  assert.equal(
    (await Shipment.findOne({ tracking: "SYNC-C" })).lastSyncedAt,
    undefined,
  );

  const manual = expectOk(await apiAgent.post("/api/delivery-sync/run"));
  assert.equal(manual.trigger, "MANUAL");
  assert.equal(fixture.calls.length, 2);
  assert.deepEqual(
    fixture.calls[1].body.Colis.map((row) => row.Tracking).sort(),
    ["SYNC-B", "SYNC-C"],
  );
  assert.equal(await DeliverySyncRun.countDocuments(), 2);
  const history = expectOk(await apiAgent.get("/api/delivery-sync/runs"));
  assert.equal(history.total, 2);
  const detail = expectOk(
    await apiAgent.get(`/api/delivery-sync/runs/${manual.runId}`),
  );
  assert.equal(detail.run.trigger, "MANUAL");
  assert.equal(detail.items.length, 2);
});

test("delivery sync scans all non-terminal orders and reports eligibility skip reasons", async (t) => {
  const apiFixture = await courierFixture(t, (req, res, _call, body) => {
      assert.equal(req.url, "/lire");
      jsonReply(res, 200, {
        Colis: body.Colis.map(({ Tracking }) => ({
          Tracking,
          Situation: Tracking === "API-TRACK" ? "Livrée" : "Dispatcher",
        })),
      });
    }),
    manualAgency = await DeliveryAgency.create({
      name: "Sync manual courier",
      code: "SYNC_MANUAL",
      businesses: ["LOGIX"],
      integrationType: "MANUAL",
      apiProvider: "MANUAL",
      capabilities: { tracking: true },
    }),
    trackingDisabledAgency = await DeliveryAgency.create({
      name: "Sync tracking-disabled courier",
      code: "SYNC_TRACKING_DISABLED",
      businesses: ["LOGIX"],
      integrationType: "API",
      apiProvider: "PROCOLIS",
      capabilities: { tracking: false },
    }),
    manualInput = input("LOGIX_ONLY", {
      delivery: {
        agencyId: String(manualAgency._id),
        type: "HOME",
        exchange: false,
      },
      deliveryCharged: 500,
    }),
    trackingDisabledInput = input("LOGIX_ONLY", {
      delivery: {
        agencyId: String(trackingDisabledAgency._id),
        type: "HOME",
        exchange: false,
      },
      deliveryCharged: 500,
    });
  t.after(() =>
    DeliveryAgency.deleteMany({
      _id: { $in: [manualAgency._id, trackingDisabledAgency._id] },
    }),
  );

  const [imported, apiTracked, NO_SHIPMENT, noTracking, missingAgency, manual, trackingDisabled, terminal] =
    await Promise.all([
      createOrder(apiFixture.input),
      createOrder(apiFixture.input),
      createOrder(apiFixture.input),
      createOrder(apiFixture.input),
      createOrder(apiFixture.input),
      createOrder(manualInput),
      createOrder(trackingDisabledInput),
      createOrder(apiFixture.input),
    ]);
  await Promise.all([
    Order.updateOne({ _id: imported._id }, { $set: { status: "SHIPPED" } }),
    Order.updateOne(
      { _id: apiTracked._id },
      { $set: { status: "SHIPPED" } },
    ),
    Order.updateOne(
      { _id: noTracking._id },
      { $set: { status: "CONFIRMED" } },
    ),
    Order.updateOne(
      { _id: missingAgency._id },
      {
        $set: {
          status: "PREPARING",
          "delivery.agencyId": new mongoose.Types.ObjectId(),
        },
      },
    ),
    Order.updateOne(
      { _id: manual._id },
      { $set: { status: "READY_TO_SHIP" } },
    ),
    Order.updateOne(
      { _id: trackingDisabled._id },
      { $set: { status: "FAILED_DELIVERY" } },
    ),
    Order.updateOne({ _id: terminal._id }, { $set: { status: "DELIVERED" } }),
  ]);
  const missingAgencyId = (await Order.findById(missingAgency._id)).delivery
    .agencyId;
  await Shipment.create([
    {
      orderId: imported._id,
      agencyId: apiFixture.agency._id,
      agencyName: apiFixture.agency.name,
      origin: "EXCEL_IMPORT",
      provider: "PROCOLIS",
      tracking: "IMPORT-TRACK",
      trackingKey: "IMPORT-TRACK",
      status: "SHIPPED",
    },
    {
      orderId: apiTracked._id,
      agencyId: apiFixture.agency._id,
      agencyName: apiFixture.agency.name,
      provider: "PROCOLIS",
      tracking: "API-TRACK",
      trackingKey: "API-TRACK",
      status: "SHIPPED",
    },
    {
      orderId: noTracking._id,
      agencyId: apiFixture.agency._id,
      agencyName: apiFixture.agency.name,
      provider: "PROCOLIS",
      status: "CONFIRMED",
    },
    {
      orderId: missingAgency._id,
      agencyId: missingAgencyId,
      agencyName: "Missing agency",
      provider: "PROCOLIS",
      tracking: "MISSING-AGENCY",
      trackingKey: "MISSING-AGENCY",
      status: "PREPARING",
    },
    {
      orderId: manual._id,
      agencyId: manualAgency._id,
      agencyName: manualAgency.name,
      provider: "MANUAL",
      tracking: "MANUAL-SKIP",
      trackingKey: "MANUAL-SKIP",
      status: "READY_TO_SHIP",
    },
    {
      orderId: trackingDisabled._id,
      agencyId: trackingDisabledAgency._id,
      agencyName: trackingDisabledAgency.name,
      provider: "PROCOLIS",
      tracking: "TRACKING-DISABLED",
      trackingKey: "TRACKING-DISABLED",
      status: "FAILED_DELIVERY",
    },
    {
      orderId: terminal._id,
      agencyId: apiFixture.agency._id,
      agencyName: apiFixture.agency.name,
      provider: "PROCOLIS",
      tracking: "ALREADY-DELIVERED",
      trackingKey: "ALREADY-DELIVERED",
      status: "DELIVERED",
    },
  ]);

  const first = await deliveryService.syncBatch({ trigger: "CRON" });
  assert.deepEqual(
    {
      scanned: first.scanned,
      eligible: first.eligible,
      attempted: first.attempted,
      skipped: first.skipped,
    },
    { scanned: 7, eligible: 2, attempted: 2, skipped: 5 },
  );
  assert.deepEqual(first.skipReasons, {
    noShipment: 1,
    noTracking: 1,
    missingAgency: 1,
    manualAgency: 1,
    trackingDisabled: 1,
  });
  assert.equal(apiFixture.calls.length, 1);
  assert.equal(apiFixture.calls[0].url, "/lire");
  assert.deepEqual(
    apiFixture.calls[0].body.Colis.map((row) => row.Tracking).sort(),
    ["API-TRACK", "IMPORT-TRACK"],
  );
  assert.equal(
    apiFixture.calls.some((call) => call.url === "/add_colis"),
    false,
  );
  assert.ok(NO_SHIPMENT);
  assert.equal((await Order.findById(apiTracked._id)).status, "DELIVERED");
  assert.equal(
    (await Shipment.findOne({ orderId: imported._id })).syncStatus,
    "SYNCED",
  );
  const stored = await DeliverySyncRun.findById(first.runId).lean();
  assert.deepEqual(stored.skipReasons, first.skipReasons);
  const history = expectOk(await apiAgent.get("/api/delivery-sync/runs"));
  assert.deepEqual(history.items[0].skipReasons, first.skipReasons);

  const second = await deliveryService.syncBatch({ trigger: "CRON" });
  assert.deepEqual(
    {
      scanned: second.scanned,
      eligible: second.eligible,
      attempted: second.attempted,
      skipped: second.skipped,
    },
    { scanned: 6, eligible: 1, attempted: 1, skipped: 5 },
  );
  assert.equal(apiFixture.calls.length, 2);
  assert.deepEqual(apiFixture.calls[1].body.Colis, [
    { Tracking: "IMPORT-TRACK" },
  ]);
});

test("an active MongoDB delivery lease prevents concurrent cron execution", async (t) => {
  const previousMap = process.env.DELIVERY_STATUS_MAP;
  process.env.DELIVERY_STATUS_MAP = JSON.stringify({ shipped: "SHIPPED" });
  t.after(() => {
    if (previousMap === undefined) delete process.env.DELIVERY_STATUS_MAP;
    else process.env.DELIVERY_STATUS_MAP = previousMap;
  });
  let requestStarted, releaseRequest;
  const started = new Promise((resolve) => {
      requestStarted = resolve;
    }),
    blocked = new Promise((resolve) => {
      releaseRequest = resolve;
    }),
    fixture = await courierFixture(t, async (_req, res, _call, body) => {
      requestStarted();
      await blocked;
      jsonReply(res, 200, {
        Colis: body.Colis.map(({ Tracking }) => ({
          Tracking,
          Statut: "shipped",
          MessageRetour: "Good",
        })),
      });
    }),
    order = await createOrder(fixture.input);
  await Order.updateOne({ _id: order._id }, { $set: { status: "SHIPPED" } });
  await Shipment.create({
    orderId: order._id,
    agencyId: fixture.agency._id,
    agencyName: fixture.agency.name,
    provider: "PROCOLIS",
    tracking: "LOCKED-SYNC",
    trackingKey: "LOCKED-SYNC",
    status: "SHIPPED",
  });
  const first = deliveryService.syncBatch({ trigger: "CRON" });
  await started;
  const second = await deliveryService.syncBatch({ trigger: "CRON" });
  assert.equal(second.scanned, 0);
  assert.equal(second.skipped, 0);
  assert.equal(second.attempted, 0);
  releaseRequest();
  assert.equal((await first).status, "COMPLETED");
  assert.equal(fixture.calls.length, 1);
  assert.equal(await DeliverySyncRun.countDocuments(), 2);
});

test("delivery sync log permissions protect history and manual execution independently", async () => {
  const viewer = expectOk(
      await apiAgent.post("/api/users").send({
        name: "Sync viewer",
        email: "sync-viewer@example.com",
        password: "employee-password",
        businessAccess: [],
        permissions: [P.deliverySync.view],
      }),
    ),
    viewerAgent = supertest.agent(app),
    denied = supertest.agent(app);
  expectOk(
    await viewerAgent.post("/api/auth/login").send({
      email: viewer.email,
      password: "employee-password",
    }),
  );
  assert.equal(
    (await viewerAgent.get("/api/delivery-sync/status")).status,
    200,
  );
  assert.equal((await viewerAgent.get("/api/delivery-sync/runs")).status, 200);
  assert.equal((await viewerAgent.post("/api/delivery-sync/run")).status, 403);
  const deniedUser = expectOk(
    await apiAgent.post("/api/users").send({
      name: "No sync access",
      email: "no-sync@example.com",
      password: "employee-password",
      businessAccess: [],
      permissions: [],
    }),
  );
  expectOk(
    await denied.post("/api/auth/login").send({
      email: deniedUser.email,
      password: "employee-password",
    }),
  );
  assert.equal((await denied.get("/api/delivery-sync/status")).status, 403);
});
