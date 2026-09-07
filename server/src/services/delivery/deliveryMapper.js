export function mapOrderToPackage(order, { confirmed = false } = {}) {
  return {
    Colis: [
      {
        Tracking: String(order.orderNumber),
        TypeLivraison: order.delivery.type === "HOME" ? "0" : "1",
        TypeColis: order.delivery.exchange ? "1" : "0",
        Confrimee: confirmed ? "1" : "0",
        Client: order.customer.name,
        MobileA: order.customer.phoneA,
        MobileB: order.customer.phoneB || "",
        Adresse: order.location.address,
        IDWilaya: String(order.location.agencyId),
        Commune: order.location.commune,
        Total: String(order.payment.amountToCollect),
        Note: order.note || "",
        TProduit: order.items
          .map((i) => `${i.name} × ${i.quantity}`)
          .join(", "),
        id_Externe: String(order.orderNumber),
        Source: order.source?.name || "",
      },
    ],
  };
}
export function sanitizeProviderData(value, depth = 0, secrets = []) {
  if (depth > 10) return "[truncated]";
  if (typeof value === "string") {
    let s = value;
    for (const secret of [
      process.env.DELIVERY_API_TOKEN,
      process.env.DELIVERY_API_KEY,
      ...secrets,
    ])
      if (secret) s = s.split(secret).join("[redacted]");
    return s
      .replace(
        /(?:authorization|set-cookie|cookies?)\s*[:=]\s*[^\r\n]*/gi,
        "[redacted header]",
      )
      .replace(
        /((?:token|key|authorization|cookie|secret|password)\s*[=:]\s*)(?:"[^"]*"|[^\s,;]+)/gi,
        "$1[redacted]",
      )
      .slice(0, 5000);
  }
  if (Array.isArray(value))
    return value
      .slice(0, 200)
      .map((x) => sanitizeProviderData(x, depth + 1, secrets));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([k]) => !/token|key|authorization|cookie|secret|password/i.test(k),
        )
        .slice(0, 100)
        .map(([k, v]) => [k, sanitizeProviderData(v, depth + 1, secrets)]),
    );
  return value;
}
export function extractColis(raw) {
  if (Array.isArray(raw?.Colis)) return raw.Colis;
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object" && raw.Tracking) return [raw];
  return [];
}
function validTracking(value) {
  return (
    typeof value === "string" &&
    value.trim() &&
    value.length <= 150 &&
    ![...value].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
  );
}
export function parsePackages(raw) {
  return extractColis(raw)
    .filter(
      (v) =>
        v &&
        validTracking(v.Tracking) &&
        (!v.MessageRetour || v.MessageRetour === "Good"),
    )
    .map((v) => ({
      tracking: v.Tracking.trim(),
      externalId: typeof v.id_Externe === "string" ? v.id_Externe : null,
      providerStatus:
        typeof v.Statut === "string" || typeof v.Statut === "number"
          ? String(v.Statut)
          : null,
      messageRetour:
        typeof v.MessageRetour === "string" ? v.MessageRetour : null,
      raw: sanitizeProviderData(v),
    }));
}
export function parseCreationResult(raw, orderNumber) {
  const rows = extractColis(raw);
  const colis = rows.length === 1 ? rows[0] : null;
  const messageRetour =
    typeof colis?.MessageRetour === "string" ? colis.MessageRetour : null;
  const providerAccepted = messageRetour === "Good";
  const parcel =
    providerAccepted && (!colis.id_Externe || colis.id_Externe === orderNumber)
      ? parsePackages({
          Colis: [
            { ...colis, Tracking: colis.Tracking || String(orderNumber) },
          ],
        })[0] || null
      : null;
  return {
    providerAccepted,
    duplicate: messageRetour === "Double Tracking",
    messageRetour,
    trackingFound: Boolean(parcel),
    parcel,
  };
}
