import bcrypt from "bcryptjs";
import { randomBytes } from "node:crypto";
const password = process.argv[2];
if (!password || password.length < 12 || password.length > 72)
  throw new Error("Supply a password of at least 12 characters.");
console.log("ADMIN_PASSWORD_HASH=" + (await bcrypt.hash(password, 12)));
console.log("SESSION_SECRET=" + randomBytes(48).toString("hex"));
