# ABEX inbound webhooks

Implementation status: secure receiver, durable inbox, worker, targeted-refresh integration, admin monitoring and recovery are implemented. **The two parcel notification topics below are verified from real ABEX portal deliveries and are supported by the adapter. Cron can remain disabled; targeted webhook reads are paced and yield to order intake. Validate an approved live event before relying on webhook coverage.** No live destination, signing secret, production setting or shipment was changed during implementation or read-only contract inspection.

## Verified contract and live acceptance

The configured destination is `00c7191e-83b7-43dd-beda-9d5425cf51d3`, subscribed to All topics, at `https://crm.tamqo.com/api/webhooks/delivery/abex`. Reuse it; do not recreate it or change its URL. The destination ID comes from server configuration, not a presumed incoming header or payload field.

On 2026-11-21, the [ABEX public OpenAPI](https://app.abex.clawdyatms.app/swagger/public-v1/swagger.json) was fetched successfully. It describes supplier webhook endpoint CRUD, headers and signing-secret retrieval. It does not define outbound topic names, event envelopes, parcel identifiers in delivery events, or event timestamps. The [API Tokens portal](https://app.abex.clawdyatms.app/api-rest/tokens) returned a Cloudflare challenge. Searches did not supply verified ABEX payload examples. Documentation from other TMS providers is not evidence of the ABEX contract.

Signing follows the [official Standard Webhooks specification](https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md), using the maintained [`standardwebhooks` JavaScript implementation](https://github.com/standard-webhooks/standard-webhooks/tree/main/libraries/javascript), pinned to package version `1.3.0`. The signing standard does not establish ABEX's payload schema.

On 2026-11-22 the user supplied a delivery link and the authenticated ABEX portal was inspected read-only. These actual delivery records establish the supported notification subset:

| Topic | Provider evidence |
| --- | --- |
| `parcel.state.situation.created` | [Delivery f9179308](https://webhooks.abex.clawdyatms.app/destinations/00c7191e-83b7-43dd-beda-9d5425cf51d3/deliveries/f9179308-7e45-4c7a-990b-64567878e805) |
| `parcel.state.updated` | [Delivery b100a51a](https://webhooks.abex.clawdyatms.app/destinations/00c7191e-83b7-43dd-beda-9d5425cf51d3/deliveries/b100a51a-40da-4cca-b714-7f6d3b60b6fc) |

Both signed JSON bodies have `eventType`, ISO-offset `occurredAt`, and a `data` snapshot containing `id` (parcel UUID) and `trackingNumber`. The parser requires a valid UUID and occurrence timestamp for supported topics, validates tracking when present, and discards every other snapshot field. The stored contract version is `abex-parcel-notification-2026-11-22-v1` with `contractVerified: true`. Event names are read from the signed body; an unsigned topic header cannot select a shipment. This validation is based on observed ABEX integration evidence, not a claim that the public OpenAPI documents every event.

No customer values, live parcel IDs, tracking numbers, order references, signatures or signing secrets were copied into fixtures. The tests use the observed envelope with generated/redacted data. Body `data.state`, `situation`, amounts, `externalId`, tenant or agency fields never drive business changes; the existing authenticated parcel GET and workflow mappings remain authoritative. `eventOccurredAt` is retained only for inspection; observation ordering uses the freshly fetched parcel timestamps.

The portal also lists `parcel.isReturn.updated`, `courier.state.updated` and `webhook.test`. Their business payload contracts are not established by these two deliveries; they and all other unsupported topics are acknowledged and recorded as `IGNORED / WEBHOOK_UNKNOWN_EVENT`. A malformed supported notification is retained as `FAILED / WEBHOOK_SCHEMA_INVALID`. The destination remains subscribed to All topics.

### Situation response validation correction

On 2026-11-22 the reported failed event was matched read-only to [its ABEX delivery record](https://webhooks.abex.clawdyatms.app/destinations/00c7191e-83b7-43dd-beda-9d5425cf51d3/deliveries/1bf66776-6efd-4ef6-9826-0628966701d6). Its embedded `situation.id` and `lastStateSituationId` are different valid UUIDs, as in an earlier event for the same parcel. The public [ABEX OpenAPI schema](https://app.abex.clawdyatms.app/swagger/public-v1/swagger.json) independently defines `GetSupplierParcelResponse.lastStateSituationId` and `GetSupplierParcelResponse.situation` (`SituationDto`); it declares no equality constraint between their IDs. The shared parcel mapper incorrectly required equality and rejected this response shape as `ABEX_INVALID_RESPONSE`.

The mapper now validates each supplied UUID independently and keeps `lastStateSituationId` as the preferred workflow mapping reference. The embedded situation name remains display metadata; neither its name nor its metadata determines a CRM transition. Existing parcel UUID, tracking, order reference, tenant, date, workflow and production/finance checks remain in place. This does not make webhook snapshots authoritative: processing still fetches the current authenticated parcel and applies the shared delivery service. No production parcel GET or business mutation was performed during the read-only diagnosis, so a deployment plus an audited event retry is still required to verify live recovery. Cron can remain disabled.

After deploying this correction to every backend, open a failed supported event in Delivery Synchronization and use **Retry event**. The existing scoped recovery path fetches current state, preserves the event ID, increments the recovery count, and never forces a saved snapshot. HTTP 200 from the destination portal proves inbox receipt only. Confirm `PROCESSED` and the corresponding CRM shipment after the worker finishes; other identity, mapping, production or provider failures still require their own review.

To accept the deployed feature:

1. Deploy/restart every backend and rebuild the client. Configure the correct existing CRM ABEX agency ObjectId, valid signing secret and processing enablement. Keep Cron disabled when provider-wide polling affects order intake.
2. In Delivery Synchronization, verify the two supported topics and enablement, then observe an approved pilot notification reaching `PROCESSED` and the corresponding existing order matching its current authenticated ABEX state. HTTP 200 alone proves inbox acceptance, not business processing.
3. Investigate `FAILED`, `RETRY_PENDING`, identity, production-readiness or unmapped-status outcomes through the existing review/reconciliation tools. Never force an order transition or infer cash collection from a notification.
4. Unknown/new topics need their own verified contract before extending the allowlist. Missed notifications and unmatched shipments need individual review; webhook-only mode cannot guarantee recovery of events ABEX never delivered.

The original receiver stored unverified events only as hashes/metadata, so they cannot be reparsed from CRM history alone. After deployment, the ABEX delivery portal's **Retry** action can supply a fresh authenticated copy of a supported body. The receiver can atomically reclassify an old `unverified / ABEX_CONTRACT_UNVERIFIED` record in `IGNORED` or unclaimed `RECEIVED` state only when the event ID, raw body hash and original agency binding match. It preserves the unique record and total attempt count, clears only the old terminal metadata and queues the supported refresh. It never upgrades an event that already had delivery effects or redirects it to a different agency. An active old claim returns retryable `503 / WEBHOOK_UPGRADE_BUSY`; retry once that lease/processing has completed. Different bytes under the same ID still return 409. Otherwise recover via manual sync or new notifications.

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
ABEX_WEBHOOK_REQUEST_INTERVAL_SECONDS=15
```

`ABEX_WEBHOOK_SECRET` must be `whsec_` plus canonical base64 encoding of at least 32 bytes. Use the **rotated destination signing secret from ABEX**, not its API token. `ABEX_WEBHOOK_AGENCY_ID` is the existing CRM ABEX agency's 24-character ObjectId. It is captured at reception; changing the binding does not redirect already accepted events to another agency. The destination UUID is mandatory when enabling reception. Enabled reception with an invalid/missing secret or destination aborts production startup and fails closed at request time. Invalid agency IDs abort startup too.

`ABEX_WEBHOOK_PROCESSING_ENABLED=true` enables inbox processing independently of `cronEnabled` and the receiver's enable flag (so reception can be paused while draining). A valid secret/destination configuration is still required. It does not verify or activate an unsupported provider contract. Polling's `DELIVERY_SYNC_ENABLED` / interval defaults and `ABEX_WRITES_ENABLED` keep their existing meanings.

## Deploy to crm.tamqo.com

1. Back up MongoDB and confirm it is a replica set with transaction support. Deploy the reviewed release through the normal deployment process.
2. Run `npm ci`, `npm run lint`, `npm test`, `npm run build`, and the browser checks listed below. Retain the existing session secret, credential encryption key, database URI, ABEX API credentials and frontend origin. Do not run the ABEX migration cutover again for webhook setup.
3. Obtain/rotate the destination signing secret through the existing ABEX destination UI or authorized provider support. The public API documents authenticated `GET /api/v1/webhooks/endpoints/{endpointId}/secret` for supplier admins. The inspected Settings page has a **Rotate** control and says the previous secret expires after 24 hours; no credential rotation was performed during inspection. Keep the destination and URL unchanged. Coordinate the environment update across all backend instances; use the provider's retry facility for deliveries during the switch.
4. Set `ABEX_WEBHOOK_ENABLED=true`, the real signing secret, the destination UUID, and its CRM agency ID. Set `ABEX_WEBHOOK_PROCESSING_ENABLED=true` to process supported notifications and surface health. Keep saved `cronEnabled=false` when bulk polling affects intake. Restart every backend instance. The process waits for the unique index before accepting requests and starts the independent inbox worker.
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
6. In **Settings → Delivery Synchronization**, check configuration, receiver enablement, supported topics, last reception, last processed delivery, worker scan and pending/failed counts. Configuration alone is not evidence of delivery health. Compare destination delivery receipts with persisted event IDs and hashes. A synthetic signed object proves transport/storage only; real supported delivery behavior requires the pilot acceptance above.

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

## Webhook operation with Cron disabled

The inbox worker is independent of the bulk delivery scheduler. Leave the saved Cron switch disabled; startup does not overwrite it. Confirm no new `CRON` runs across every backend after its next settings check (a running sync may finish). Supported updates share the authoritative business transaction, so concurrent manual reads do not duplicate transitions or return expenses.

All production ABEX clients share a MongoDB traffic row keyed by a SHA-256 digest of the API key/tenant scope; credentials are never stored there. Background reads reserve one request slot every 15 seconds by default, across workers and destinations. Set `ABEX_WEBHOOK_REQUEST_INTERVAL_SECONDS` to an integer from 5 to 30 to tune this conservative starting rate to the actual account quota. Invalid values use 15 seconds. This is an application budget, not a claim about ABEX's undocumented quota. Each actual background HTTP request, including workflow catalog pages, consumes a slot; background requests do not retry inline on failure. Active foreground requests reserve a 30-second quiet window for order intake and bypass background pacing. A request already in flight cannot be preempted. HTTP 429 cooldowns (numeric or HTTP-date `Retry-After`, default 60 seconds) are persisted with majority acknowledgement and respected by new clients/processes. Queue deferrals preserve the event without consuming its failure retry budget. Workflow catalogs are cached for ten minutes per agency configuration version and warmed before background parcel reads; foreground catalog loads never wait for an in-progress background load.

One successful fresh read completes already queued supported notifications for the same destination, agency, contract, parcel UUID and tracking. Notifications arriving after the refresh began, and claims owned by other workers, are excluded. Completion and all business effects are atomic. Each notification keeps its own durable history; covered rows show `WEBHOOK_COALESCED`.

Missing UUID links are repaired only for existing `ABEX` shipments with exactly matching saved tracking in the bound CRM agency. A known local UUID with missing tracking may use the signed tracking for its single targeted read. In both cases the authenticated response must match the notification UUID, tracking, CRM order number and returned tenant before the existing guarded transaction saves anything. Concurrent link changes invalidate the reservation and retry. Production readiness, parcel creation locks and normal status/finance rules still apply; no parcel/order is created and historical Procolis/manual/imported shipments are never relabeled.

If neither the parcel UUID nor saved tracking matches a CRM ABEX shipment, the worker makes **zero ABEX calls**. It retries the local lookup from five minutes with exponential backoff, bounded by the normal attempt budget. Verify the actual CRM order, its ABEX agency and its saved shipment tracking. External parcels without CRM orders cannot be linked automatically. After correcting a real CRM shipment, use the scoped event **Retry** action. Do not assign unrelated order numbers or change agency IDs to make an event match.

For webhook outages or gaps, inspect the provider delivery log and use authenticated redelivery or a per-order tracking refresh after quota recovery. Avoid Run Sync Now while rate limited because it remains a bulk operation. If rolling back code, retain inbox/traffic collections and indexes, stop the worker cleanly, and choose a recovery plan compatible with available API capacity. Do not enable bulk polling automatically or recreate parcels as recovery. Events outside the two verified topics, including changes with no subsequent supported notification, still need manual review.

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

Final validation on 2026-11-22 after adding targeted link recovery, intake-priority traffic protection and the situation response correction:

| Command | Actual final result |
| --- | --- |
| `npm run lint` | Passed. |
| `npm test` | 293 passed, 0 failed, 0 skipped; includes 85 webhook tests and 208 other tests. |
| `npm run build` | Passed. |
| `npm run test:webhook-browser` | Passed: signed reception, monitoring, pagination, filters, sanitized details, audited recovery and desktop/390px mobile layout. Screenshots inspected; long mobile values wrap. |
| `npm run test:delivery-browser` | Passed: ABEX parcel creation, edit confirmation, readiness, pending/rejected shipments and manual agency behavior. |
| `npm run test:readiness-browser` | Passed: production readiness, historical Procolis status/deletion behavior, protected APIs and mobile labels. |
| `git diff --check` | Passed. |
| `npm audit --json` (2026-11-21) | Nonzero exit: one pre-existing high-severity Mongoose dependency entry; no dependencies changed in the verified-adapter update. See release limitations. |

An intermediate future-timestamp fixture was moved from 301 to 360 seconds ahead to avoid entering the library's five-minute window while the test executed. Intermediate browser runs were rerun after the build completed and the responsive-navigation test waited for its collapsed state. The final results above use the corrected tests; no production rule was loosened.

The 2026-11-22 adapter tests use the production parser for both observed topics and exercise malformed payloads, unsigned topic headers, authoritative refresh rather than snapshot application, and concurrent authenticated reclassification of legacy ignored events. The initial malformed-data fixtures were corrected to preserve explicit missing/null values rather than supplying defaults. The webhook browser test uses port 4028 so it can run independently from the readiness suite on 4026; the latter was rerun successfully after diagnosing the shared-port collision.

The traffic-protection tests additionally verify shared cooldowns across new clients, numeric/HTTP-date Retry-After parsing, actual paced loopback HTTP reads, foreground interruption and warm-catalog recovery, retry-budget preservation under repeated deferrals, account isolation, catalog-version invalidation, concurrent link reservations, zero provider calls for unmanaged shipments, and twelve queued parcel notifications sharing one refresh and one return expense. The legacy rate-limit creation test now explicitly simulates quota recovery and checks that a fresh client cannot bypass a live cooldown. Initial failures exposed the old immediate-retry assumption and a stale repair reservation during concurrent polling; both were corrected before the final run.

The situation correction adds API-client coverage for distinct IDs, explicit workflow-situation precedence and continued malformed-ID/date rejection. Real loopback HTTP plus MongoDB tests cover a signed situation notification and audited recovery of an event previously failed as `ABEX_INVALID_RESPONSE`. The generated fixture reproduces only the structural distinction and optional scheduled-date metadata; no live customer or parcel values are stored in it.

## Changed file inventory

| File | Purpose |
| --- | --- |
| `server/src/app.js` | Mounts only the signed receiver before browser middleware and login. |
| `server/src/index.js` | Validates webhook configuration, awaits indexes, starts/drains the independent worker. |
| `server/src/models/deliveryWebhook.js` | Durable event model, uniqueness, lease/retention indexes and worker health. |
| `server/src/models/abexApiTraffic.js`, `server/src/services/delivery/abexApiTraffic.js` | Shared credential-scope pacing, intake priority and persistent provider cooldowns. |
| `server/src/routes/abexWebhookRoutes.js` | HTTP method/type/size/rate controls, authentication and durable acknowledgement. |
| `server/src/routes/deliveryWebhookAdminRoutes.js` | Scoped health/history/detail APIs and audited recovery. |
| `server/src/routes/deliverySyncRoutes.js` | Mounts the authenticated webhook monitoring routes. |
| `server/src/services/delivery/webhooks/webhookConfig.js` | Backend-only settings, safe defaults and fail-closed validation. |
| `server/src/services/delivery/webhooks/verifyAbexWebhook.js` | Official raw-byte signature verification, strict headers/timestamps and post-verification JSON decoding. |
| `server/src/services/delivery/webhooks/abexWebhookAdapter.js` | Verified two-topic provider adapter and internal notification validation. |
| `server/src/services/delivery/webhooks/webhookInboxService.js` | Majority-confirmed persistence/deduplication, atomic claims, durable attempts and retention. |
| `server/src/services/delivery/webhooks/webhookReconciliationService.js` | Resolves only a server-bound existing parcel and reads its authoritative state. |
| `server/src/services/delivery/webhooks/webhookProcessor.js` | Fenced worker, atomic completion with business effects, bounded retries and health. |
| `server/src/services/delivery/deliverySyncService.js` | Allows a shared transaction and adds stable observation result codes; retains existing status rules. |
| `server/src/services/delivery/abexClient.js`, `server/src/services/delivery/deliveryProviderFactory.js` | Apply the shared traffic policy to production ABEX clients and cache workflow reference data. |
| `client/src/pages/DeliveryWebhookEvents.jsx` | Configuration/reception/processing overview, filters, pagination, details and eligible retry. |
| `client/src/pages/delivery-webhooks.css` | Scoped wrapping of long identifiers and explanations on mobile. |
| `client/src/pages/DeliverySyncLogs.jsx` | Integrates webhooks into Delivery Synchronization while retaining polling controls/history. |
| `client/src/main.jsx`, `client/src/pages/Settings.jsx` | Updates navigation labels for the unified page. |
| `server/test/abexWebhooks.test.js` | Receiver, database, worker, delivery/finance, recovery and authorization tests. |
| `server/test/fixtures/abexWebhooks.js` | Generated/redacted fixtures using the envelope observed in ABEX's authenticated delivery portal. |
| `scripts/webhook-browser-check.js` | Isolated desktop/mobile monitoring and retry regression. |
| `scripts/abex-webhook-smoke.js` | Explicit signed transport smoke command without printing credentials. |
| `package.json` | Adds the webhook browser validation command. |
| `server/package.json`, `package-lock.json` | Pins `standardwebhooks` 1.3.0 and its two transitive dependencies. |
| `.env.example` | Documents safe webhook defaults. |
| `README.md`, `docs/abex-tms.md`, `docs/abex-webhooks.md` | Architecture audit, contract evidence, operational setup, cutover and rollback. |

## Release limitations

Two parcel topic/payload shapes were verified read-only from the provider portal. Other topics, provider retry timing, credential-rotation behavior in practice and end-to-end live business processing remain unverified. The portal shows existing CRM HTTP 200 receipts, which confirms reception rather than delivery effects. No production polling cutover or live customer mutation was performed. The per-process receiver limit is not a distributed rate limiter.

`npm audit --json` also reports one pre-existing high-severity dependency entry for Mongoose `8.24.4` (already pinned in the original lockfile), including [GHSA-gg4r-jv3p-qx3c](https://github.com/advisories/GHSA-gg4r-jv3p-qx3c), [GHSA-wr5m-5jph-8m96](https://github.com/advisories/GHSA-wr5m-5jph-8m96), [GHSA-8332-j7wj-wjw4](https://github.com/advisories/GHSA-8332-j7wj-wjw4), and [GHSA-6972-9mcm-vhwj](https://github.com/advisories/GHSA-6972-9mcm-vhwj). This feature validates/allowlists incoming fields and does not upgrade unrelated dependencies; dependency remediation remains a release consideration.
