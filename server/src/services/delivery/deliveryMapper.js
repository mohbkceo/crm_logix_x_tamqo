export function mapOrderToPackage(
  order,
  { tracking = "", confirmed = false } = {},
) {
  return {
    Package: [
      {
        Tracking: tracking,
        DeliveryType: order.delivery.type === "HOME" ? "0" : "1",
        TypeColis: order.delivery.exchange ? "1" : "0",
        Confirmed: confirmed ? "1" : "",
        Client: order.customer.name,
        MobileA: order.customer.phoneA,
        MobileB: order.customer.phoneB || "",
        Address: order.location.address,
        IDWilaya: String(order.location.agencyId),
        Commune: order.location.commune,
        Total: String(order.payment.amountToCollect),
        Note: order.note || "",
        Product: order.items.map((i) => `${i.name} × ${i.quantity}`).join(", "),
        id_Externe: order.orderNumber,
        Source: order.source.name,
      },
    ],
  };
}
export function sanitizeProviderData(value, depth = 0) {
  if (depth > 10) return "[truncated]";
  if (typeof value === "string") {
    let s = value.slice(0, 5000);
    for (const secret of [
      process.env.DELIVERY_API_TOKEN,
      process.env.DELIVERY_API_KEY,
    ])
      if (secret) s = s.split(secret).join("[redacted]");
    return s;
  }
  if (Array.isArray(value))
    return value.slice(0, 200).map((x) => sanitizeProviderData(x, depth + 1));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([k]) => !/token|key|authorization|cookie|secret|password/i.test(k),
        )
        .slice(0, 100)
        .map(([k, v]) => [k, sanitizeProviderData(v, depth + 1)]),
    );
  return value;
}
export function readPath(value, path) {
  return String(path)
    .split(".")
    .reduce((v, k) => (v && Object.hasOwn(v, k) ? v[k] : undefined), value);
}
export function parsePackages(raw) {
  // These field paths are configurable conventions, NOT a verified response contract.
  const data = readPath(
    raw,
    process.env.DELIVERY_RESPONSE_PACKAGES_PATH || "Package",
  );
  if (!Array.isArray(data)) return [];
  return data
    .filter((v) => v && typeof v === "object")
    .map((v) => ({
      tracking: readPath(
        v,
        process.env.DELIVERY_RESPONSE_TRACKING_FIELD || "Tracking",
      ),
      providerStatus: readPath(
        v,
        process.env.DELIVERY_RESPONSE_STATUS_FIELD || "Status",
      ),
      raw: sanitizeProviderData(v),
    }))
    .filter((v) => typeof v.tracking === "string" && v.tracking.trim())
    .map((v) => ({
      ...v,
      tracking: v.tracking.trim(),
      providerStatus:
        v.providerStatus == null ? null : String(v.providerStatus),
    }));
}
