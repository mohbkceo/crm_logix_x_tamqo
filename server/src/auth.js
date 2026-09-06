import { Router } from "express";
import bcrypt from "bcryptjs";
import { createHash, randomBytes } from "node:crypto";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { config } from "./config.js";
import { assert } from "./errors.js";
import {
  User,
  Session,
  RegistrationSetting,
  audit,
} from "./models/security.js";
import { requirePermission, P } from "./authorization.js";
const router = Router(),
  cookie = "workspace_session";
const options = {
  httpOnly: true,
  sameSite: "strict",
  secure: config.production,
  path: "/",
  maxAge: 8 * 3600000,
};
const hash = (token) => createHash("sha256").update(token).digest("hex");
export const identityInput = z.object({
  name: z.string().trim().min(2).max(150),
  email: z
    .string()
    .trim()
    .email()
    .transform((s) => s.toLowerCase()),
  password: z.string().min(12).max(72),
});
export async function authenticated(req) {
  const token = req.cookies[cookie];
  if (typeof token !== "string" || token.length !== 64) return null;
  const session = await Session.findOne({
    tokenHash: hash(token),
    revokedAt: null,
    expiresAt: { $gt: new Date() },
  });
  if (!session) return null;
  const user = await User.findOne({ _id: session.userId, status: "ACTIVE" });
  if (!user) return null;
  req.session = session;
  await Session.updateOne(
    { _id: session._id },
    { $set: { lastSeenAt: new Date() } },
  );
  return user;
}
export async function requireAuth(req, _res, next) {
  req.user = await authenticated(req);
  assert(req.user, "Please sign in.", 401, "UNAUTHENTICATED");
  req.actor = { userId: req.user._id, name: req.user.name };
  next();
}
async function signIn(user, req, res) {
  const token = randomBytes(32).toString("hex");
  await Session.create({
    userId: user._id,
    tokenHash: hash(token),
    ip: req.ip,
    userAgent: String(req.headers["user-agent"] || "").slice(0, 500),
    lastSeenAt: new Date(),
    expiresAt: new Date(Date.now() + options.maxAge),
  });
  await User.updateOne(
    { _id: user._id },
    { $set: { lastLoginAt: new Date() } },
  );
  res
    .cookie(cookie, token, options)
    .json({ user: await User.findById(user._id) });
}
router.get("/session", async (req, res) =>
  res.json({ user: await authenticated(req) }),
);
router.get("/me", requireAuth, (req, res) => res.json({ user: req.user }));
const limit = rateLimit({
  windowMs: 15 * 60000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
});
router.post("/login", limit, async (req, res) => {
  const email = String(req.body.email || "")
    .trim()
    .toLowerCase();
  const user = await User.findOne({ email, status: "ACTIVE" }).select(
    "+passwordHash",
  );
  assert(
    user &&
      typeof req.body.password === "string" &&
      req.body.password.length <= 72 &&
      (await bcrypt.compare(req.body.password, user.passwordHash)),
    "Invalid email or password.",
    401,
  );
  await signIn(user, req, res);
});
router.post("/register", limit, async (req, res) => {
  const data = identityInput.parse(req.body);
  const settings = await RegistrationSetting.findById("registration").select(
    "+registrationKeyHash",
  );
  const key = req.body.registrationKey;
  assert(
    settings?.registrationEnabled &&
      settings.registrationKeyHash &&
      (!settings.registrationKeyExpiresAt ||
        settings.registrationKeyExpiresAt > new Date()) &&
      typeof key === "string" &&
      key.length <= 72 &&
      (await bcrypt.compare(key, settings.registrationKeyHash)),
    "Registration is unavailable or the registration key is invalid.",
    403,
  );
  const user = await User.create({
    name: data.name,
    email: data.email,
    passwordHash: await bcrypt.hash(data.password, 12),
    role: "EMPLOYEE",
    businessAccess: [],
    permissions: [],
  });
  await audit(
    { userId: user._id, name: user.name },
    "USER_CREATED",
    "User",
    user._id,
  );
  await signIn(user, req, res);
});
router.post("/logout", requireAuth, async (req, res) => {
  await Session.updateOne(
    { _id: req.session._id },
    { $set: { revokedAt: new Date() } },
  );
  await audit(req.actor, "SESSION_REVOKED", "Session", req.session._id);
  res
    .clearCookie(cookie, { ...options, maxAge: undefined })
    .status(204)
    .end();
});
router.get(
  "/sessions",
  requireAuth,
  requirePermission(P.sessions.viewOwn),
  async (req, res) =>
    res.json(
      await Session.find({
        userId: req.user._id,
        revokedAt: null,
        expiresAt: { $gt: new Date() },
      })
        .select("-tokenHash")
        .lean(),
    ),
);
router.delete(
  "/sessions/:id",
  requireAuth,
  requirePermission(P.sessions.revokeOwn),
  async (req, res) => {
    const s = await Session.findOneAndUpdate(
      { _id: req.params.id, userId: req.user._id },
      { revokedAt: new Date() },
    );
    assert(s, "Session not found", 404);
    await audit(req.actor, "SESSION_REVOKED", "Session", s._id);
    res.status(204).end();
  },
);
export default router;
