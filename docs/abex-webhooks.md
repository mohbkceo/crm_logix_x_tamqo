# ABEX inbound webhooks

Implementation status: secure receiver, durable inbox, worker, targeted-refresh integration, admin monitoring and recovery are implemented. **The live ABEX delivery event contract remains unverified. Automatic webhook status mutations are disabled in code. Keep polling enabled until the contract and live acceptance are complete.** No live destination, signing secret, production setting or shipment was changed during this implementation.

## Contract evidence and remaining dependency

The configured destination is `00c7191e-83b7-43dd-beda-9d5425cf51d3`, subscribed to All topics, at `https://crm.tamqo.com/api/webhooks/delivery/abex`. Reuse it; do not recreate it or change its URL. The destination ID comes from server configuration, not a presumed incoming header or payload field.

On 2026-11-21, the [ABEX public OpenAPI](https://app.abex.clawdyatms.app/swagger/public-v1/swagger.json) was fetched successfully. It describes supplier webhook endpoint CRUD, headers and signing-secret retrieval. It does not define outbound topic names, event envelopes, parcel identifiers in delivery events, or event timestamps. The [API Tokens portal](https://app.abex.clawdyatms.app/api-rest/tokens) returned a Cloudflare challenge. Searches did not supply verified ABEX payload examples. Documentation from other TMS providers is not evidence of the ABEX contract.

Signing follows the [official Standard Webhooks specification](https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md), using the maintained [`standardwebhooks` JavaScript implementation](https://github.com/standard-webhooks/standard-webhooks/tree/main/libraries/javascript), pinned to package version `1.3.0`. The signing standard does not establish ABEX's payload schema.

`abexWebhookAdapter.js` deliberately has `contractVerified: false`. Every authenticated object is classified as `UNVERIFIED`; the worker marks it `IGNORED / ABEX_CONTRACT_UNVERIFIED`. It does not read guessed `type`, `data`, `status`, `orderId`, tenant, tracking or parcel fields. Authentication and reception can be validated now; webhook-driven status cutover cannot.

To complete the provider adapter:

1. Obtain official ABEX topic/schema documentation or approved provider samples with verified provenance. Do not paste the signing secret or customer data into Git.
2. Confirm exact topic names, envelope/version, parcel UUID field, optional tracking field, account scope, delivery/retry semantics and event ordering. Confirm which All-topic notifications are unrelated.
3. Implement the provider parser in `abexWebhookAdapter.js`; pin a contract version and mark it verified only with that evidence. Translate supported events into the **internal** `notificationSchema` (`parcelId`, optional `trackingNumber`). This schema is a CRM interface, not a claimed ABEX payload.
4. Store only these validated identifiers. Do not add payload-controlled URLs, agency IDs, order IDs, statuses or alternate lookup fallbacks. Add provider contract fixtures and targeted HTTP/database tests.
5. Validate real signed notifications on an approved pilot, including their current authenticated parcel read and CRM effects, before accepting cutover.

There is no environment flag or administrative replay that overrides this contract gate. Synthetic `test.parcel` and `test-fixture-v1` values occur only in test fixtures and are not ABEX event names. Unknown bodies are not retained, so ignored unverified events cannot later be reparsed. After an adapter release, use manual reconciliation/polling or new provider delivery to recover the current parcel state.

## Existing delivery architecture audit

| Area | Existing implementation and integration decision |
| --- | --- |
| Scheduler startup | `server/src/index.js` connects MongoDB, migrates, opens Express and calls `startDeliverySyncScheduler()`. The scheduler uses `STARTUP` and `CRON` triggers and reloads settings on ticks. Disabled cron only checks settings; it does not call provider sync. |
| Persisted configuration | `DeliverySyncSettings`, ID `delivery-sync`, stores `cronEnabled`, `intervalMinutes`, `loggingEnabled` and actor. Environment values supply initial defaults; saved MongoDB settings win. No webhook startup code changes them. |
| Order/shipment link | A unique `Shipment.orderId` references the CRM order; `agencyId`, `provider`, `externalId`, tracking and `providerParcelId` identify the original courier parcel. Creation and readiness have separate reservations. |
| ABEX identity | `isAbexId`, `AbexClient.getShipment()` and `requireAbexIdentity()` validate parcel UUID, tracking and exact CRM external reference; the client also checks returned tenant when present. Webhooks resolve an existing UUID only inside the configured agency, then revalidate after fetching and inside the transaction. |
| Mapping | `abexParcel()` orders observations by provider timestamps. `abexState()` uses verified agency workflow/state/situation UUID mappings and the authenticated workflow catalog. The legacy label mapper remains separate for Procolis. No webhook status list is introduced. |
| Transitions | `DeliverySyncService.applyWithResult()` remains authoritative. It calls `transition(..., "courier", session)` and `canProviderTransition`, preserving manual corrections, terminal restrictions, readiness reservations and stale/equal timestamp conflict checks. |
| Production tracking | Existing `tracking.stage`, `courierOwned`, readiness and blocking rules remain intact. Courier transitions claim ownership through existing logic; status history and `OrderEvent` preserve the commercial transition. Webhooks never finalize production readiness or submit readiness PATCH requests. |
| Finance/reporting | Existing `ensureReturnExpense` / `reverseReturnExpense` run in the same delivery transaction. Return fees are idempotent; reporting reads the same order/expense data. Delivery never implies cash collection. |
| Manual tools | Order shipment refresh/reconcile, Tracking refresh/readiness and Run Sync Now keep their routes, authorization and provider selection. Webhooks bypass the refresh path that may recover parcel creation and instead call only the authenticated targeted read plus `applyWithResult`. |
| Logs/audit | Existing `DeliverySyncRun`/`DeliverySyncItem` track polling/manual runs, optionally disabled by logging settings. Status transitions use existing order history/audit events. The webhook inbox is always durable regardless of that logging switch; manual retry and its audit record share a transaction. |

Inspected files include `app.js`, `index.js`, the delivery services, delivery/agency/order routes, delivery/index/tracking models, the order domain/state machine, Delivery Sync Logs/Tracking/Orders/Agencies pages, ABEX/tracking docs and the existing test suites.

## Receiver and durability

`POST /api/webhooks/delivery/abex` is mounted after security/request-ID middleware and before CORS preflight handling, global JSON parsing, browser-origin validation and CRM session authentication. All other CRM routes keep their existing protection. Unsupported methods receive `405` with `Allow: POST`; non-JSON/compressed bodies receive `415`; bodies over 150 KiB receive `413`. Its rate limiter permits 300 requests per minute per observed client address, independently on each backend process. Deployments requiring a shared/global limit should enforce it at the reverse proxy. Do not trust arbitrary `X-Forwarded-For` values.

The receiver checks one occurrence of each `webhook-id`, `webhook-timestamp`, `webhook-signature` header. The library verifies the exact Buffer bytes over `{id}.{timestamp}.{body}` with the base64-decoded `whsec_` key, timing-safe comparison, space-separated versioned signatures and a five-minute past/future tolerance. Additional validation rejects ambiguous timestamps and malformed header values. UTF-8/JSON parsing occurs only after verification. No unsigned development mode exists. Invalid signatures return `401`; invalid JSON/schema returns `400`. Responses contain fixed error messages and request IDs, never secrets, raw bodies, provider errors or database connection strings.

The unique MongoDB index `(provider, destinationId, eventId)` is explicitly created before the production listener opens, even with `autoIndex=false`. Inserts use majority write concern and a five-second write-concern timeout. Exact duplicate IDs are acknowledged only after a majority-readable persisted match. The same ID with different raw bytes returns `409 / WEBHOOK_REPLAY_CONFLICT`. Database failures return `503`; the sender should retry. A write timeout may already have inserted the row, so retry uses the same ID/body to resolve uncertainty safely.

The inbox retains a body SHA-256, byte/field counts, signed transport timestamp, validated contract metadata and (when supported) minimal parcel identifiers. It stores no raw body, request signature, signing secret, address, customer name or phone. The signed transport time is not used as the parcel's update time.

`RECEIVED → PROCESSING → PROCESSED | IGNORED | RETRY_PENDING | FAILED` is durable. Atomic claims issue random tokens and five-minute leases. Expired leases can be reclaimed; fencing prevents an old worker from committing. Claims, including crashes, count toward the retry budget. Retry delay starts at 15 seconds, doubles, and caps at one hour; default maximum is eight attempts. Deterministic identity, mapping and transition failures require review. Provider busy/timeout/unavailability and not-yet-linked shipments retry. A crash on the final attempt becomes visible as `FAILED`, not an indefinitely processing row.

For supported contracts, the worker resolves the existing shipment in the **server-bound agency**, fetches only its current parcel with the existing bounded ABEX client, and invokes `applyWithResult()` with a shared MongoDB transaction. The claim fence, order/shipment/history/finance/audit effects and inbox completion commit together. Polling, manual reads and concurrent webhooks use the same transaction/optimistic-concurrency rules. No event creates a parcel, searches all shipments, guesses an order, calls a supplied URL or sends a readiness write.

Processed/ignored rows expire 30 days after completion; failed rows expire 90 days after failure by default. Pending/retry rows do not expire. MongoDB TTL removal is asynchronous. Retention changes apply to newly finalized rows, not retroactively. Deduplication lasts while the row is retained; the five-minute authentication window independently rejects captured stale requests after retention. After a long outage, reconcile current provider state rather than replaying stored old states.

## Environment

Configure only in the backend secret manager/environment. Never use `VITE_` for these values.

```dotenv
ABEX_WEBHOOK_ENABLED=false
ABEX_WEBHOOK_SECRET=
ABEX_WEBHOOK_DESTINATION_ID=00c7191e-83b7-43dd-beda-9d5425cf51d3
ABEX_WEBHOOK_AGENCY_ID=
ABEX_WEBHOOK_PROCESSING_ENABLED=false
ABEX_WEBHOOK_RETENTION_DAYS=30
ABEX_WEBHOOK_FAILED_RETENTION_DAYS=90
ABEX_WEBHOOK_MAX_ATTEMPTS=8
```

`ABEX_WEBHOOK_SECRET` must be `whsec_` plus canonical base64 encoding of at least 32 bytes. Use the **rotated destination signing secret from ABEX**, not its API token. `ABEX_WEBHOOK_AGENCY_ID` is the existing CRM ABEX agency's 24-character ObjectId. It is captured at reception; changing the binding does not redirect already accepted events to another agency. The destination UUID is mandatory when enabling reception. Enabled reception with an invalid/missing secret or destination aborts production startup and fails closed at request time. Invalid agency IDs abort startup too.

`ABEX_WEBHOOK_PROCESSING_ENABLED=true` enables inbox processing independently of `cronEnabled` and the receiver's enable flag (so reception can be paused while draining). A valid secret/destination configuration is still required. It does not verify or activate an unsupported provider contract. Polling's `DELIVERY_SYNC_ENABLED` / interval defaults and `ABEX_WRITES_ENABLED` keep their existing meanings.

## Deploy to crm.tamqo.com

1. Back up MongoDB and confirm it is a replica set with transaction support. Deploy the feature branch through the normal reviewed release process; no push/deploy is performed by this implementation.
2. Run `npm ci`, `npm run lint`, `npm test`, `npm run build`, and the browser checks listed below. Retain the existing session secret, credential encryption key, database URI, ABEX API credentials and frontend origin. Do not run the ABEX migration cutover again for webhook setup.
3. Obtain/rotate the destination signing secret through the existing ABEX destination UI or authorized provider support. The public API documents authenticated `GET /api/v1/webhooks/endpoints/{endpointId}/secret` for supplier admins, but does not specify a rotation API; do not invent one. Keep the destination and URL unchanged. Coordinate rotation across all backend instances; use the provider's retry facility for deliveries during the switch.
4. Set `ABEX_WEBHOOK_ENABLED=true`, the real signing secret, the destination UUID, and its CRM agency ID. Set `ABEX_WEBHOOK_PROCESSING_ENABLED=true` to classify unverified events and surface health. Keep saved `cronEnabled=true`. Restart every backend instance. The process waits for the unique index before accepting requests and starts the independent inbox worker.
5. Route the exact HTTPS path through the existing reverse proxy to Express, preserving body bytes, content type and signature headers. Do not add browser login/CSRF interception, rewrite the body or transparently decompress it. For Nginx, preserve the existing `/api/` upstream behavior or use an exact location equivalent to:

   ```nginx
   location = /api/webhooks/delivery/abex {
       client_max_body_size 150k;
       proxy_pass http://127.0.0.1:4000;
       proxy_set_header Host $host;
       proxy_set_header X-Forwarded-Proto $scheme;
   }
   ```

   Use the deployment's actual upstream/port and existing TLS configuration. Check intermediary/WAF rules and time synchronization on every worker. An unsigned POST must return `401`, not an HTML login screen, `404`, redirect or success. A GET must return `405`. Confirm other CRM APIs still require authentication.
6. In **Settings → Delivery Synchronization**, check configuration, receiver enablement, last reception, last processed delivery, worker scan, pending/failed counts and the unverified-contract warning. Configuration alone is not evidence of delivery health. Compare destination delivery receipts with persisted event IDs and hashes. A synthetic signed object proves transport/storage only; real supported delivery behavior requires the adapter and pilot acceptance above.

The following synthetic smoke request runs from a backend environment where the secret is already securely injected. It prints only HTTP status. Use it against a local/test deployment first; do not put a real secret in command-line arguments or shell history. It does not claim an ABEX event topic or mutate a shipment.

```sh
node scripts/abex-webhook-smoke.js http://127.0.0.1:4000
```

After deliberate approval for a production transport check, the same script accepts `https://crm.tamqo.com` and posts to the configured path. It signs with the current environment secret; it never retrieves or changes the destination.

## Administration and recovery

Authenticated APIs under `/api/delivery-sync/webhooks` require `deliverySync.view`:

| Route | Purpose |
| --- | --- |
| `GET /status` | Configuration, contract gate, scoped counts, reception/completion timestamps and persistent worker scan health. |
| `GET /events` | Pagination; `status`, exact `eventType`, `agencyId`, ISO-offset `from`/`to`, and literal order/tracking `search` filters. |
| `GET /events/:id` | Sanitized details and retry eligibility; no raw payload/secret/claim token. |
| `POST /events/:id/retry` | ADMIN/SUPER_ADMIN plus `deliverySync.run`; transactionally queues eligible failed/pending events and writes `DELIVERY_WEBHOOK_RETRY` audit. |

Business-scoped users must have access to every business served by an event's agency, including the agency business scope captured at reception, before they can inspect unresolved identifiers. Later agency reassignment cannot broaden access to historical identifiers. Globally authorized users can inspect unbound metadata. Query IDs are validated, text searches escaped, and lists bounded. Retry preserves the original normalized notification, contract version, agency, event ID/hash and total attempt count. It resets only the current attempt budget, allows at most five administrator recovery actions, and never bypasses lease/identity/mapping/transition checks. Processed/ignored/unverified events cannot be manually replayed.

For unavailable MongoDB, fix connectivity/replica-set health; `503` requests should be redelivered by ABEX. Already acknowledged events stay in MongoDB. For worker outages, inspect the last scan and oldest pending time; restart a healthy worker to resume persisted claims after lease expiry. For API timeouts/rate limits, let durable retries run; fix credentials/permissions or mappings before an authorized manual retry. For unknown shipments, finish normal verified parcel linking; do not guess an order from the webhook. For production-readiness or transition conflicts, use existing Tracking/reconciliation procedures before retrying.

Stop reception with `ABEX_WEBHOOK_ENABLED=false`; pause processing separately with `ABEX_WEBHOOK_PROCESSING_ENABLED=false`. Do not delete inbox rows to clear a backlog. Failed rows have a finite review window, so resolve/export sanitized operational records before their configured expiry. No raw customer payload archive exists.

## Explicit polling migration and rollback

Run polling and webhooks together during validation. Supported updates share the same authoritative business transaction, so overlap does not duplicate transition events or return expenses. The independent worker never starts provider-wide polling.

Only after a reviewed adapter release and real ABEX pilot acceptance should an administrator disable **Cron** and save settings (authenticated `PUT /api/delivery-sync/settings` with `{ "cronEnabled": false }`). Confirm saved settings and no new `CRON` runs/provider-wide polling across every instance after its next settings check; an already running sync may finish. Startup does not overwrite saved settings. The webhook worker continues claiming/retrying inbox events while cron is off. Run Sync Now, per-order tracking refresh and reconciliation remain available.

For webhook outages, re-enable saved `cronEnabled=true`, use Run Sync Now to catch up, and inspect inbox failures. If rolling back application code, retain inbox collections and TTL/index definitions, enable polling first, and drain/stop the independent worker cleanly. Do not switch historical Procolis shipments to ABEX or recreate parcels as a recovery action.

## Verification

Run from the repository root:

```sh
npm run lint
npm test
npm run build
npm run test:webhook-browser
npm run test:delivery-browser
npm run test:readiness-browser
```

Targeted receiver/database tests: `node --import ./test/setup.js --test --test-concurrency=1 test/abexWebhooks.test.js` from `server/`.

The webhook tests use generated signing keys, real HTTP requests, isolated MongoDB replica sets and a loopback ABEX API fixture exercising the existing client/mapper. They verify signatures/timestamps/raw bytes, deduplication, identity and production boundaries, financial idempotency, concurrency, transaction rollback, real database disconnection, real HTTP timeout, lease crashes, bounded attempts, cron independence, admin authorization and recovery. Browser screenshots go to ignored `.local/qa/webhooks/`. Live provider events, deployed reverse-proxy reachability and production cutover remain separate acceptance steps.

## Validation results

Final validation on 2026-11-21:

| Command | Actual final result |
| --- | --- |
| `npm run lint` | Passed. |
| `npm test` | 256 passed, 0 failed, 0 skipped; includes 49 webhook tests and 207 existing tests. |
| `npm run build` | Passed. |
| `npm run test:webhook-browser` | Passed: signed reception, monitoring, pagination, filters, sanitized details, audited recovery and desktop/390px mobile layout. Screenshots inspected; long mobile values wrap. |
| `npm run test:delivery-browser` | Passed: ABEX parcel creation, edit confirmation, readiness, pending/rejected shipments and manual agency behavior. |
| `npm run test:readiness-browser` | Passed: production readiness, historical Procolis status/deletion behavior, protected APIs and mobile labels. |
| `git diff --check` | Passed. |
| `npm audit --json` | Nonzero exit: one pre-existing high-severity Mongoose dependency entry; see release limitations. |

An intermediate future-timestamp fixture was moved from 301 to 360 seconds ahead to avoid entering the library's five-minute window while the test executed. Intermediate browser runs were rerun after the build completed and the responsive-navigation test waited for its collapsed state. The final results above use the corrected tests; no production rule was loosened.

## Changed file inventory

| File | Purpose |
| --- | --- |
| `server/src/app.js` | Mounts only the signed receiver before browser middleware and login. |
| `server/src/index.js` | Validates webhook configuration, awaits indexes, starts/drains the independent worker. |
| `server/src/models/deliveryWebhook.js` | Durable event model, uniqueness, lease/retention indexes and worker health. |
| `server/src/routes/abexWebhookRoutes.js` | HTTP method/type/size/rate controls, authentication and durable acknowledgement. |
| `server/src/routes/deliveryWebhookAdminRoutes.js` | Scoped health/history/detail APIs and audited recovery. |
| `server/src/routes/deliverySyncRoutes.js` | Mounts the authenticated webhook monitoring routes. |
| `server/src/services/delivery/webhooks/webhookConfig.js` | Backend-only settings, safe defaults and fail-closed validation. |
| `server/src/services/delivery/webhooks/verifyAbexWebhook.js` | Official raw-byte signature verification, strict headers/timestamps and post-verification JSON decoding. |
| `server/src/services/delivery/webhooks/abexWebhookAdapter.js` | Explicit unverified provider contract and internal notification validation. |
| `server/src/services/delivery/webhooks/webhookInboxService.js` | Majority-confirmed persistence/deduplication, atomic claims, durable attempts and retention. |
| `server/src/services/delivery/webhooks/webhookReconciliationService.js` | Resolves only a server-bound existing parcel and reads its authoritative state. |
| `server/src/services/delivery/webhooks/webhookProcessor.js` | Fenced worker, atomic completion with business effects, bounded retries and health. |
| `server/src/services/delivery/deliverySyncService.js` | Allows a shared transaction and adds stable observation result codes; retains existing status rules. |
| `client/src/pages/DeliveryWebhookEvents.jsx` | Configuration/reception/processing overview, filters, pagination, details and eligible retry. |
| `client/src/pages/delivery-webhooks.css` | Scoped wrapping of long identifiers and explanations on mobile. |
| `client/src/pages/DeliverySyncLogs.jsx` | Integrates webhooks into Delivery Synchronization while retaining polling controls/history. |
| `client/src/main.jsx`, `client/src/pages/Settings.jsx` | Updates navigation labels for the unified page. |
| `server/test/abexWebhooks.test.js` | Receiver, database, worker, delivery/finance, recovery and authorization tests. |
| `scripts/webhook-browser-check.js` | Isolated desktop/mobile monitoring and retry regression. |
| `scripts/abex-webhook-smoke.js` | Explicit signed transport smoke command without printing credentials. |
| `package.json` | Adds the webhook browser validation command. |
| `server/package.json`, `package-lock.json` | Pins `standardwebhooks` 1.3.0 and its two transitive dependencies. |
| `.env.example` | Documents safe webhook defaults. |
| `README.md`, `docs/abex-tms.md`, `docs/abex-webhooks.md` | Architecture audit, contract evidence, operational setup, cutover and rollback. |

## Release limitations

The ABEX topic/payload contract, real provider retries/rotation behavior, deployed HTTPS/reverse-proxy routing and live delivery acceptance remain unverified. No production deployment or polling cutover was performed. The per-process receiver limit is not a distributed rate limiter.

`npm audit --json` also reports one pre-existing high-severity dependency entry for Mongoose `8.24.4` (already pinned in the original lockfile), including [GHSA-gg4r-jv3p-qx3c](https://github.com/advisories/GHSA-gg4r-jv3p-qx3c), [GHSA-wr5m-5jph-8m96](https://github.com/advisories/GHSA-wr5m-5jph-8m96), [GHSA-8332-j7wj-wjw4](https://github.com/advisories/GHSA-8332-j7wj-wjw4), and [GHSA-6972-9mcm-vhwj](https://github.com/advisories/GHSA-6972-9mcm-vhwj). This feature validates/allowlists incoming fields and does not upgrade unrelated dependencies; dependency remediation remains a release consideration.
