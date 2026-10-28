# Tracking module

## Quick filters and operational defaults

The Tracking view applies shared defaults on entry and when navigating back. Security Admin/Super Admin sees every authorized order. Designer starts at Preparing and Production/Production Manager at At Production, oldest first, with courier-owned/completed work excluded from the internal-attention queue. `tracking.viewAll` does not override an employee's operational default. For multiple operational roles, Designer takes precedence, then Production/Manager, then Sales. These are convenience defaults; the original authorization scope always applies.

Sales starts with active orders and Issues first sorting. All unresolved reports precede orders without reports; within the unresolved group, reports whose saved responsible team is Sales / Confirmation come first. Each priority group sorts by createdAt ascending and ID ascending. Other active orders remain visible. Active excludes Delivered, Returned and Cancelled; Order lifecycle exposes completed/cancelled history. Clear Filters shows the full authorized queue; Reset to My Default View reapplies the employee's defaults.

Quick tags are evaluated by the backend before pagination. Categories combine with AND; selected tags within a category combine with OR:

- Priority: Important.
- Age: New (last 24 hours), < 4 Days, ≥ 4 Days. Exactly four days belongs to ≥ 4 Days. Future timestamps do not match New or < 4 Days.
- Reports: Issues, Blocked, No Issues (and the existing Issue status dropdown).
- Assignment: My Orders matches designer/production assignments, not order creation.
- Calendar: Today uses the existing Africa/Algiers day boundary.

Search, production stage, courier status, employee, business, date range and sorting continue to compose with tags. Filters survive pagination and changing any filter returns to page 1 and clears bulk selection. Faceted chip counts apply all other filter categories and the chip itself, replacing other selections in its own category. Counts never include orders outside the user's scope. The mobile chip strip scrolls horizontally within the page.

`Order.tracking.important` stores the optional priority flag plus the actor/time of its latest change. `PATCH /api/tracking/:orderId/important` accepts `{ important, expectedRevision }`, uses the existing `tracking.assign` permission, enforces scope/revision checks, and records `TRACKING_PRIORITY_CHANGED`. It changes neither stage nor courier/commercial data. Existing order records need no reset or priority migration; a missing flag means unmarked.

List requests support `tags` (comma-separated normalized tag values), `lifecycle=ALL|ACTIVE|COMPLETED`, `attention=all|internal`, and `sort=oldest|newest|issuesFirst`. Omitting `view` applies role defaults; `view=custom` requests explicit filters. These options change only query convenience, never authorization.

Quick-filter validation on 2026-10-28: lint and production build passed; all 137 automated tests passed (including 35 Tracking tests). The expanded Tracking browser suite passed role defaults, AND/OR tags, clearing/resetting, navigating back to defaults, permission-controlled Important actions, mobile layout and the existing reports/bulk workflow, with no console/API errors or courier requests. Desktop and mobile screenshots were inspected.

Tracking is part of the existing CRM. `/tracking` uses the original `Order` documents and the existing authenticated session, business scoping, permission catalogue and transaction infrastructure. There is no second order store, browser persistence, batch/cutting workflow or new courier endpoint.

## Persistence and concurrency

- `Order.tracking` contains the internal stage (`PREPARING`, `AT_PRODUCTION`, `READY_TO_SHIP`, or `LEGACY_UNINITIALIZED`), observed stage-entry time, employee assignments, report counters and a sticky courier-ownership flag. `Order.status` remains the existing commercial/delivery state machine.
- `TrackingEvent` records order ID, previous/new stage, actor, timestamp, source and order revision. The `(orderId, revision)` index is unique. Assignments, reports and resolutions are audited in the same transaction as their Order write.
- `TrackingIssue` stores normalized severity (`INFO`, `WARNING`, `CRITICAL`), optional description, immutable type attributes at creation, reporter identity and team snapshots from the authenticated user, and resolution identity/time. A unique `(orderId, requestId)` prevents report retries from creating duplicates. Resolved reports are retained.
- `TrackingIssueType` stores label, description, default severity, blocking rule, responsible team, visual indicator, enabled state and display order. Disabling a type does not affect historical snapshots. Other is seeded and cannot be disabled through the API. At most 100 active options are supported.
- `TrackingSetting` stores the WhatsApp requirement, fallback operational contact, and enabled/display labels for the four operational roles. Disabling a role removes it from new assignments; it does not silently revoke existing employee permissions.
- `User.operationalRoles`, `requestedOperationalRole` and private `whatsappPhone` extend existing user records. Phone values are excluded from normal Mongoose selections. Only the authenticated user's profile, or authorized contact responses, expose them.
- `Order.images` stores references and metadata; original upload bytes are never stored in MongoDB. Item `specifications` are optional, independent of pricing.

Every Tracking order mutation requires `expectedRevision` matching `Order.revision`, reads business/queue access again inside a transaction, writes the original Order and audit records together, and increments the order revision. This shared write serializes production transitions, blocking reports, commercial transitions and courier takeover. Stale requests receive HTTP 409; the interface refreshes rather than replaying a toggle. Bulk requests contain explicit per-order targets/revisions, are limited to 100 orders, and return individual results. Each order commits or rolls back independently.

## Roles and access

Security roles remain `SUPER_ADMIN`, `ADMIN`, `EMPLOYEE`. Operational roles do not grant permissions automatically. Admins assign them separately in Users; an Admin cannot grant permissions or business access they do not hold, and only Super Admin can assign elevated security roles. Self-registration preserves registration-key checks and creates an employee with no assigned operational roles, permissions or business access. The requested operational role is only a request.

Added permissions:

`tracking.view`, `tracking.viewAll`, `tracking.moveToProduction`, `tracking.moveToPreparing`, `tracking.markReady`, `tracking.revertReady`, `tracking.bulkUpdate`, `tracking.assign`, `tracking.issue.create`, `tracking.issue.resolve`, `tracking.issue.view`, `tracking.issueTypes.manage`, `tracking.settings.manage`, `tracking.contacts.view`.

Suggested explicit grants (not automatically applied):

| Team | Tracking actions |
| --- | --- |
| Sales / Confirmation | View own orders, report, view reports; use existing Orders create/view/update permissions as appropriate |
| Designer | View, move to production, move to preparing, report/view reports, authorized contacts |
| Production | View, mark ready, revert ready, bulk update, report/view/resolve reports |
| Production Manager | Production and Designer transitions as granted, assignments, optional viewAll |
| Admin | Individually granted queues, assignments, audit, issue-type/settings administration |

Employees must have both the relevant permission and an appropriate operational role for a transition. Admin/Super Admin retain their security hierarchy; Admin still requires the explicit action permission. Without `tracking.viewAll`, the API includes the employee's own/assigned orders and unassigned queues matching their operational role. All results must be physical Logix orders and satisfy all underlying business access: Partnership requires both Logix and Tamqo access. Tamqo-only orders never enter the queue.

Critical reports always block production. Other severities use the issue type's explicit blocking rule, so a Warning can be informational or blocking as configured. A report can be created/resolved after courier takeover. Resolution takes one action and records who/when without a resolution form. Reporting never changes commercial status, Shipment fields, tracking, payments, return expenses or refunds and never calls a courier service.

## Courier authority

The existing verified provider mapper, Procolis client, financial effects and synchronization services remain in use. No status codes or endpoints were invented.

Shipment creation or provider `PREPARING` alone does **not** transfer ownership. Verified courier `READY_TO_SHIP` or a later shipping/terminal state transfers ownership. Existing commercial `READY_TO_SHIP`, `SHIPPED`, `OUT_FOR_DELIVERY`, `FAILED_DELIVERY`, `RETURNING`, `RETURNED`, `DELIVERED`, and `CANCELLED` also lock internal transitions. Ownership is sticky; production cannot restart automatically when shipment diagnostics change. Active courier reservations and uncertain creation also temporarily block production changes.

Courier synchronization remains authoritative for commercial status. Older/invalid provider timestamps, equal-timestamp contradictory states, mismatched tracking numbers and forbidden terminal regressions preserve accepted state and record an error plus `Shipment.lastObservation`. Unknown provider values remain visible in existing diagnostic fields without guessing a commercial state. Duplicate accepted observations do not create duplicate status events or financial effects. Existing verified return-recovery transitions remain supported. Without a provider timestamp, the existing validated lifecycle rules apply; chronology cannot be invented.

The existing Orders courier-readiness action remains a separate permission-controlled operation. Internal Ready to Ship never calls `/pret`. Manual agencies continue using their configured capabilities. ABEX portal links require the persisted shipment's agency code to be `ABEX` and its actual tracking number; other agencies show an explicit unavailable link because this repository has no verified tracking URL configuration for them.

## Migration and rollout

`migrateTracking()` is called by the existing `migrate()` (and therefore startup). It is safe to repeat:

1. Seed Other and default settings with `$setOnInsert`.
2. Set a neutral `LEGACY_UNINITIALIZED` subdocument only on eligible, undeleted physical orders missing Tracking.
3. Leave order timestamps, commercial states, finances, original notes, shipment IDs/statuses and historical assignments untouched.

All historical internal stages are treated as uncertain. No stage-entry/completion date or employee is fabricated. For orders still eligible, an Admin or authorized Production Manager with `tracking.assign` can explicitly start the workflow from the row's More menu; this records the real initialization time. Courier-controlled history stays read-only. No migration was run against the user's production database during implementation or tests.

Existing employees may still sign in when WhatsApp becomes required. The profile notice and My profile page allow completion; backend registration/profile validation enforces the configured rule. Algerian mobile formats normalize to `+213…`; international E.164 numbers are supported. WhatsApp links open a conversation only; no messages are sent automatically. Missing/disabled contacts have an explicit explanation. Responsible contact comes from the stage's assigned employee, or the configured fallback with suitable business access; courier-owned orders use the fallback rather than claiming an internal production assignee controls delivery.

## Images and deployment

No media credentials are required. The storage adapter defaults to `server/storage/order-images`; set `MEDIA_STORAGE_DIR` to durable storage in production and share that volume across API replicas. Back up that directory with MongoDB. Uploads are authenticated, limited to six images per order and 5 MB per file, decoded with Sharp (maximum 25 megapixels), checked against JPEG/PNG/WebP MIME, stripped of original metadata and re-encoded as WebP up to 1600px. Server-generated filenames and validated references prevent path traversal. Image responses recheck Order/business access and use private, no-store caching.

Order creation commits before optional image uploads. Upload failures leave the order intact and display a warning with a retry route through Edit order. MongoDB transactions require a replica set, as the existing CRM already does. No new external service configuration blocks startup.

## API

All `/api/tracking` endpoints require an authenticated session. Relevant additional permissions and business/role checks are enforced in the service:

- `GET /api/tracking` — bounded backend pagination; stable createdAt/ID sorting; search, internal stage, courier status, issue, employee, date and business filters.
- `GET /api/tracking/:orderId` — operational view and server-computed available transitions.
- `PATCH /api/tracking/:orderId/stage`, `POST /api/tracking/bulk-stage` — explicit targets with expected revisions.
- `POST /api/tracking/:orderId/initialize`, `PATCH /api/tracking/:orderId/assign` — authorized historical initialization and assignments.
- `GET|POST /api/tracking/:orderId/issues`, `POST /api/tracking/:orderId/issues/:issueId/resolve` — reports/resolution.
- `GET /api/tracking/:orderId/history` — paginated tracking audit, requires `audit.view`.
- `GET|POST /api/tracking/issue-types`, `PATCH /api/tracking/issue-types/:typeId` — enabled options and administrative maintenance; edits require the current `__v` as `expectedRevision`.
- `GET|PATCH /api/tracking/settings`, `GET /api/tracking/employees` — protected configuration and bounded employee choices.
- `POST /api/order-media/:orderId`, `GET /api/order-media/:orderId/:imageId` — optional authenticated images.
- `GET /api/auth/profile-policy`, `PATCH /api/auth/profile` — public non-sensitive registration requirements and authenticated self-profile completion.

## Verification and file inventory

New backend files: `models/tracking.js`, `domain/whatsapp.js`, `services/trackingService.js`, `services/trackingMigration.js`, `services/profileService.js`, `services/mediaStorage.js`, `routes/trackingRoutes.js`, `routes/mediaRoutes.js`.

New frontend/shared files: `client/src/pages/Tracking.jsx`, `client/src/pages/TrackingSettings.jsx`, `shared/tracking.js`.

Integrated files: `client/src/main.jsx`, `access.jsx`, `api.js`, `styles.css`, `pages/Orders.jsx`, `pages/Administration.jsx`, `pages/Settings.jsx`; `server/src/app.js`, `auth.js`, `migrate.js`, `models/index.js`, `models/security.js`, `domain/order.js`, `routes/securityRoutes.js`, `services/orderService.js`, `services/delivery/deliverySyncService.js`; `shared/permissions.js`, package manifests/lock and `.gitignore`.

Validation also corrected an existing `pages/ImportData.jsx` bug: rows awaiting mappings were incorrectly unselectable even though the existing browser regression requires selecting them before resolution. Delivered, duplicate and invalid rows remain unselectable. `scripts/delivery-browser-check.js` now supplies the verified `Colis`/`MessageRetour: Good` response and checks the existing shipment status labels; production provider parsing was not loosened to accommodate the fixture. New Tracking CSS uses a distinct row class to preserve the Orders courier card.

Tests: `server/test/tracking.test.js`, `scripts/tracking-browser-check.js`. Existing tests are retained. `npm test` uses isolated MongoDB memory replica sets. `npm run test:tracking-browser` uses a separate disposable database, manual delivery fixture and temporary image directory; it checks real desktop/mobile UI, sales creation with an image, role visibility, Designer toggles, Production single/bulk actions, reports/resolution, settings/profile and zero accidental courier requests. Screenshots go to ignored `.local/qa/tracking/`.

Run `npm run lint`, `npm test`, `npm run build`, `npm run test:browser`, `npm run test:delivery-browser`, and `npm run test:tracking-browser`. The existing browser suite validates legacy navigation, orders and financial screens; the delivery browser suite validates existing integration controls.

Final validation on 2026-10-27:

| Check | Actual result |
| --- | --- |
| `npm run lint` | Passed |
| `npm test` | 130 passed, 0 failed, 0 skipped (102 existing + 28 Tracking tests) |
| `npm run build` | Passed |
| `npm run test:browser` | Passed, including existing orders/fulfillment/collection/analytics/import/navigation/mobile flows |
| `npm run test:delivery-browser` | Passed, including success/pending/error/manual delivery flows |
| `npm run test:tracking-browser` | Passed; desktop and 390px mobile screenshots inspected, no console/API errors or accidental courier requests |
| `npm audit --omit=dev` | 0 vulnerabilities after compatible dependency updates |
| `git diff --check` | Passed |
