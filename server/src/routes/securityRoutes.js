import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import {
  User,
  Session,
  RegistrationSetting,
  AuditLog,
  audit,
} from "../models/security.js";
import { identityInput } from "../auth.js";
import {
  P,
  can,
  requirePermission,
  requireBusinesses,
} from "../authorization.js";
import { PERMISSIONS, ROLES, BUSINESSES } from "../../../shared/permissions.js";
import { assert } from "../errors.js";
import { pagination, objectId } from "../services/filters.js";
import { transaction } from "../services/orderService.js";
export const securityRoutes = Router();
const r = securityRoutes;
const superOnly = (req, _res, next) => {
  assert(req.user.role === "SUPER_ADMIN", "Super Admin required", 403);
  next();
};
const manageable = (actor, target) => {
  if (actor.role === "SUPER_ADMIN") return;
  assert(
    actor.role === "ADMIN" &&
      target.role === "EMPLOYEE" &&
      String(actor._id) !== String(target._id),
    "Only Super Admin can manage elevated accounts",
    403,
  );
  assert(
    target.businessAccess.every((b) => actor.businessAccess.includes(b)),
    "User is outside your business scope",
    403,
  );
};
const userFilter = (user) =>
  user.role === "SUPER_ADMIN"
    ? {}
    : {
        role: "EMPLOYEE",
        businessAccess: { $not: { $elemMatch: { $nin: user.businessAccess } } },
      };
r.get("/users", requirePermission(P.users.view), async (req, res) => {
  assert(
    ["ADMIN", "SUPER_ADMIN"].includes(req.user.role),
    "Administrator required",
    403,
  );
  res.json(await User.find(userFilter(req.user)).sort({ name: 1 }));
});
r.get("/users/:id", requirePermission(P.users.view), async (req, res) => {
  const user = await User.findById(objectId(req.params.id));
  assert(user, "User not found", 404);
  manageable(req.user, user);
  res.json(user);
});
const accessSchema = z.object({
  role: z.enum(ROLES).optional(),
  status: z.enum(["ACTIVE", "DISABLED"]).optional(),
  businessAccess: z.array(z.enum(BUSINESSES)).max(2).optional(),
  permissions: z.array(z.enum(PERMISSIONS)).optional(),
});
function validateAccess(req, data, existing) {
  if (data.permissions !== undefined || data.businessAccess !== undefined)
    assert(
      can(req.user, P.users.permissions),
      "Permission assignment denied",
      403,
    );
  if (req.user.role !== "SUPER_ADMIN") {
    assert(
      req.user.role === "ADMIN" && (!data.role || data.role === "EMPLOYEE"),
      "Only Super Admin can assign elevated roles",
      403,
    );
    if (data.businessAccess?.length)
      requireBusinesses(req.user, data.businessAccess);
    if (data.permissions)
      assert(
        data.permissions.every(
          (p) =>
            can(req.user, p) &&
            p !== P.registrationKey.manage &&
            p !== P.analytics.viewGlobal,
        ),
        "Cannot delegate elevated or unheld permissions",
        403,
      );
  }
  if (existing?.role === "SUPER_ADMIN") {
    assert(
      data.permissions === undefined && data.businessAccess === undefined,
      "Super Admin access cannot be modified",
      403,
    );
    assert(
      (!data.role || data.role === "SUPER_ADMIN") &&
        (!data.status || data.status === "ACTIVE"),
      "Super Admin cannot be disabled or demoted",
      403,
    );
  }
}
r.post("/users", requirePermission(P.users.create), async (req, res) => {
  const identity = identityInput.parse(req.body),
    access = accessSchema.parse(req.body);
  validateAccess(req, access);
  const user = await transaction(async (session) => {
    const [u] = await User.create(
      [
        {
          name: identity.name,
          email: identity.email,
          passwordHash: await bcrypt.hash(identity.password, 12),
          ...access,
          createdBy: req.actor,
        },
      ],
      { session },
    );
    await audit(
      req.actor,
      "USER_CREATED",
      "User",
      u._id,
      undefined,
      {},
      session,
    );
    return u;
  });
  res.status(201).json(await User.findById(user._id));
});
r.patch("/users/:id", async (req, res) => {
  const access = accessSchema.parse(req.body);
  const profile = z
    .object({
      name: z.string().trim().min(2).max(150).optional(),
      email: z
        .string()
        .trim()
        .email()
        .transform((s) => s.toLowerCase())
        .optional(),
      password: z.string().min(12).max(72).optional(),
    })
    .parse(req.body);
  if (
    Object.values(profile).some((v) => v !== undefined) ||
    access.role !== undefined
  )
    assert(can(req.user, P.users.update), "User update denied", 403);
  if (access.status !== undefined)
    assert(can(req.user, P.users.disable), "User status update denied", 403);
  await transaction(async (session) => {
    const user = await User.findById(objectId(req.params.id)).session(session);
    assert(user, "User not found", 404);
    manageable(req.user, user);
    validateAccess(req, access, user);
    const events = [
      ["role", "USER_ROLE_CHANGED"],
      ["permissions", "USER_PERMISSIONS_CHANGED"],
      ["businessAccess", "USER_BUSINESS_ACCESS_CHANGED"],
      [
        "status",
        access.status === "DISABLED" ? "USER_DISABLED" : "USER_UPDATED",
      ],
    ];
    for (const [key, action] of events)
      if (access[key] !== undefined)
        await audit(
          req.actor,
          action,
          "User",
          user._id,
          undefined,
          { [key]: access[key] },
          session,
        );
    const { password, ...fields } = profile;
    Object.assign(user, fields, access);
    if (password) user.passwordHash = await bcrypt.hash(password, 12);
    await user.save({ session });
    if (password || access.status === "DISABLED")
      await Session.updateMany(
        { userId: user._id, revokedAt: null },
        { revokedAt: new Date() },
        { session },
      );
    await audit(
      req.actor,
      "USER_UPDATED",
      "User",
      user._id,
      undefined,
      {},
      session,
    );
  });
  res.json(await User.findById(req.params.id));
});
async function sessionTarget(req) {
  const u = await User.findById(objectId(req.params.id));
  assert(u, "User not found", 404);
  manageable(req.user, u);
  return u;
}
r.get(
  "/users/:id/sessions",
  requirePermission(P["users.sessions"].view),
  async (req, res) => {
    await sessionTarget(req);
    res.json(
      await Session.find({
        userId: req.params.id,
        revokedAt: null,
        expiresAt: { $gt: new Date() },
      }),
    );
  },
);
r.delete(
  "/users/:id/sessions{/:sessionId}",
  requirePermission(P["users.sessions"].revoke),
  async (req, res) => {
    await sessionTarget(req);
    const f = { userId: req.params.id };
    if (req.params.sessionId) f._id = objectId(req.params.sessionId);
    await Session.updateMany(f, { revokedAt: new Date() });
    await audit(req.actor, "SESSION_REVOKED", "User", req.params.id);
    res.status(204).end();
  },
);
r.get("/settings/registration", superOnly, async (_req, res) =>
  res.json(
    (await RegistrationSetting.findById("registration")) || {
      registrationEnabled: false,
    },
  ),
);
r.patch("/settings/registration", superOnly, async (req, res) => {
  const d = z
    .object({
      registrationEnabled: z.boolean().optional(),
      registrationKey: z.string().min(16).max(72).optional(),
      registrationKeyExpiresAt: z.iso.datetime().nullable().optional(),
    })
    .parse(req.body);
  await transaction(async (session) => {
    const s =
      (await RegistrationSetting.findById("registration")
        .select("+registrationKeyHash")
        .session(session)) || new RegistrationSetting();
    if (d.registrationKey) {
      s.registrationKeyHash = await bcrypt.hash(d.registrationKey, 12);
      s.registrationKeyUpdatedAt = new Date();
      s.registrationKeyUpdatedBy = req.actor;
      await audit(
        req.actor,
        "REGISTRATION_KEY_CHANGED",
        "RegistrationSetting",
        "registration",
        undefined,
        {},
        session,
      );
    }
    if (d.registrationKeyExpiresAt !== undefined)
      s.registrationKeyExpiresAt = d.registrationKeyExpiresAt;
    if (d.registrationEnabled !== undefined) {
      s.registrationEnabled = d.registrationEnabled;
      await audit(
        req.actor,
        d.registrationEnabled
          ? "REGISTRATION_ENABLED"
          : "REGISTRATION_DISABLED",
        "RegistrationSetting",
        "registration",
        undefined,
        {},
        session,
      );
    }
    assert(
      !s.registrationEnabled || s.registrationKeyHash,
      "Set a registration key first",
    );
    await s.save({ session });
  });
  res.json(await RegistrationSetting.findById("registration"));
});
r.get("/audit", requirePermission(P.audit.view), async (req, res) => {
  const p = pagination(req.query),
    f = {};
  if (req.user.role !== "SUPER_ADMIN")
    f.$or = [
      { business: { $in: req.user.businessAccess } },
      { business: null },
      { business: { $exists: false } },
    ];
  if (req.query.action) f.action = String(req.query.action);
  const [items, total] = await Promise.all([
    AuditLog.find(f).sort({ createdAt: -1 }).skip(p.skip).limit(p.limit),
    AuditLog.countDocuments(f),
  ]);
  res.json({ items, total, page: p.page, limit: p.limit });
});
