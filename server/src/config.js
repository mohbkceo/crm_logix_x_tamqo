import dotenv from "dotenv";
import path from "node:path";

dotenv.config({
  path: path.resolve(import.meta.dirname, "../../.env"),
  quiet: true,
});

export const config = {
  port: Number(process.env.PORT || 4000),
  mongoUri: process.env.MONGODB_URI,
  clientUrl: process.env.CLIENT_URL || "http://127.0.0.1:5173",
  production: process.env.NODE_ENV === "production",
};
export function validateConfig() {
  if (!config.mongoUri)
    throw new Error(
      "MONGODB_URI is required. Use npm run dev:local for an isolated local database.",
    );
}
