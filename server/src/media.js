import mongoose from "mongoose";
import { config, validateConfig } from "./config.js";
import { migrateMedia } from "./services/mediaMigration.js";
import { cleanupMedia } from "./services/mediaCleanup.js";

const args = process.argv.slice(2);
if (
  args.length > 1 ||
  args.some((a) => !["--apply", "--verify", "--cleanup"].includes(a))
) {
  console.error(
    "Usage: npm run media:migrate -- [--apply | --verify | --cleanup] (default: dry-run)",
  );
  process.exit(1);
}
validateConfig();
try {
  await mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 10000 });
  await Promise.all(
    Object.values(mongoose.models).map((model) => model.init()),
  );
  const result = args.includes("--cleanup")
    ? await cleanupMedia()
    : await migrateMedia({
        apply: args.includes("--apply"),
        verify: args.includes("--verify"),
        onRecord: (record) => console.log(JSON.stringify(record)),
      });
  console.log(JSON.stringify(result));
  if (result.failed) process.exitCode = 1;
} catch {
  console.error(
    "Media maintenance failed. Check database connectivity and server-side Cloudinary configuration.",
  );
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}
