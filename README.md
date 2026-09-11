# Tamqo × Logix workspace

A JavaScript MERN application for Tamqo subscriptions, Logix NFC products, and orders containing both businesses. Orders, configuration, customers, expenses, status history and shipments are stored in MongoDB. The React app displays API results; it does not generate sample sales or calculate reports locally.

## Quick local start

Use Node.js 22.12+ and npm. The application was verified on the supplied Windows environment with Node 23.5.0.

```sh
npm install
npm run dev:local
```

Open `http://127.0.0.1:5173`. This command starts a **real single-node MongoDB replica set**, seeds configurable catalogs, runs the safe data migration, starts Express on port 4000, and starts Vite. The first invocation may download a MongoDB binary. Local database files persist in `.local/mongodb-rs`; they are excluded from Git. Stop the process with Ctrl+C. A fresh local database uses `admin@local.test` with password `local-development-password`; override both with `BOOTSTRAP_SUPER_ADMIN_EMAIL` and `BOOTSTRAP_SUPER_ADMIN_PASSWORD` before the first run. Environment-provided passwords are never printed.

If a port is occupied, use different ports. In PowerShell:

```powershell
$env:PORT = '4018'
$env:WEB_PORT = '5178'
npm run dev:local
```

The preview created during implementation uses **http://127.0.0.1:5178** and API port 4018. MongoDB uses a fixed local port, 27038. `LOCAL_MONGO_PORT` can override it before the first run; keep it stable for an existing replica-set data directory. Do not use the local development launcher for production.

## Use your own MongoDB

Copy `.env.example` to `.env` at the repository root and set `MONGODB_URI`. Use MongoDB Atlas or a configured replica set. **Transactions require a replica set; a standalone MongoDB server is not sufficient.**

```sh
npm install
npm run seed
npm run migrate
npm run dev
```

The seed script is repeatable and uses insert-only catalog defaults. It does not overwrite configured prices or create fabricated customers, orders or expenses. A fresh database receives four Tamqo plans, three Logix products, Messages as the default source, exactly three sample Wilayas (Alger, Oran, Constantine), and business-specific expense categories. Prices are sample configuration, editable in Settings.

## Commands

| Command                                       | Purpose                                                                               |
| --------------------------------------------- | ------------------------------------------------------------------------------------- |
| `npm run dev:local`                           | Persistent local MongoDB replica set + seed + API + Vite                              |
| `npm run dev`                                 | API and Vite against your configured MongoDB                                          |
| `npm run seed`                                | Seed catalogs and settings                                                            |
| `npm run migrate`                             | Idempotently migrate legacy orders, expenses and ABEX configuration                   |
| `npm run lint`                                | ESLint for JavaScript/JSX                                                             |
| `npm test`                                    | Domain and transaction-backed HTTP/service tests with an isolated MongoDB replica set |
| `npm run build`                               | Build React into `client/dist`                                                        |
| `npm start`                                   | Start Express; serves `client/dist` if built                                          |
| `npm run test:browser`                        | Browser workflows against a separate disposable database and port 4019                |
| `npm run format`                              | Format project source with Prettier                                                   |
| `npm run admin:password -- "a-long-password"` | Generate a bcrypt password hash and random session secret                             |

The browser test uses installed Microsoft Edge on Windows and Playwright Chromium elsewhere. On other platforms install the browser once with `npx playwright install chromium`. Screenshots are written under `.local/qa`. Browser test records never enter the preview database.

## Configuration and authentication

All environment configuration is server-side. There are no `VITE_DELIVERY_*` secrets.

| Variable                                 | Meaning                                                                        |
| ---------------------------------------- | ------------------------------------------------------------------------------ |
| `PORT`                                   | Express port, default 4000                                                     |
| `MONGODB_URI`                            | MongoDB replica-set connection string                                          |
| `CLIENT_URL`                             | Exact allowed browser origin, including port                                   |
| `NODE_ENV`                               | `development`, `test`, or `production`                                         |
| `BOOTSTRAP_SUPER_ADMIN_NAME`             | Display name for the first Super Admin                                         |
| `BOOTSTRAP_SUPER_ADMIN_EMAIL`            | Normalized email for the first Super Admin                                     |
| `BOOTSTRAP_SUPER_ADMIN_PASSWORD`         | One-time bootstrap password (12–72 characters); remove after creation          |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD_HASH`     | Legacy bootstrap alternative for existing installations                        |
| `SESSION_SECRET`                         | Reserved server secret for compatible deployments                              |
| `DELIVERY_CREDENTIALS_ENCRYPTION_KEY`    | Stable 32-byte hexadecimal key used for AES-256-GCM credential encryption      |
| `DELIVERY_API_BASE_URL`                  | Defaults to `https://procolis.com/api_v1`                                      |
| `DELIVERY_API_TOKEN`, `DELIVERY_API_KEY` | ABEX credentials, only used in backend headers                                 |
| `DELIVERY_TIMEOUT_MS`                    | Courier timeout, default 15000 ms                                              |
| `DELIVERY_STATUS_MAP`                    | JSON object of **verified** provider values to internal statuses; default `{}` |
| `DELIVERY_SYNC_INTERVAL_MS`              | Optional scheduled batch synchronization; 0 disables, minimum 60000            |

Authentication is mandatory. Sessions use opaque random tokens in HTTP-only, SameSite=Strict cookies, with Secure enabled in production; MongoDB stores only token hashes. Disabled users and revoked or expired sessions lose access immediately. Mutating browser requests check the exact configured Origin. Login and API routes are rate limited, Express uses Helmet, and raw database/provider errors are not returned to the browser. Users combine role, explicit permissions, business access and ownership scope; only `SUPER_ADMIN` receives unconditional access.

## Architecture

```text
client/src/
  pages/                 Reports, orders, expenses, customers, users, agencies and settings
  components.jsx         Accessible fields, tables, dialogs, filters, KPI cards
  api.js                 API client, request state and display formatting
server/src/
  models/                Business, security, session, audit and delivery schemas
  domain/                Monetary calculations, validation, phone identity, date ranges
  services/
    orderService.js      Transactional order creation, edits and history
    analyticsService.js  Central reporting definitions and formulas
    delivery/            Provider factory, encrypted credentials, mapping and sync
  routes/                Validated HTTP endpoints
  auth.js                Registration, login and database-backed session lifecycle
  authorization.js       Central permission, business and ownership checks
  migrate.js             Idempotent legacy-data and ABEX migration
  seed.js                Idempotent sample configuration
server/test/             Domain and database-backed regression tests
scripts/                 Local database runner, browser checks and password generation
```

The backend is authoritative for prices, quantities, subtotals, business classification, payment balances, status changes and reports. Frontend order totals are only a reactive preview; all values are recalculated before persistence. Catalog prices and shipping tariffs auto-fill but admins can explicitly override them per order. Monetary input accepts up to two decimal places and the order total is capped at 10 billion DA.

### Automatic courier creation

`POST /orders` commits the local order before calling the selected API agency when its `createShipment` capability is enabled. Order creation authorizes this initial action; recovery endpoints retain their existing shipment permissions and business checks. Manual agencies keep their separate shipment action.

The response preserves top-level order fields and adds `shipment` and `shipmentSync` (`attempted`, `success`, and any error). Courier failure still returns HTTP 201 with the saved order ID. Initial Procolis creation sends `Confrimee: "0"`, the Wilaya's provider `agencyId`, the collection balance, and the order number as both `Tracking` and `id_Externe`.

`MessageRetour: "Good"` marks creation as accepted. The returned tracking, or the deterministic order number when it is omitted, becomes `SYNCED`. `Double Tracking` triggers a `/lire` lookup and never another `/add_colis` request. Unknown responses become `PENDING` with `uncertain: true`; provider rejections and transport errors become `ERROR` while the local order remains created.

Every outbound creation attempt remains reserved, including timeouts and HTTP errors. A later retry checks the order number through `/lire` before any new creation. An administrator can still explicitly confirm parcel absence to unlock one retry. No external-reference search endpoint is assumed. Unknown tracking blocks readiness until reconciliation; linked parcels use `/pret`.

The parser accepts the legacy `{ Colis: [...] }` envelope, a direct array returned by the legacy service, or one direct object with `Tracking`. For `/lire`, it reads `Situation` first and retains `IDSituation` plus `DateH_Action`; legacy `Statut` remains a fallback. The complete sanitized provider response is preserved for diagnostics.

### Orders and history

- Items drive `TAMQO_ONLY`, `LOGIX_ONLY`, or `PARTNERSHIP`; users never select partnership manually.
- A partnership is one order with independent Tamqo and Logix item revenue. Delivery is separate.
- Names, prices, duration, source and location are snapshotted. Configuration changes do not change historical orders. Existing items retain their original snapshot names when an order is edited.
- `originalData` preserves the original order. OrderEvent records creation, full before/after edits, status, activation, collection and shipment actions. The timeline API omits bulky edit payloads, but they remain stored for audit.
- Order numbers use an atomic counter allocated outside order transactions. Failed creations may leave gaps; numbers are never reused.
- Phone A accepts local `05/06/07` numbers, `+213`, `213`, and `00213` formats. Whitespace, parentheses, dots and hyphens are removed before identity matching. The original number remains on the order.
- Editing is allowed before shipment while NEW, CONFIRMED or PREPARING. Revision checks reject stale edits. Once a Shipment exists, order details are locked to prevent divergence from a courier request.
- Manual transitions follow the state graph. Digital Tamqo-only orders may complete from CONFIRMED/PREPARING. Physical orders realize on delivery. An administrator can activate a Tamqo subscription separately, including its portion of a partnership, without prematurely realizing the physical partnership order.
- Record courier collection explicitly. A DELIVERED status does **not** imply that cash has been remitted or collected in your records.

### Sales definitions

Reports select orders by **creation date**, then evaluate their current state. Dates are inclusive in the UI and converted to half-open date ranges in Africa/Algiers (UTC+01:00). Today, yesterday, last 7/30 days, month, last month, year, and custom ranges are supported. Growth compares the immediately preceding range of exactly equal duration. If the previous amount is zero and the current amount is positive, growth is `null`, displayed as “New”. Empty denominators otherwise return zero.

| Metric                                                | Definition                                                                                                                                  |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Gross sales                                           | Scoped product value for orders that reached CONFIRMED, excluding CANCELLED; returns remain in gross sales                                  |
| Net sales                                             | Delivered physical orders; confirmed Tamqo-only orders activated, delivered or paid for products; NEW/CANCELLED/RETURNING/RETURNED excluded |
| Average/highest/lowest/median order value             | Scoped product value of all selected orders; shipping excluded                                                                              |
| Units sold                                            | Scoped units on realized orders                                                                                                             |
| Units ordered                                         | Scoped units on all selected orders                                                                                                         |
| Pending sales                                         | Not realized, cancelled, returning or returned                                                                                              |
| Delivery success rate                                 | Delivered count / count that reached SHIPPED, with denominator at least the delivered count                                                 |
| Confirmation/cancellation/return/failed/pending rates | Respective counts / selected order count                                                                                                    |
| Completion rate                                       | Realized order count / selected order count                                                                                                 |
| Returning customer                                    | First scoped purchase before the selected period                                                                                            |
| New customer                                          | First scoped purchase within the selected period                                                                                            |
| Repeat purchase rate                                  | Selected customers with multiple scoped orders through period end / selected customer count                                                 |
| Lifetime revenue                                      | Realized scoped revenue through period end, for customers appearing in the selected period                                                  |
| Repeat interval                                       | Average days between sequential scoped orders for those customers                                                                           |
| Renewal                                               | Explicitly marked Tamqo renewal item on a realized order                                                                                    |
| Timing                                                | Average hours between actually recorded transitions; incomplete timestamp pairs excluded                                                    |

Tamqo reports include only Tamqo item revenue, including its portion of partnership orders. Logix behaves similarly. Partnership reports contain only orders with both businesses. Partnership shares use realized product revenue: 4,000 / 11,000 = 36.36% Tamqo and 7,000 / 11,000 = 63.64% Logix. The 500 DA delivery charge is excluded.

Group tables provide sales, orders, customers, units, rates and averages by source, Wilaya, commune, product/plan and payment method. Payment collection and delivery charges are **whole-order context** in business reports and must not be added together across Tamqo and Logix. Catalog shares and revenue use realized sales. Sources retain their historical snapshot names. Lists are paginated on the server; customer lifetime totals and expense totals use MongoDB aggregation where appropriate. Detailed reports calculate on the backend over the selected and previous periods, fetching prior history only for customers in the selected cohort. They are synchronous reports; very large multi-year datasets should move reporting to pre-aggregated collections after profiling.

### Payment example

Products 11,000 DA + delivery 500 DA:

| Method                   | Paid online | Courier to collect | Product revenue |
| ------------------------ | ----------: | -----------------: | --------------: |
| COD                      |           0 |             11,500 |          11,000 |
| MIXED (products prepaid) |      11,000 |                500 |          11,000 |
| ONLINE (fully prepaid)   |      11,500 |                  0 |          11,000 |

ONLINE requires the entire order paid; use MIXED for prepaid products with unpaid shipping. Overpayment is rejected. Courier `Total` uses the amount remaining at shipment creation, never internal revenue.

### Expenses

Tamqo and Logix each have their own expense manager, configurable categories, search, date/category/payment filters, sorting, pagination, edits and deletion. Expense KPIs reflect the selected filters, including today/month/year intersections, category/month breakdowns and equal-period growth. Category names are snapshotted. No partnership expenses, invented COGS or product margins are calculated. Expenses never modify an order's sales values.

## ABEX / Procolis integration

The supplied `Development DOCs.html` was read before implementation. The adapter uses Axios only on the server, sending `token` and `key` headers with a timeout and no redirects. The supplied HTML itself is not copied into the project because it is an exported account page.

Documented requests implemented:

- `GET /token` — credentials are valid only when `Statut` is `Accès activé`.
- `POST /add_colis` — `{ Colis: [...] }` shipment creation.
- `POST /lire` — `{ Colis: [{ Tracking }] }` parcel lookup.
- `POST /pret` — ready-to-ship request, only when tracking exists.
- `POST /tarification` — pricing adapter method. Local shipping remains configurable; no unverified response is automatically imported.

The request mapping includes Tracking, TypeLivraison (`0` home / `1` desk), TypeColis (`0` normal / `1` exchange), Confrimee, Client, MobileA/B, Adresse, IDWilaya, Commune, Total, Note, TProduit, id_Externe, and Source. Creation uses `Confrimee: "0"`; readiness has its own `/pret` action.

### Response verification

Legacy creation responses are read from `Colis[0]`. `Good` is successful, `Double Tracking` is reconciled through `/lire`, and any other `MessageRetour` is retained as a provider rejection. Verified ABEX labels have built-in mappings; `DELIVERY_STATUS_MAP` can extend or override them. Unknown `Situation` values remain successful syncs, retain the exact provider label, and do not change the order.

Known mapped forward status jumps can skip unobserved stages; only the actual observed transition is recorded. Invalid regressions and terminal-state changes are retained as sync errors for review.

### Failure, retries and reconciliation

Order saves and courier requests are separate. An API failure cannot delete an order. One unique Shipment per order stores PENDING/SYNCED/ERROR, raw provider status, sanitized data, last error and sync timestamps. Tracking is unique when present. Credentials and secret-bearing field names are removed from retained provider data.

Creating a parcel uses a database lock and immutable external order number. Missing credentials allow a safe retry without an external attempt. Once a request could have reached the provider, a timeout, unknown response or crash is treated as uncertain: **automatic re-creation is blocked**. HTTP failure does not prove the provider failed to create the parcel.

Use Reconcile shipment in Order Details to verify the order's external reference in the courier portal and link its tracking number. The configured tracking lookup must find the number. If you have verified that no parcel exists, explicitly confirm its absence to unlock one new attempt. Do not link another order's parcel. The supplied API has no documented lookup by `id_Externe`, cancellation route, idempotency guarantee or webhook contract; none has been fabricated. To cancel an order after a possible shipment, first cancel the parcel with ABEX and confirm that action in the workspace. The confirmation is audited.

Manual refresh is available per order. Settings can synchronize up to 100 active shipments in chunks of 20. Optional scheduled sync runs inside the single API process without overlapping itself. In a multi-process deployment, enable the schedule in only one process or use a distributed scheduler.

**Live ABEX requests were not sent during implementation.** Production credentials and verified provider responses are still needed to validate the external integration. Automated delivery tests use explicit test-double responses to verify local behavior, not to assert the real provider contract.

## API overview

All routes except health and auth require the administrator session when authentication is enabled. JSON errors use `{ "error": { "message", "code" } }`.

| Method                | Route                                                                    | Purpose                                     |
| --------------------- | ------------------------------------------------------------------------ | ------------------------------------------- |
| GET                   | `/api/health`                                                            | Database readiness                          |
| GET/POST/POST         | `/api/auth/session`, `/login`, `/logout`                                 | Session lifecycle                           |
| GET/POST              | `/api/orders`                                                            | Paginated list / create                     |
| GET/PATCH             | `/api/orders/:id`                                                        | Detail / revision-checked edit              |
| GET                   | `/api/orders/:id/timeline`                                               | Chronological audit timeline                |
| POST                  | `/api/orders/:id/confirm`, `/cancel`, `/status`, `/activate`, `/payment` | Lifecycle and collection actions            |
| POST                  | `/api/orders/:id/shipment`                                               | Create or safely retry shipment             |
| POST                  | `/api/orders/:id/shipment/ready`, `/refresh`, `/reconcile`               | Courier actions                             |
| GET                   | `/api/analytics/all`, `/tamqo`, `/logix`, `/partnership`                 | Reports                                     |
| GET                   | `/api/analytics/employees`, `/employees/:userId`                         | Employee performance                        |
| GET/POST              | `/api/expenses`                                                          | Filtered, paginated list + summary / create |
| GET/PATCH/DELETE      | `/api/expenses/:id`                                                      | Expense detail / edit / delete              |
| GET                   | `/api/config`                                                            | Full configuration                          |
| GET/POST              | `/api/config/:resource`                                                  | List / add                                  |
| PATCH/DELETE          | `/api/config/:resource/:id`                                              | Edit / soft-disable                         |
| POST                  | `/api/config/:resource/reorder`                                          | Atomic full-list reordering                 |
| GET                   | `/api/customers`, `/api/customers/:id`                                   | Customers and lifetime values               |
| GET/POST/PATCH        | `/api/users`, `/api/users/:id`                                           | Authorized user management                  |
| GET/DELETE            | `/api/auth/sessions`, `/api/users/:id/sessions`                          | Session inspection and revocation           |
| GET/PATCH             | `/api/settings/registration`                                             | Super Admin registration-key management     |
| GET                   | `/api/audit`                                                             | Append-oriented audit history               |
| GET/POST/PATCH/DELETE | `/api/delivery-agencies`, `/api/delivery-agencies/:id`                   | Delivery agency management                  |
| GET/POST/PATCH        | `/api/delivery-agencies/:id/rates`                                       | Agency-specific Wilaya rates                |
| POST                  | `/api/delivery-agencies/:id/test`                                        | Safe server-side connection test            |
| GET                   | `/api/delivery/status`                                                   | Boolean configuration readiness, no secrets |
| POST                  | `/api/delivery/test`, `/api/delivery/sync`                               | Connectivity / batch sync                   |

Resources: `plans`, `products`, `sources`, `wilayas`, `expense-categories`. Deletion of configuration soft-disables it so old references remain valid. Sources enforce exactly one active default, with a unique partial index and transactional switching.

Order filters: `search`, `business` (`TAMQO_ONLY`, `LOGIX_ONLY`, `PARTNERSHIP`), `employee`, `status`, `source`, `wilaya`, `commune`, `catalog`, `payment`, `deliveryType`, `tracking`, `phone`, `customer`, `customerId`, `period`, `start`, `end`, `page`, `limit` (maximum 100). Expense filters: `business` (required), `search`, `addedBy`, `category`, `paymentMethod`, reporting period, `sort`, `direction`, `page`, `limit`. Period identifiers: `today`, `yesterday`, `7d`, `30d`, `month`, `lastMonth`, `year`, `custom`. Custom dates use `YYYY-MM-DD` and are inclusive in the request.

## Production deployment

1. Provision a backed-up MongoDB replica set or Atlas database; restrict database network access and use an application-specific account.
2. Install locked dependencies with `npm ci`; build with `npm run build`.
3. Configure `NODE_ENV=production`, first-Super-Admin bootstrap credentials, a random session secret, the delivery encryption key, `MONGODB_URI`, and `CLIENT_URL` matching the HTTPS public origin. Set only verified provider mappings.
4. Run `npm run migrate`, remove `BOOTSTRAP_SUPER_ADMIN_PASSWORD`, then run `npm start` behind an HTTPS reverse proxy on the same host. Express binds to 127.0.0.1. Serve the built frontend and `/api` from the same origin. Forward requests to the configured API port. Secure cookies require HTTPS.
5. Supervise the process, retain database backups, monitor `/api/health` and shipment ERROR states, and perform a live courier acceptance test. Build/start do not seed automatically.
6. Before upgrading, back up data and validate indexes and configuration in staging. If migrating from an earlier development snapshot with duplicate tracking numbers, reconcile those before creating the unique tracking index.

There is no hosted deployment or configured production database in this repository. The local preview is a development instance; deployment and real courier validation require your environment values.

# crm_logix_x_tamqo
