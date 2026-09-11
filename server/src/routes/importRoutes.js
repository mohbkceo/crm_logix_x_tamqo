import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { requirePermission, P } from "../authorization.js";
import { assert, AppError } from "../errors.js";
import {
  commitImport,
  importHistory,
  parseImportWorkbook,
  previewImport,
} from "../services/importService.js";

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024,
    files: 1,
    fields: 4,
    fieldSize: 500000,
  },
});
const receiveFile = (req, res, next) =>
  upload.single("file")(req, res, (error) => {
    if (error)
      return next(
        new AppError(
          error.code === "LIMIT_FILE_SIZE"
            ? "Excel files are limited to 10 MB."
            : "The Excel upload could not be read.",
          400,
        ),
      );
    next();
  });

function workbook(req) {
  assert(req.file?.buffer, "Choose an Excel file to upload.");
  return parseImportWorkbook(req.file.buffer, req.file.originalname);
}

router.get(
  "/orders/history",
  requirePermission(P.imports.view),
  async (req, res) => res.json(await importHistory(req.user, req.query.limit)),
);

router.post(
  "/orders/preview",
  requirePermission(P.imports.view),
  receiveFile,
  async (req, res) =>
    res.json(await previewImport(workbook(req), req.user, req.actor)),
);

const mappingSchema = z.object({
  selectedRows: z.array(z.number().int().positive()).max(5000),
  productMappings: z
    .record(
      z.string(),
      z
        .array(
          z.object({
            business: z.enum(["LOGIX", "TAMQO"]),
            catalogItemId: z.string().regex(/^[a-f\d]{24}$/i),
            quantity: z.number().int().min(1).max(10000),
          }),
        )
        .min(1)
        .max(50),
    )
    .default({}),
  wilayaMappings: z
    .record(z.string(), z.string().regex(/^[a-f\d]{24}$/i))
    .default({}),
});

router.post(
  "/orders/commit",
  requirePermission(P.imports.execute),
  receiveFile,
  async (req, res) => {
    let raw;
    try {
      raw = JSON.parse(req.body.options || "{}");
    } catch {
      throw new AppError("Import options are malformed.", 400);
    }
    const input = mappingSchema.parse(raw);
    res.json(await commitImport(workbook(req), req.user, req.actor, input));
  },
);

export default router;
