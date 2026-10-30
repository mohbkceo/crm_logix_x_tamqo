import { z } from "zod";
import { Order, Shipment } from "../models/index.js";
import { DeliveryAgency } from "../models/delivery.js";
import { User, audit } from "../models/security.js";
import {
  TrackingIssue,
  TrackingEvent,
  IssueType,
  TrackingSetting,
} from "../models/tracking.js";
import {
  can,
  P,
  orderScope,
  requireBusinesses,
  orderBusinesses,
} from "../authorization.js";
import { assert } from "../errors.js";
import { transaction } from "./orderService.js";
import { deliveryService } from "./delivery/deliveryService.js";
import { objectId, pagination, escapeRegex } from "./filters.js";
import {
  COURIER_STAGES,
  PRODUCTION_STAGES,
  STAGE_ACTIONS,
  SEVERITIES,
} from "../../../shared/tracking.js";
import { mapProviderStatus } from "./delivery/deliveryStatusMapper.js";
import { whatsAppUrl } from "../domain/whatsapp.js";
import { QUICK_TAGS } from "../../../shared/trackingFilters.js";
import { canManageIssueMedia } from "./mediaAccess.js";
import {
  parseTrackingFilters,
  lifecycleFilter,
  internalQueueFilter,
  quickTagFilters,
  tagCategories,
  matchTagCategories,
} from "./trackingFilters.js";

export const revisionInput = z.number().int().min(0);
export const stageInput = z
  .object({
    targetStage: z.enum(PRODUCTION_STAGES),
    expectedRevision: revisionInput,
  })
  .strict();
export const eligible = (order) =>
  order.items.some((i) => i.business === "LOGIX" && i.type === "PRODUCT");
export const courierOwns = (order, shipment) =>
  Boolean(
    order.tracking?.courierOwned ||
    COURIER_STAGES.includes(order.status) ||
    COURIER_STAGES.includes(shipment?.status) ||
    COURIER_STAGES.includes(mapProviderStatus(shipment?.providerStatus)),
  );
const elevated = (user) => ["ADMIN", "SUPER_ADMIN"].includes(user.role);
const actor = (user) => ({ userId: user._id, name: user.name });
export const trackingState = (order) =>
  order.tracking || {
    stage: "LEGACY_UNINITIALIZED",
    openIssues: 0,
    blockingIssues: 0,
  };
export function trackingScope(user) {
  assert(can(user, P.tracking.view), "Tracking access denied", 403);
  const clauses = [
    orderScope(user),
    { items: { $elemMatch: { business: "LOGIX", type: "PRODUCT" } } },
  ];
  if (!can(user, P.tracking.viewAll)) {
    const choices = [
      { "createdBy.userId": user._id },
      { "tracking.designerId": user._id },
      { "tracking.productionId": user._id },
    ];
    if (user.operationalRoles?.includes("DESIGNER"))
      choices.push({
        "tracking.stage": { $in: ["PREPARING", "AT_PRODUCTION"] },
        "tracking.designerId": null,
      });
    if (
      user.operationalRoles?.some((r) =>
        ["PRODUCTION", "PRODUCTION_MANAGER"].includes(r),
      )
    )
      choices.push({
        "tracking.stage": { $in: ["AT_PRODUCTION", "READY_TO_SHIP"] },
        "tracking.productionId": null,
      });
    clauses.push({ $or: choices });
  }
  return { $and: clauses };
}
export async function accessibleOrder(user, id, session = null) {
  const order = await Order.findOne({
    ...trackingScope(user),
    _id: objectId(id),
  }).session(session);
  assert(order, "Order unavailable in your Tracking scope", 404);
  return order;
}
export function stageTargets(user, order, shipment) {
  if (
    courierOwns(order, shipment) ||
    order.deletedAt ||
    order.tracking?.blockingIssues > 0 ||
    shipment?.uncertain ||
    shipment?.lockUntil > new Date()
  )
    return [];
  return PRODUCTION_STAGES.filter((target) => {
    const action = STAGE_ACTIONS[`${order.tracking?.stage}:${target}`];
    return (
      action &&
      can(user, action.permission) &&
      (elevated(user) ||
        user.operationalRoles?.some((r) => action.roles.includes(r)))
    );
  });
}
async function writeEvent(
  order,
  user,
  kind,
  previousStage,
  session,
  data = {},
) {
  order.revision++;
  await order.save({ session });
  await TrackingEvent.create(
    [
      {
        orderId: order._id,
        kind,
        previousStage,
        newStage: order.tracking.stage,
        actor: actor(user),
        revision: order.revision,
        data,
      },
    ],
    { session },
  );
  await audit(
    actor(user),
    kind,
    "Order",
    order._id,
    order.businessType,
    { revision: order.revision, ...data },
    session,
  );
}
async function mutate(user, id, expectedRevision, operation) {
  return transaction(async (session) => {
    const order = await accessibleOrder(user, id, session);
    assert(
      order.revision === expectedRevision,
      "This order changed. Refresh and try again.",
      409,
      "CONFLICT",
    );
    if (!order.tracking) order.tracking = trackingState(order);
    await operation(order, session);
    return {
      orderId: order._id,
      revision: order.revision,
      tracking: order.tracking,
    };
  });
}
async function moveToCourierReady(user, id, data) {
  // Validate before sending any external request; bulk and single actions use this path.
  const order = await accessibleOrder(user, id);
  assert(
    order.revision === data.expectedRevision,
    "This order changed. Refresh and try again.",
    409,
    "CONFLICT",
  );
  const [shipment, agency] = await Promise.all([
    Shipment.findOne({ orderId: order._id }),
    DeliveryAgency.findById(order.delivery.agencyId),
  ]);
  assert(
    stageTargets(user, order, shipment).includes("READY_TO_SHIP"),
    "Production is locked by courier ownership, a pending courier operation, or a blocking report.",
    409,
  );
  assert(
    agency?.integrationType === "API" &&
      agency.apiProvider === "PROCOLIS" &&
      agency.capabilities?.readyToShip,
    "This delivery agency cannot confirm readiness automatically.",
    409,
  );
  assert(
    shipment?.tracking && !shipment.uncertain,
    "Reconcile and link the courier parcel before marking it ready.",
    409,
  );

  // The provider's /pret acknowledgement must arrive BEFORE the local stage moves.
  // A single database transaction then records the commercial and production states.
  await deliveryService.ready(order._id, actor(user), {
    expectedRevision: data.expectedRevision,
    onConfirmed: async (confirmedOrder, session) => {
      assert(
        confirmedOrder.tracking?.stage === "AT_PRODUCTION",
        "Production changed while courier readiness was being confirmed.",
        409,
      );
      const previous = confirmedOrder.tracking.stage;
      confirmedOrder.tracking.stage = "READY_TO_SHIP";
      confirmedOrder.tracking.stageEnteredAt = new Date();
      await writeEvent(
        confirmedOrder,
        user,
        "TRACKING_STAGE_CHANGED",
        previous,
        session,
        { courierReadinessConfirmed: true },
      );
    },
  });
  const current = await Order.findById(order._id);
  return {
    orderId: current._id,
    revision: current.revision,
    tracking: current.tracking,
  };
}

export async function moveStage(user, id, payload) {
  const data = stageInput.parse(payload);
  if (data.targetStage === "READY_TO_SHIP")
    return moveToCourierReady(user, id, data);
  return mutate(user, id, data.expectedRevision, async (order, session) => {
    const shipment = await Shipment.findOne({ orderId: order._id }).session(
      session,
    );
    const action = STAGE_ACTIONS[`${order.tracking.stage}:${data.targetStage}`];
    assert(
      action &&
        can(user, action.permission) &&
        (elevated(user) ||
          user.operationalRoles?.some((r) => action.roles.includes(r))),
      "Production transition is not authorized for your operational role",
      403,
    );
    assert(
      stageTargets(user, order, shipment).includes(data.targetStage),
      "Production is locked by courier ownership, a pending courier operation, or a blocking report.",
      409,
    );
    const previous = order.tracking.stage;
    order.tracking.stage = data.targetStage;
    order.tracking.stageEnteredAt = new Date();
    await writeEvent(order, user, "TRACKING_STAGE_CHANGED", previous, session);
  });
}
export async function markImportant(user, id, payload) {
  assert(can(user, P.tracking.assign), "Priority update denied", 403);
  const data = z
    .object({ important: z.boolean(), expectedRevision: revisionInput })
    .strict()
    .parse(payload);
  return mutate(user, id, data.expectedRevision, async (order, session) => {
    if (Boolean(order.tracking.important) === data.important) return;
    order.tracking.important = data.important;
    order.tracking.importantUpdatedBy = actor(user);
    order.tracking.importantUpdatedAt = new Date();
    await writeEvent(
      order,
      user,
      "TRACKING_PRIORITY_CHANGED",
      order.tracking.stage,
      session,
      { important: data.important },
    );
  });
}
export async function initializeTracking(user, id, payload) {
  const data = z
    .object({ expectedRevision: revisionInput })
    .strict()
    .parse(payload);
  assert(
    can(user, P.tracking.assign) &&
      (elevated(user) || user.operationalRoles?.includes("PRODUCTION_MANAGER")),
    "Initialization denied",
    403,
  );
  return mutate(user, id, data.expectedRevision, async (order, session) => {
    const shipment = await Shipment.findOne({ orderId: order._id }).session(
      session,
    );
    assert(
      order.tracking.stage === "LEGACY_UNINITIALIZED" &&
        !courierOwns(order, shipment) &&
        !shipment?.uncertain &&
        !(shipment?.lockUntil > new Date()) &&
        !order.tracking.blockingIssues,
      "Historical order cannot be initialized in its current state.",
      409,
    );
    order.tracking.stage = "PREPARING";
    order.tracking.stageEnteredAt = new Date();
    order.tracking.initializedAt = new Date();
    await writeEvent(
      order,
      user,
      "TRACKING_INITIALIZED",
      "LEGACY_UNINITIALIZED",
      session,
    );
  });
}
export async function assignTracking(user, id, payload) {
  const data = z
    .object({
      expectedRevision: revisionInput,
      designerId: z.string().nullable(),
      productionId: z.string().nullable(),
    })
    .strict()
    .parse(payload);
  assert(can(user, P.tracking.assign), "Assignment denied", 403);
  return mutate(user, id, data.expectedRevision, async (order, session) => {
    for (const [key, roles] of [
      ["designerId", ["DESIGNER"]],
      ["productionId", ["PRODUCTION", "PRODUCTION_MANAGER"]],
    ]) {
      if (data[key]) {
        const employee = await User.findOne({
          _id: objectId(data[key]),
          status: "ACTIVE",
          operationalRoles: { $in: roles },
        }).session(session);
        assert(
          employee && can(employee, P.tracking.view),
          "Select an active employee in the appropriate operational team",
        );
        requireBusinesses(employee, orderBusinesses(order));
      }
      order.tracking[key] = data[key];
    }
    await writeEvent(
      order,
      user,
      "TRACKING_ASSIGNED",
      order.tracking.stage,
      session,
      { designerId: data.designerId, productionId: data.productionId },
    );
  });
}
export async function createIssue(user, id, payload) {
  assert(can(user, P["tracking.issue"].create), "Reporting denied", 403);
  const data = z
    .object({
      expectedRevision: revisionInput,
      typeId: z.string(),
      severity: z.enum(SEVERITIES),
      description: z.string().trim().max(2000).optional().default(""),
      requestId: z.string().uuid(),
    })
    .strict()
    .parse(payload);
  return mutate(user, id, data.expectedRevision, async (order, session) => {
    const type = await IssueType.findOne({
      _id: objectId(data.typeId),
      enabled: true,
    }).session(session);
    assert(type, "Select an enabled issue type");
    const {
      label,
      description,
      defaultSeverity,
      blocksProduction,
      responsibleTeam,
      indicator,
    } = type;
    const blocking = blocksProduction || data.severity === "CRITICAL";
    const [issue] = await TrackingIssue.create(
      [
        {
          orderId: order._id,
          typeId: type._id,
          typeSnapshot: {
            label,
            description,
            defaultSeverity,
            blocksProduction,
            responsibleTeam,
            indicator,
          },
          severity: data.severity,
          description: data.description,
          blocking,
          requestId: data.requestId,
          reporter: actor(user),
          reporterRoles: user.operationalRoles || [],
        },
      ],
      { session },
    );
    order.tracking.openIssues = (order.tracking.openIssues || 0) + 1;
    order.tracking.blockingIssues =
      (order.tracking.blockingIssues || 0) + Number(blocking);
    order.tracking.criticalIssues =
      (order.tracking.criticalIssues || 0) +
      Number(data.severity === "CRITICAL");
    await writeEvent(
      order,
      user,
      "TRACKING_ISSUE_CREATED",
      order.tracking.stage,
      session,
      { issueId: String(issue._id) },
    );
  });
}
export async function resolveIssue(user, id, issueId, payload) {
  assert(
    can(user, P["tracking.issue"].resolve),
    "Issue resolution denied",
    403,
  );
  const data = z
    .object({ expectedRevision: revisionInput })
    .strict()
    .parse(payload);
  return mutate(user, id, data.expectedRevision, async (order, session) => {
    const issue = await TrackingIssue.findOne({
      _id: objectId(issueId),
      orderId: order._id,
    }).session(session);
    assert(issue, "Report not found", 404);
    assert(issue.status === "OPEN", "This report is already resolved", 409);
    issue.status = "RESOLVED";
    issue.resolvedBy = actor(user);
    issue.resolvedAt = new Date();
    await issue.save({ session });
    order.tracking.openIssues = Math.max(
      0,
      (order.tracking.openIssues || 0) - 1,
    );
    order.tracking.blockingIssues = Math.max(
      0,
      (order.tracking.blockingIssues || 0) - Number(issue.blocking),
    );
    order.tracking.criticalIssues = Math.max(
      0,
      (order.tracking.criticalIssues || 0) -
        Number(issue.severity === "CRITICAL"),
    );
    await writeEvent(
      order,
      user,
      "TRACKING_ISSUE_RESOLVED",
      order.tracking.stage,
      session,
      { issueId },
    );
  });
}
export async function listIssues(user, id, query) {
  assert(can(user, P["tracking.issue"].view), "Report access denied", 403);
  const order = await accessibleOrder(user, id),
    p = pagination(query);
  const filter = { orderId: order._id };
  const [items, total] = await Promise.all([
    TrackingIssue.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip(p.skip)
      .limit(p.limit)
      .lean(),
    TrackingIssue.countDocuments(filter),
  ]);
  const contacts = can(user, P["tracking.contacts"].view)
    ? await User.find({
        _id: { $in: items.map((i) => i.reporter.userId) },
        status: "ACTIVE",
      })
        .select("+whatsappPhone name")
        .lean()
    : [];
  return {
    items: items.map((i) => ({
      ...i,
      canManageAttachments: canManageIssueMedia(user, i),
      attachments: (i.attachments || []).map((image) => ({
        _id: image._id,
        url: `/api/issue-media/${order._id}/${i._id}/${image._id}`,
      })),
      reporterContact: contact(
        contacts.find((u) => String(u._id) === String(i.reporter.userId)),
        can(user, P["tracking.contacts"].view),
      ),
    })),
    total,
    page: p.page,
    limit: p.limit,
    revision: order.revision,
  };
}
function contact(user, permitted) {
  return {
    name: user?.name || null,
    url:
      permitted && user?.status !== "DISABLED"
        ? whatsAppUrl(user?.whatsappPhone)
        : null,
    unavailableReason: !permitted
      ? "Contact permission required"
      : !user || user.status === "DISABLED"
        ? "Employee unavailable or unassigned"
        : !user.whatsappPhone
          ? "WhatsApp number unavailable"
          : null,
  };
}
export async function presentOrders(user, orders) {
  const permitted = can(user, P["tracking.contacts"].view);
  const settings = await TrackingSetting.findById("tracking").lean();
  const ids = orders
    .flatMap((o) => [
      o.createdBy?.userId,
      o.tracking?.designerId,
      o.tracking?.productionId,
    ])
    .concat(settings?.fallbackContactId)
    .filter(Boolean);
  const [people, shipments] = await Promise.all([
    User.find({ _id: { $in: ids } })
      .select(
        `name status businessAccess role operationalRoles ${permitted ? "+whatsappPhone" : ""}`,
      )
      .lean(),
    Shipment.find({ orderId: { $in: orders.map((o) => o._id) } })
      .select(
        "orderId agencyId tracking status providerStatus syncStatus lastError lockUntil uncertain",
      )
      .populate("agencyId", "code name")
      .lean(),
  ]);
  const peopleById = new Map(people.map((p) => [String(p._id), p])),
    shipmentByOrder = new Map(shipments.map((s) => [String(s.orderId), s]));
  return orders.map((o) => {
    const shipment = shipmentByOrder.get(String(o._id)),
      state = trackingState(o),
      owned = courierOwns(o, shipment);
    let responsible = peopleById.get(
      String(
        !owned
          ? state.stage === "PREPARING"
            ? state.designerId
            : state.productionId
          : null,
      ),
    );
    const responsibleRoles =
      state.stage === "PREPARING"
        ? ["DESIGNER"]
        : ["PRODUCTION", "PRODUCTION_MANAGER"];
    if (
      responsible &&
      !responsible.operationalRoles?.some((r) => responsibleRoles.includes(r))
    )
      responsible = null;
    if (!responsible || responsible.status !== "ACTIVE")
      responsible = peopleById.get(String(settings?.fallbackContactId));
    if (
      responsible &&
      responsible.role !== "SUPER_ADMIN" &&
      !orderBusinesses(o).every((b) => responsible.businessAccess.includes(b))
    )
      responsible = null;
    return {
      _id: o._id,
      orderNumber: o.orderNumber,
      customer: o.customer,
      businessType: o.businessType,
      items: o.items.map(({ name, quantity, specifications }) => ({
        name,
        quantity,
        specifications,
      })),
      note: o.note,
      createdAt: o.createdAt,
      status: o.status,
      revision: o.revision,
      canViewOrder:
        can(user, P.orders.viewAll) ||
        (can(user, P.orders.viewOwn) &&
          String(o.createdBy?.userId) === String(user._id)),
      tracking: state,
      canMarkImportant: can(user, P.tracking.assign),
      courierOwned: owned,
      images: (o.images || []).map((i) => ({
        _id: i._id,
        url: `/api/order-media/${o._id}/${i._id}`,
      })),
      allowedTargets: stageTargets(user, o, shipment),
      canInitialize:
        state.stage === "LEGACY_UNINITIALIZED" &&
        !owned &&
        !state.blockingIssues &&
        !shipment?.uncertain &&
        !(shipment?.lockUntil > new Date()) &&
        can(user, P.tracking.assign) &&
        (elevated(user) ||
          user.operationalRoles?.includes("PRODUCTION_MANAGER")),
      creatorContact: contact(
        peopleById.get(String(o.createdBy?.userId)),
        permitted,
      ),
      responsible: contact(responsible, permitted),
      shipment: shipment
        ? {
            tracking: shipment.tracking,
            status: shipment.status,
            providerStatus: shipment.providerStatus,
            syncStatus: shipment.syncStatus,
            lastError: shipment.lastError,
            agencyName: shipment.agencyId?.name,
            url:
              shipment.tracking && shipment.agencyId?.code === "ABEX"
                ? `https://abex-dz.com/ABEX-DZ_WEB/FR/liste.awp?P1=x&P2=Tracking&P3=${encodeURIComponent(shipment.tracking)}`
                : null,
          }
        : null,
    };
  });
}
export async function listTracking(user, query, now = new Date()) {
  const q = parseTrackingFilters(user, query),
    filter = trackingScope(user),
    p = pagination(q);
  filter.$and.push(lifecycleFilter(q));
  if (q.business) filter.$and.push({ businessType: q.business });
  if (q.stage === "LEGACY_UNINITIALIZED")
    filter.$and.push({
      $or: [{ "tracking.stage": q.stage }, { tracking: { $exists: false } }],
    });
  else if (q.stage) filter.$and.push({ "tracking.stage": q.stage });
  if (q.employee)
    filter.$and.push({
      $or: [
        { "tracking.designerId": objectId(q.employee) },
        { "tracking.productionId": objectId(q.employee) },
        { "createdBy.userId": objectId(q.employee) },
      ],
    });
  if (q.from || q.to)
    filter.$and.push({
      createdAt: {
        ...(q.from ? { $gte: new Date(q.from + "T00:00:00+01:00") } : {}),
        ...(q.to
          ? { $lt: new Date(+new Date(q.to + "T00:00:00+01:00") + 86400000) }
          : {}),
      },
    });
  const pipeline = [{ $match: filter }];
  if (q.search || q.courierStatus || q.attention === "internal") {
    pipeline.push({
      $lookup: {
        from: Shipment.collection.name,
        localField: "_id",
        foreignField: "orderId",
        as: "parcel",
      },
    });
    if (q.search) {
      const r = { $regex: escapeRegex(q.search), $options: "i" };
      pipeline.push({
        $match: {
          $or: [
            "orderNumber",
            "customer.name",
            "customer.phoneA",
            "customer.normalizedPhone",
            "items.name",
            "parcel.tracking",
          ].map((k) => ({ [k]: r })),
        },
      });
    }
    if (q.courierStatus)
      pipeline.push({ $match: { "parcel.status": q.courierStatus } });
    if (q.attention === "internal")
      pipeline.push({ $match: internalQueueFilter });
  }
  const predicates = quickTagFilters(user, now),
    groups = tagCategories(q);
  const match = matchTagCategories(groups, predicates);
  const priorityStages =
    q.sort === "issuesFirst"
      ? [
          {
            $lookup: {
              from: TrackingIssue.collection.name,
              let: { order: "$_id" },
              pipeline: [
                {
                  $match: {
                    $expr: { $eq: ["$orderId", "$$order"] },
                    status: "OPEN",
                    "typeSnapshot.responsibleTeam": "SALES_CONFIRMATION",
                  },
                },
                { $limit: 1 },
                { $project: { _id: 1 } },
              ],
              as: "_salesReports",
            },
          },
          {
            $set: {
              _hasIssues: {
                $cond: [
                  { $gt: [{ $ifNull: ["$tracking.openIssues", 0] }, 0] },
                  1,
                  0,
                ],
              },
              _salesAttention: { $size: "$_salesReports" },
            },
          },
        ]
      : [];
  const direction = q.sort === "newest" ? -1 : 1;
  const facet = {
    items: [
      { $match: match },
      ...priorityStages,
      {
        $sort: {
          ...(q.sort === "issuesFirst"
            ? { _hasIssues: -1, _salesAttention: -1 }
            : {}),
          createdAt: direction,
          _id: direction,
        },
      },
      { $skip: p.skip },
      { $limit: p.limit },
      {
        $project: {
          originalData: 0,
          statusHistory: 0,
          refunds: 0,
          parcel: 0,
          _salesReports: 0,
          _hasIssues: 0,
          _salesAttention: 0,
        },
      },
    ],
    total: [{ $match: match }, { $count: "value" }],
  };
  // Faceted counts apply the other categories, replacing this chip's category.
  // Every facet starts from the same authorized, searched and staged records.
  for (const tag of QUICK_TAGS)
    facet[tag.value] = [
      {
        $match: {
          $and: [
            matchTagCategories(groups, predicates, tag.category),
            predicates[tag.value],
          ],
        },
      },
      { $count: "value" },
    ];
  pipeline.push({ $facet: facet });
  const [result] = await Order.aggregate(pipeline);
  return {
    items: await presentOrders(user, result.items),
    total: result.total[0]?.value || 0,
    page: p.page,
    limit: p.limit,
    tagCounts: Object.fromEntries(
      QUICK_TAGS.map((t) => [t.value, result[t.value][0]?.value || 0]),
    ),
  };
}
export async function employeeOptions(user, query = {}) {
  const p = pagination(query);
  const filter = {
    status: "ACTIVE",
    businessAccess: {
      $in:
        user.role === "SUPER_ADMIN"
          ? ["LOGIX"]
          : user.businessAccess.filter((b) => b === "LOGIX"),
    },
  };
  return User.find(filter)
    .select("name operationalRoles")
    .sort({ name: 1, _id: 1 })
    .skip(p.skip)
    .limit(p.limit)
    .lean();
}
export async function trackingHistory(user, id, query) {
  const order = await accessibleOrder(user, id);
  assert(can(user, P.audit.view), "Audit access denied", 403);
  const p = pagination(query),
    filter = { orderId: order._id };
  const [items, total] = await Promise.all([
    TrackingEvent.find(filter)
      .sort({ revision: -1 })
      .skip(p.skip)
      .limit(p.limit)
      .lean(),
    TrackingEvent.countDocuments(filter),
  ]);
  return { items, total, page: p.page, limit: p.limit };
}
