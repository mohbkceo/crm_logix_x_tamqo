import { MongoMemoryReplSet } from "mongodb-memory-server";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import mongoose from "mongoose";
import net from "node:net";
const port = process.env.PORT || 4000,
  webPort = process.env.WEB_PORT || 5173,
  mongoPort = Number(process.env.LOCAL_MONGO_PORT || 27038);
async function checkPort(port) {
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", () =>
      reject(
        new Error(
          `Port ${port} is in use. Set PORT, WEB_PORT or LOCAL_MONGO_PORT to an unused port.`,
        ),
      ),
    );
    server.listen(Number(port), "127.0.0.1", () => server.close(resolve));
  });
}
await checkPort(port);
await checkPort(webPort);
await checkPort(mongoPort);
const dbPath = path.resolve(".local/mongodb-rs");
await mkdir(dbPath, { recursive: true });
const replica = await MongoMemoryReplSet.create({
  instanceOpts: [{ dbPath, port: mongoPort }],
  replSet: { count: 1, storageEngine: "wiredTiger", name: "rs0" },
});
const uri = replica.getUri("tamqo_logix");
process.env.MONGODB_URI = uri;
const { seed } = await import("../server/src/seed.js");
await mongoose.connect(uri);
await seed();
await mongoose.disconnect();
const env = {
  ...process.env,
  MONGODB_URI: uri,
  PORT: port,
  WEB_PORT: webPort,
  CLIENT_URL: `http://127.0.0.1:${webPort}`,
  NODE_ENV: "development",
  BOOTSTRAP_SUPER_ADMIN_NAME:
    process.env.BOOTSTRAP_SUPER_ADMIN_NAME || "Local Super Admin",
  BOOTSTRAP_SUPER_ADMIN_EMAIL:
    process.env.BOOTSTRAP_SUPER_ADMIN_EMAIL || "admin@local.test",
  BOOTSTRAP_SUPER_ADMIN_PASSWORD:
    process.env.BOOTSTRAP_SUPER_ADMIN_PASSWORD || "local-development-password",
  DELIVERY_CREDENTIALS_ENCRYPTION_KEY:
    process.env.DELIVERY_CREDENTIALS_ENCRYPTION_KEY ||
    "57c3a21111453617ce8722f21eace6fa3e3c64bf066265c9c1267927f37c5ff2",
};
console.log(
  `Local Super Admin: ${env.BOOTSTRAP_SUPER_ADMIN_EMAIL}. The default password is documented in README.md; environment overrides are never printed.`,
);
const processes = [
  spawn(process.execPath, ["server/src/index.js"], { env, stdio: "inherit" }),
  spawn(
    process.execPath,
    [path.resolve("node_modules/vite/bin/vite.js"), "--host", "127.0.0.1"],
    { cwd: path.resolve("client"), env, stdio: "inherit" },
  ),
];
// Vite is hoisted to the workspace root; resolve its binary explicitly.
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  for (const child of processes) child.kill();
  await replica.stop({ doCleanup: false });
  process.exit(0);
}
for (const event of ["SIGINT", "SIGTERM"]) process.on(event, stop);
for (const child of processes)
  child.on("exit", () => {
    if (!stopping) stop();
  });
