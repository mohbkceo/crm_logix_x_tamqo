# ABEX TMS migration

The public OpenAPI document declares version `1`, uses `1` as the path-parameter default, and identifies `https://app.abex.clawdyatms.app` as the server. The attached Swagger UI snapshot was used for endpoint discovery. The portal’s API Tokens guidance establishes token scopes, rate limits, and tracking-number lookup. [ABEX public OpenAPI](https://app.abex.clawdyatms.app/swagger/public-v1/swagger.json) · [ABEX API Tokens](https://app.abex.clawdyatms.app/api-rest/tokens)

## Operation mapping

| Legacy operation | ABEX v1 operation | CRM implementation |
| --- | --- | --- |
| `GET /token` | `POST /api/v1/parcels/search` with one result per page | Read-only connection test validates the tenant’s supplier parcel access and the response shape. |
| `POST /add_colis` | `POST /api/v1/parcels` | One parcel per saved CRM order. Verifies the returned UUID, external reference, tracking when present, and collection amount when returned. |
| `POST /lire` | `GET /api/v1/parcels/{trackingNumber}` | Manual and scheduled polling validate the parcel UUID, tracking, external reference, and returned tenant when present. |
| `POST /lire` for uncertain creation | `POST /api/v1/parcels/search`, followed by tracking lookup | Searches by keyword and requires one exact external reference match. An empty search leaves the attempt unresolved. Admins can link a verified tracking number. |
| `POST /pret` | `POST /api/v1/workflows/search` and `PATCH /api/v1/parcels/{parcelId}/state` | Checks the current workflow and its declared transition. Sends one PATCH and requires a fresh matching parcel read before committing CRM readiness. |
| `POST /tarification` | `GET /api/v1/delivery-pricing/rates` and `/rates/{toTerritoryId}` | Read-only effective rates. The existing Rates modal fetches the provider's list on request. CRM rates and order charges remain stored separately. |
| Local Wilaya and manual provider lookup | `POST /api/v1/territories/search`, `/hubs/search`, `/products/search`, and `GET /api/v1/delivery-pricing/rates/stock-origins` | Resolves commune IDs by the wilaya's official code and the commune's ABEX parent territory. Also supports restricted hub, product, and rate-origin lookups. |
| Manual parcel changes or deletion | Parcel PATCH endpoints, modification requests, and `DELETE /api/v1/parcels/{id}` | Existing portal confirmation remains available. Automatic changes and deletion are disabled because the provider's state restrictions, approval rules, and deletion effects are unspecified. |
| Scheduled polling | Webhook endpoint management | Polling remains active. The portal describes Standard Webhooks signatures. The published API does not specify event names, delivery payloads, or stable parcel-event identifiers. |

The API exposes both UUID and tracking-number lookup under the same URL template. The CRM uses the tracking-number lookup described in API Tokens and verifies the returned UUID independently. The authenticated behavior of UUID lookup, global search, and external-reference keyword coverage still needs account validation. Bulk creation has a documented schema but the CRM creates one parcel per order reservation. State and situation history endpoints were inspected. The CRM orders observations by parcel timestamps and does not submit situation-history mutations. ABEX exchange creation requires the original ABEX parcel UUID and can create an additional return parcel. The CRM’s exchange checkbox contains no original parcel reference, so this operation remains a portal workflow.

## Prepare and cut over

1. Deploy with `ABEX_WRITES_ENABLED=false` and retain the existing `DELIVERY_CREDENTIALS_ENCRYPTION_KEY`. Normal startup leaves existing agency credentials and the active provider unchanged. A fresh database creates an ABEX TMS agency.
2. Take a database backup. Drain every CRM API worker and scheduler connected to the database so the existing Procolis integration finishes its in-flight operations. A worker running the old release will mark ABEX shipments with `Unsupported provider` on its next sync. Before the switch, identify production orders that still need Procolis readiness and complete or arrange those with the courier.
3. Run `npm run migrate -- --abex` against the intended database. The cutover keeps the agency ID, order references, per-Wilaya prices, shipments, tracking numbers, and audit history. It retains encrypted Procolis credentials separately and resets the active agency's credential flag for ABEX setup. Pre-cutover rows using `ABEX` as a legacy provider label are normalized to `PROCOLIS`. A repeated cutover does not change the switched agency.
4. Start the CRM with writes paused. In **Delivery agencies**, replace the ABEX key and enter the tenant ID from API Tokens. The public OpenAPI lists `X-Api-Key` and Bearer authentication together, while the portal’s API token flow issues a secret key and tenant ID. The CRM sends `X-Api-Key` and `X-Tenant`, plus `Authorization: Bearer …` when a separate bearer credential is configured. Run **Test connection** before enabling writes. An active supplier account must confirm the accepted credential combination and role. Rotate by submitting new credentials for the same tenant.
5. Retrieve the agency’s catalog and verify the territory hierarchy, pickup hub, and workflow states. Use the restricted `GET /api/delivery-agencies/{agencyId}/provider-catalog/{catalog}` with `territories`, `hubs`, `products`, `workflows`, or `stock-origins`. Search catalogs accept `keyword`, `pageNumber`, and `pageSize`. Product UUID mappings are optional and apply when ABEX manages stock for every physical item on the parcel.
6. Save the mappings with an authenticated `PATCH /api/delivery-agencies/{agencyId}` using the existing agency update permission. The following are placeholders for values from your account. Preserve the other agency configuration fields if you update `config`.

   ```json
   {
     "config": {
       "abex": {
         "destinations": [
           {
             "wilayaId": "<CRM Wilaya ObjectId>",
             "commune": "<CRM commune>",
             "cityTerritoryId": "<ABEX city territory UUID>",
             "districtTerritoryId": "<ABEX district territory UUID>",
             "hubId": "<ABEX pickup point UUID>"
           }
         ],
         "products": {
           "<CRM product ObjectId>": "<ABEX product UUID>"
         },
         "states": [
           {
             "workflowId": "<ABEX workflow UUID>",
             "stateId": "<ABEX state UUID>",
             "status": "PREPARING"
           },
           {
             "workflowId": "<ABEX workflow UUID>",
             "stateId": "<ABEX ready state UUID>",
             "status": "READY_TO_SHIP"
           }
         ]
       }
     }
   }
   ```

   Home delivery uses the ABEX commune catalog for the selected wilaya. The CRM resolves the wilaya by its official code and accepts only a uniquely matching commune under that parent. Existing destination overrides use the local Wilaya ID and commune. Add a hub UUID for stop-desk shipments. An optional `situationId` scopes a mapping to a specific situation within a state. A readiness target needs a state-level mapping, a direct transition from the observed preparation state, and an empty requirements list. Unmapped or ambiguous states appear in sync logs and preserve the prior CRM status.

7. Use the agency test, catalog and rates reads to verify access. Validate the home and stop-desk payloads, prepaid and mixed amounts, search coverage, and readiness on a non-production supplier account or an approved pilot. After this validation, set `ABEX_WRITES_ENABLED=true` and restart. An order saved while writes were paused can use **Retry shipment** if it has no external attempt.

## Operations and rollback

- **Parcel payload.** Customer phone numbers use the CRM’s normalized `+213` format. Fully mapped parcels use `stockType: "local"` with their catalog UUIDs. If a physical item is unmapped, all physical items use the supplier portal’s manual entry format in `orderedProducts`. Each line has a name, quantity, `unitPrice: 0`, and `stockType: "none"` without a catalog ID. The description carries the order note and item specifications. The collection amount comes from the CRM payment balance. [ABEX supplier portal form](https://app.abex.clawdyatms.app/assets/ParcelSituationTabs-BWdpqYni.js)
- **Validation rejections.** The CRM retains the HTTP status and any recognized validation fields. A tracking refresh keeps those diagnostics available while it reconciles the original attempt.
- **Uncertain create.** If the creation response is incomplete, the CRM searches by order reference and verifies the parcel identity and collection amount before linking it. If verification is still pending, use **Refresh tracking** or verify the tracking in the portal and use **Reconcile shipment**. An admin can confirm parcel absence to unlock a fresh attempt only when the shipment has no accepted parcel ID or tracking.
- **Uncertain readiness.** Refresh tracking after the provider shows the intended state. When the refresh verifies the pending target, use **Ready to Ship** again to finalize the CRM stage without another PATCH. If the provider still shows the source state or a different state, review the operation with the courier.
- **Historical Procolis shipments.** Tracking uses the separately retained Procolis credentials or the existing server fallback, if configured. Historical Procolis writes are unavailable after cutover. ABEX reads require an exact CRM reference, so historical tracking numbers are not submitted to ABEX. Missing historical access is reported in sync diagnostics.
- **Pause.** Set `ABEX_WRITES_ENABLED=false` and restart the workers. ABEX tracking, read-only reconciliation, and existing local records remain available.
- **Restore the legacy agency configuration.** Before any ABEX parcel attempt, drain the workers, verify there are no ABEX parcel IDs, tracking numbers, or unresolved creation/readiness reservations, and restore the pre-cutover agency configuration and encrypted credentials for that same ID from the backup. Leave orders, rates, and shipments intact. After an ABEX parcel attempt, keep this release and pause writes while reconciling. Switching the agency back to Procolis at that point would remove the ABEX tracking path.

## Security and verification

ABEX requests are pinned to the documented HTTPS host, forbid redirects, have bounded timeouts, and retry eligible reads at most once. When an ABEX rate limit supplies a long `Retry-After`, the caller receives a sanitized rate-limit error. Parcel writes have no automatic retries. The CRM saves only selected provider fields and redacts configured credentials from diagnostics. Legacy and ABEX secrets use separate AES-256-GCM ciphertext fields and are excluded from API responses.

The OpenAPI download returned HTTP 200 and an unauthenticated profile read returned HTTP 401. Authenticated catalog reads verified wilaya code and parent territory filtering. A read-only lookup verified a live parcel created with manual product lines, including its CRM reference, tracking number, and collection amount. The automatic recovery path is covered by integration tests. Account workflow IDs and legacy parcel accessibility still require live verification. The automated suite uses disposable databases and mocked or loopback courier responses.

| Command | Result |
| --- | --- |
| `npm run lint` | Passed. |
| `npm test` | 182 passed, including 15 ABEX integration tests. |
| `npm run build` | Passed. |
| `npm run test:delivery-browser` | Passed against a loopback ABEX courier, including creation, readiness, pending and rejected shipments, and manual delivery. |
| `npm run test:readiness-browser` | Passed the existing pre-cutover production readiness and Procolis tracking checks. |
| `npm run test:tracking-layout-browser` | Passed. |
| `npm run test:browser` | Stopped at a fixture expecting readiness for an unlinked physical order. The same readiness prerequisite exists on `main`. |
| `npm run test:tracking-browser` | Stopped at the English Tracking heading. The Tracking heading on `main` is Arabic. |

## Changed files

| File | Change |
| --- | --- |
| `server/src/services/delivery/abexClient.js` | Added v1 HTTP client, authentication, error handling, parcel reads and writes, workflow verification, and catalog reads. |
| `server/src/services/delivery/abexMapper.js` | Added order and parcel mapping, identity validation, workflow status mapping, and the write flag. |
| `shared/abexTerritories.js` | Added commune name matching shared by the order form and parcel preparation. |
| `server/src/services/delivery/deliveryClient.js` | Restricted the historical Procolis adapter to reads after cutover. |
| `server/src/services/delivery/deliveryProviderFactory.js` | Selects the active or historical provider and reports readiness capabilities. |
| `server/src/services/delivery/deliveryService.js` | Routes creation, reconciliation, and sync by shipment provider and records provider diagnostics. |
| `server/src/services/delivery/deliverySyncService.js` | Reuses shipment reservations and adds ABEX identity, ordering, and readiness checks. |
| `server/src/services/orderService.js` | Detects changes to ABEX parcel data and preserves parcel references in agency-change history. |
| `server/src/services/trackingService.js` | Applies provider-aware readiness and preserves production ownership and historical tracking links. |
| `server/src/models/delivery.js` | Stores ABEX agency configuration, separate encrypted legacy credentials, and sync provider metadata. |
| `server/src/models/index.js` | Stores ABEX parcel, workflow, state, and pending readiness fields. |
| `server/src/migrate.js` | Seeds new ABEX agencies and adds the explicit, repeatable cutover. |
| `server/src/routes/agencyRoutes.js` | Validates settings and credentials, tests connections, and exposes authorized catalog and rate reads. |
| `server/src/routes/orderRoutes.js` | Computes readiness eligibility and validates the readiness request revision. |
| `server/src/app.js` | Uses the selected ABEX agency for Settings status and connection testing. |
| `client/src/pages/Agencies.jsx` | Adds ABEX credential rotation and read-only rate lookup to the existing screens. |
| `client/src/pages/Settings.jsx` | Shows ABEX configuration, write status, connection testing, and manual sync. |
| `client/src/pages/Orders.jsx` | Displays the parcel UUID and provider-specific reconciliation instructions. |
| `client/src/pages/Tracking.jsx` | Displays Arabic ABEX sync and mapping diagnostics. |
| `client/src/pages/DeliverySyncLogs.jsx` | Displays the provider and distinguishes skipped observations. |
| `server/test/integration.test.js` | Adds ABEX contract, reservation, finance, readiness, and migration coverage. |
| `scripts/delivery-browser-check.js` | Exercises ABEX creation and readiness against a loopback courier. |
| `.env.example` | Documents the write flag and legacy-only credential fallback. |
| `README.md` | Updates shipping behavior and links to the rollout guide. |
| `docs/tracking.md` | Updates production and historical tracking behavior. |
| `docs/abex-tms.md` | Added the operation mapping, configuration, cutover, rollback, and verification report. |
