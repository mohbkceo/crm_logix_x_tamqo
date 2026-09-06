import { Order, Shipment, OrderEvent } from "../../models/index.js";
import { DeliveryAgency } from "../../models/delivery.js";
import { audit } from "../../models/security.js";
import { providerFor } from "./deliveryProviderFactory.js";
import { DeliverySyncService } from "./deliverySyncService.js";
import { transaction, transition } from "../orderService.js";
import { assert } from "../../errors.js";
async function context(id, capability, creating = false) {
  const order = await Order.findById(id);
  assert(order, "Order not found", 404);
  const agency = await DeliveryAgency.findById(order.delivery.agencyId);
  assert(agency, "Order delivery agency is missing. Run the migration.", 409);
  if (creating) {
    assert(agency.active, "Agency is disabled", 409);
    assert(
      order.items.every((i) => agency.businesses.includes(i.business)),
      "Agency does not serve this order",
      409,
    );
  }
  assert(
    agency.capabilities?.[capability],
    `Agency does not support ${capability}`,
    409,
  );
  return {
    order,
    agency,
    service:
      agency.integrationType === "API"
        ? new DeliverySyncService(await providerFor(agency._id, capability))
        : null,
  };
}
async function event(id, actor, message) {
  await OrderEvent.create({
    orderId: id,
    kind: "SHIPMENT",
    type: "SHIPMENT_UPDATED",
    actor,
    source: "INTERNAL",
    message,
  });
  await audit(actor, "ORDER_SHIPMENT_UPDATED", "Order", id);
}
export const deliveryService = {
  async create(id, actor, input = {}) {
    const { order, agency, service } = await context(
      id,
      "createShipment",
      true,
    );
    let result;
    if (service) result = await service.create(id, { actor });
    else
      result = await transaction(async (session) => {
        const o = await Order.findById(id).session(session);
        assert(
          ["CONFIRMED", "PREPARING", "READY_TO_SHIP"].includes(o.status),
          "Confirm the order first",
          409,
        );
        let shipment = await Shipment.findOne({ orderId: id }).session(session);
        if (shipment) return shipment;
        const tracking =
          typeof input.tracking === "string" ? input.tracking.trim() : "";
        assert(tracking.length <= 150, "Tracking is too long");
        [shipment] = await Shipment.create(
          [
            {
              orderId: id,
              agencyId: agency._id,
              agencyName: agency.name,
              provider: "MANUAL",
              externalId: order.orderNumber,
              ...(tracking ? { tracking } : {}),
              status: o.status,
              syncStatus: "SYNCED",
              lastSyncedAt: new Date(),
            },
          ],
          { session },
        );
        o.revision++;
        o.lastUpdatedBy = actor;
        await o.save({ session });
        return shipment;
      });
    await event(id, actor, "Shipment created or linked");
    return result;
  },
  async ready(id, actor) {
    const { service } = await context(id, "readyToShip");
    const result = service
      ? await service.ready(id, actor)
      : await transition(id, "READY_TO_SHIP", actor);
    await event(id, actor, "Marked ready");
    return result;
  },
  async refresh(id, actor) {
    const { service } = await context(id, "tracking");
    const result = service
      ? await service.refresh(id)
      : await Shipment.findOne({ orderId: id });
    assert(result, "No shipment exists", 404);
    if (actor) await event(id, actor, "Tracking refreshed");
    return result;
  },
  async reconcile(id, tracking, absent, actor) {
    const { service, order } = await context(id, "tracking");
    if (service) return service.reconcile(id, tracking, absent, actor);
    assert(
      typeof tracking === "string" &&
        tracking.trim().length > 0 &&
        tracking.length <= 150,
      "Enter a tracking number",
    );
    const result = await Shipment.findOneAndUpdate(
      { orderId: id },
      {
        tracking: tracking.trim(),
        status: order.status,
        lastSyncedAt: new Date(),
      },
      { new: true },
    );
    assert(result, "Create a shipment first", 409);
    await event(id, actor, "Manual tracking updated");
    return result;
  },
  async syncBatch() {
    let synced = 0,
      errors = 0;
    const shipments = await Shipment.find({
      status: { $nin: ["DELIVERED", "RETURNED", "CANCELLED"] },
      tracking: { $type: "string" },
    })
      .sort({ lastSyncedAt: 1 })
      .limit(100);
    for (const s of shipments) {
      try {
        const agency = await DeliveryAgency.findById(s.agencyId);
        if (agency?.integrationType !== "API" || !agency.capabilities?.tracking)
          continue;
        await this.refresh(s.orderId);
        synced++;
      } catch {
        errors++;
      }
    }
    return { synced, errors };
  },
};
