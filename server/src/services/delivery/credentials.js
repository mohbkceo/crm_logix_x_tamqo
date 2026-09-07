import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { assert } from "../../errors.js";
function key() {
  const value = process.env.DELIVERY_CREDENTIALS_ENCRYPTION_KEY || "";
  assert(
    /^[a-f0-9]{64}$/i.test(value),
    "Configure a 32-byte hexadecimal delivery encryption key",
    503,
  );
  return Buffer.from(value, "hex");
}
export function encryptCredentials(value) {
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
  ]);
  return [iv, cipher.getAuthTag(), data]
    .map((v) => v.toString("base64"))
    .join(".");
}
export function decryptCredentials(value) {
  const [iv, tag, data] = value.split(".").map((v) => Buffer.from(v, "base64"));
  const cipher = createDecipheriv("aes-256-gcm", key(), iv);
  cipher.setAuthTag(tag);
  return JSON.parse(
    Buffer.concat([cipher.update(data), cipher.final()]).toString("utf8"),
  );
}
