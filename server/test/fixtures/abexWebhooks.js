// Shape observed in the authenticated ABEX delivery portal on 2026-11-22.
// All identifiers and customer values are generated/redacted test data.
// Evidence and source delivery links: docs/abex-webhooks.md.
// The two situation identifiers are independently generated, as observed in
// the provider portal. These fields also match GetSupplierParcelResponse.
export function abexSituationObservation() {
  return {
    lastStateSituationId: "f0000000-0000-4000-8000-000000000042",
    situation: {
      id: "f0000000-0000-4000-8000-000000000043",
      name: "Fixture postponed",
      description: "Fixture postponed",
      slug: "fixture-postponed",
      metadata: { scheduledDate: "2026-01-04T12:00:00+00:00" },
    },
    lastSituationUpdateAt: "2026-01-03T00:00:00.1234567Z",
  };
}

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
