// Shape observed in the authenticated ABEX delivery portal on 2026-11-22.
// All identifiers and customer values are generated/redacted test data.
// Evidence and source delivery links: docs/abex-webhooks.md.
export function abexParcelNotification(overrides = {}) {
  return {
    eventType: "parcel.state.updated",
    occurredAt: "2026-11-22T09:04:01.65018+00:00",
    ...overrides,
    data:
      overrides.data === null
        ? null
        : {
            id: "f0000000-0000-4000-8000-000000000001",
            trackingNumber: "FIXTURE-TRACKING",
            customer: { name: "REDACTED", phone: { number1: "REDACTED" } },
            supplier: { supplierName: "REDACTED" },
            deliveryAddress: { street: "REDACTED", city: "REDACTED" },
            state: {
              id: "f0000000-0000-4000-8000-000000000003",
              name: "fixture-state",
            },
            lastStateUpdateAt: "2026-11-22T09:03:57.700407Z",
            externalId: "FIXTURE-ORDER",
            isReturn: false,
            ...overrides.data,
          },
  };
}
