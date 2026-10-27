import { Router } from "express";
import { z } from "zod";
import { P, can, requirePermission } from "../authorization.js";
import { assert } from "../errors.js";
import { objectId, pagination } from "../services/filters.js";
import { transaction } from "../services/orderService.js";
import { IssueType, TrackingSetting } from "../models/tracking.js";
import { User, audit } from "../models/security.js";
import { OPERATIONAL_ROLES, SEVERITIES } from "../../../shared/tracking.js";
import {
  listTracking,
  accessibleOrder,
  presentOrders,
  stageInput,
  moveStage,
  initializeTracking,
  assignTracking,
  createIssue,
  resolveIssue,
  listIssues,
  trackingHistory,
  employeeOptions,
  revisionInput,
} from "../services/trackingService.js";
const router = Router();
const admin = (req, _res, next) => {
  assert(
    ["SUPER_ADMIN", "ADMIN"].includes(req.user.role),
    "Administrator required",
    403,
  );
  next();
};
const typeInput = z
  .object({
    label: z.string().trim().min(1).max(100),
    description: z.string().trim().max(500).default(""),
    defaultSeverity: z.enum(SEVERITIES),
    blocksProduction: z.boolean(),
    responsibleTeam: z.enum([...OPERATIONAL_ROLES, ""]),
    enabled: z.boolean(),
    sortOrder: z.number().int().min(0).max(10000),
    indicator: z.enum(["INFO", "FLAG", "ATTENTION"]),
    expectedRevision: revisionInput.optional(),
  })
  .strict();
router.get(
  "/issue-types",
  requirePermission(P.tracking.view, P["tracking.issueTypes"].manage),
  async (req, res) => {
    const p = pagination(req.query),
      filter =
        req.query.includeDisabled === "true" &&
        can(req.user, P["tracking.issueTypes"].manage)
          ? {}
          : { enabled: true };
    const [items, total] = await Promise.all([
      IssueType.find(filter)
        .sort({ sortOrder: 1, _id: 1 })
        .skip(p.skip)
        .limit(p.limit)
        .lean(),
      IssueType.countDocuments(filter),
    ]);
    res.json({ items, total, page: p.page, limit: p.limit });
  },
);
async function saveType(req, res) {
  const data = typeInput.parse(req.body);
  const result = await transaction(async (session) => {
    let type;
    if (req.params.typeId) {
      type = await IssueType.findById(objectId(req.params.typeId)).session(
        session,
      );
      assert(type, "Issue type not found", 404);
      assert(
        type.__v === data.expectedRevision,
        "Issue type changed. Reload.",
        409,
      );
      assert(
        type.code !== "OTHER" || data.enabled,
        "Other must remain enabled for unexpected problems",
      );
    } else {
      assert(
        (await IssueType.countDocuments({ enabled: true }).session(session)) <
          100,
        "Disable an unused type before adding more than 100 active types",
      );
      type = new IssueType();
    }
    const { expectedRevision: _revision, ...fields } = data;
    Object.assign(type, fields);
    await type.save({ session });
    await audit(
      req.actor,
      "TRACKING_ISSUE_TYPE_UPDATED",
      "TrackingIssueType",
      type._id,
      undefined,
      { label: type.label },
      session,
    );
    return type;
  });
  res.status(req.params.typeId ? 200 : 201).json(result);
}
router.post(
  "/issue-types",
  admin,
  requirePermission(P["tracking.issueTypes"].manage),
  saveType,
);
router.patch(
  "/issue-types/:typeId",
  admin,
  requirePermission(P["tracking.issueTypes"].manage),
  saveType,
);
router.get(
  "/settings",
  admin,
  requirePermission(P["tracking.settings"].manage),
  async (_req, res) =>
    res.json(
      (await TrackingSetting.findById("tracking")) || new TrackingSetting(),
    ),
);
router.patch(
  "/settings",
  admin,
  requirePermission(P["tracking.settings"].manage),
  async (req, res) => {
    const data = z
      .object({
        expectedRevision: revisionInput,
        requireWhatsApp: z.boolean(),
        fallbackContactId: z.string().nullable(),
        operationalRoles: z
          .array(
            z
              .object({
                code: z.enum(OPERATIONAL_ROLES),
                label: z.string().trim().min(1).max(60),
                enabled: z.boolean(),
              })
              .strict(),
          )
          .length(4),
      })
      .strict()
      .parse(req.body);
    assert(
      new Set(data.operationalRoles.map((r) => r.code)).size === 4,
      "Each operational role must appear once",
    );
    const saved = await transaction(async (session) => {
      const s =
        (await TrackingSetting.findById("tracking").session(session)) ||
        new TrackingSetting();
      assert(
        (s.__v || 0) === data.expectedRevision,
        "Settings changed. Reload.",
        409,
      );
      if (data.fallbackContactId) {
        const employee = await User.findOne({
          _id: objectId(data.fallbackContactId),
          status: "ACTIVE",
        }).session(session);
        assert(
          employee &&
            (employee.role === "SUPER_ADMIN" ||
              employee.businessAccess.includes("LOGIX")),
          "Fallback contact needs Logix access",
        );
      }
      const { expectedRevision: _revision, ...fields } = data;
      Object.assign(s, fields);
      await s.save({ session });
      await audit(
        req.actor,
        "TRACKING_SETTINGS_UPDATED",
        "TrackingSetting",
        s._id,
        undefined,
        {},
        session,
      );
      return s;
    });
    res.json(saved);
  },
);
router.get(
  "/employees",
  requirePermission(P.tracking.view, P["tracking.settings"].manage),
  async (req, res) => res.json(await employeeOptions(req.user, req.query)),
);
router.use(requirePermission(P.tracking.view));
router.get("/", async (req, res) =>
  res.json(await listTracking(req.user, req.query)),
);
router.post(
  "/bulk-stage",
  requirePermission(P.tracking.bulkUpdate),
  async (req, res) => {
    const data = z
      .object({
        orders: z
          .array(stageInput.extend({ orderId: z.string() }))
          .min(1)
          .max(100),
      })
      .strict()
      .parse(req.body);
    assert(
      new Set(data.orders.map((o) => o.orderId)).size === data.orders.length,
      "Duplicate order in bulk request",
    );
    const results = [];
    for (const { orderId, ...payload } of data.orders) {
      try {
        results.push({
          orderId,
          success: true,
          ...(await moveStage(req.user, orderId, payload)),
        });
      } catch (error) {
        const known =
          error.status ||
          ["VersionError", "ValidationError", "CastError"].includes(error.name);
        results.push({
          orderId,
          success: false,
          error: known
            ? error.message
            : "This order could not be saved. Refresh and retry.",
          status: error.status || (known ? 409 : 500),
        });
      }
    }
    res.json({ results });
  },
);
router.get("/:orderId", async (req, res) =>
  res.json(
    (
      await presentOrders(req.user, [
        (await accessibleOrder(req.user, req.params.orderId)).toObject(),
      ])
    )[0],
  ),
);
router.patch("/:orderId/stage", async (req, res) =>
  res.json(await moveStage(req.user, req.params.orderId, req.body)),
);
router.post("/:orderId/initialize", async (req, res) =>
  res.json(await initializeTracking(req.user, req.params.orderId, req.body)),
);
router.patch("/:orderId/assign", async (req, res) =>
  res.json(await assignTracking(req.user, req.params.orderId, req.body)),
);
router.get("/:orderId/history", async (req, res) =>
  res.json(await trackingHistory(req.user, req.params.orderId, req.query)),
);
router.get("/:orderId/issues", async (req, res) =>
  res.json(await listIssues(req.user, req.params.orderId, req.query)),
);
router.post("/:orderId/issues", async (req, res) =>
  res
    .status(201)
    .json(await createIssue(req.user, req.params.orderId, req.body)),
);
router.post("/:orderId/issues/:issueId/resolve", async (req, res) =>
  res.json(
    await resolveIssue(
      req.user,
      req.params.orderId,
      req.params.issueId,
      req.body,
    ),
  ),
);
export default router;
