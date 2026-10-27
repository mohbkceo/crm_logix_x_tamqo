export const OPERATIONAL_ROLES = [
  "SALES_CONFIRMATION",
  "DESIGNER",
  "PRODUCTION",
  "PRODUCTION_MANAGER",
];
export const PRODUCTION_STAGES = [
  "PREPARING",
  "AT_PRODUCTION",
  "READY_TO_SHIP",
];
export const SEVERITIES = ["INFO", "WARNING", "CRITICAL"];
export const STAGE_LABELS = {
  PREPARING: "Preparing",
  AT_PRODUCTION: "At Production",
  READY_TO_SHIP: "Ready to Ship",
  LEGACY_UNINITIALIZED: "Legacy / uninitialized",
};
export const SEVERITY_LABELS = {
  INFO: "Information",
  WARNING: "Warning / Blocking",
  CRITICAL: "Critical",
};
export const COURIER_STAGES = [
  "READY_TO_SHIP",
  "SHIPPED",
  "OUT_FOR_DELIVERY",
  "FAILED_DELIVERY",
  "RETURNING",
  "RETURNED",
  "DELIVERED",
  "CANCELLED",
];
export const STAGE_ACTIONS = {
  "PREPARING:AT_PRODUCTION": {
    permission: "tracking.moveToProduction",
    roles: ["DESIGNER", "PRODUCTION_MANAGER"],
  },
  "AT_PRODUCTION:PREPARING": {
    permission: "tracking.moveToPreparing",
    roles: ["DESIGNER", "PRODUCTION_MANAGER"],
  },
  "AT_PRODUCTION:READY_TO_SHIP": {
    permission: "tracking.markReady",
    roles: ["PRODUCTION", "PRODUCTION_MANAGER"],
  },
  "READY_TO_SHIP:AT_PRODUCTION": {
    permission: "tracking.revertReady",
    roles: ["PRODUCTION", "PRODUCTION_MANAGER"],
  },
};
