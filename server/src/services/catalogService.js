import { LogixProduct, TamqoPlan } from "../models/index.js";
import { assert } from "../errors.js";

export const catalogModelFor = (business) =>
  business === "TAMQO" ? TamqoPlan : LogixProduct;

export async function resolveCatalogItem(
  business,
  catalogItemId,
  {
    session,
    allowInactive = false,
    message = "Select an active product or plan.",
  } = {},
) {
  const query = catalogModelFor(business).findById(catalogItemId);
  if (session) query.session(session);
  const item = await query;
  assert(item && (item.active || allowInactive), message);
  return item;
}
