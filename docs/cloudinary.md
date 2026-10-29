# Cloudinary image storage

New order images and Tracking report attachments use the official `cloudinary` Node.js SDK. Set these **backend-only** variables in the root `.env` or deployment environment:

```dotenv
CLOUDINARY_CLOUD_NAME=your-cloud-name
CLOUDINARY_API_KEY=your-api-key
CLOUDINARY_API_SECRET=your-api-secret
```

Do not use `VITE_` prefixes, an unsigned upload preset, browser SDK credentials, or frontend environment files. Use a separate Cloudinary product environment in staging. The backend needs outbound HTTPS access to `api.cloudinary.com` and `res.cloudinary.com`. Enable authenticated image delivery and signed transformations in the Cloudinary environment; validate both original and transformed previews in staging. Uploads use `type: authenticated`, `resource_type: image`, `overwrite: false`, server-generated UUID public IDs, and `logix-crm/orders` or `logix-crm/issues` folders. The SDK generates signatures on the server.

Missing configuration returns a safe 503 for new uploads; other CRM operations and legacy previews continue. Provider upload errors return a safe 502 and do not change existing references. There is no fallback to local disk for new uploads. A MongoDB replica set is required for transactions, as in the existing CRM.

## UI and API

Order creation/edit keeps its existing optional image picker and post-save upload flow. Order details reuses the image strip and existing Field/ErrorBox/Panel components for upload, preview, replacement and removal. Tracking's existing Reports modal has an Attachments section per report; submit the report as usual, then attach images there. These media operations do not change stages, report resolution, issue counters, shipment actions or financial data.

| Resource | Collection route | Image route |
| --- | --- | --- |
| Order images | `/api/order-media/:orderId` | `/api/order-media/:orderId/:imageId` |
| Report attachments | `/api/issue-media/:orderId/:issueId` | `/api/issue-media/:orderId/:issueId/:imageId` |

Collection GET returns `{ revision, images }`; POST uploads one image. Image GET previews it; PUT replaces it while retaining its image ID and position; DELETE removes the reference. POST/PUT accept multipart `image` and `expectedRevision`; DELETE accepts JSON `{ expectedRevision }`. The revision is the **order revision**, including for reports. Stale requests return 409. Mutation responses include the new revision and preview URLs. Previews optionally accept `?thumbnail=true`.

Existing sessions, origin checks, rate limits and business scopes apply. Order uploads retain the original five-minute creator allowance; replacement/removal require the existing order update-own/update-all permission. Report reads require Tracking scope and `tracking.issue.view`. Reporters with `tracking.issue.create` can manage their own report attachments; users with `tracking.issue.resolve` can manage attachments on reports in their existing Tracking scope. No roles or permissions are added or changed.

At most six JPEG/PNG/WebP images per order or report, each at most 5 MiB and 25 megapixels. Sharp checks actual content against MIME, fully decodes the image, strips metadata, rotates, resizes within 1600×1600 and encodes WebP. SVG, malformed content, oversize files, extra multipart fields and arbitrary public IDs/URLs are rejected. MongoDB stores `public_id`, `secure_url` and metadata (format, dimensions, byte count, checksum, upload actor/time, version/type), never image bytes or credentials.

Previews use the original authenticated CRM routes, including for migrated images. The backend generates signed authenticated Cloudinary delivery URLs, streams the result, and sends `private, no-store`. Signed URLs never reach the browser. This preserves immediate session/business-scope checks instead of exposing reusable CDN links. Uploads eagerly generate bounded WebP variants (320px thumbnails/1600px previews) with `q_auto`, using exactly the same transformation chains as delivery. Cloudinary authenticated assets require these eager variants; dynamic `f_auto` delivery is deliberately avoided. Preview-generation failure leaves the new upload unreferenced for cleanup. The stored `secure_url` is a canonical unsigned URL, so it cannot bypass authenticated delivery.

## Safe migration and verification

1. Back up MongoDB **and** the entire existing image volume together. Keep `MEDIA_STORAGE_DIR` pointing to that volume on every API replica (default `server/storage/order-images`). Deploy the dual-read code with the Cloudinary configuration. Do not delete local files or deploy old local-only code after new Cloudinary uploads begin.
2. Run the dry run in staging, then production. It validates references/content without remote uploads or DB mutations:

   ```sh
   npm run media:migrate
   ```

3. Inspect the per-image JSON records and summary. Missing, invalid or unsafe local references are failures; recover those files from backups before proceeding. Apply explicitly:

   ```sh
   npm run media:migrate -- --apply
   ```

   The command processes both orders (including trash) and reports (including resolved reports). For each image it uploads to a fresh UUID, downloads the authenticated original and checks its SHA-256 before a transaction adds Cloudinary metadata. Existing image IDs, local `key`, upload actor/time and source files are retained. Concurrent changes are checked again in the transaction; failures retain the original reference. Successful images are skipped on reruns. Only image metadata, optimistic versions and order revision change. Capture stdout as the migration manifest; keep it with the backups. A nonzero exit code or nonzero `failed` count means migration is incomplete.

4. Run a fresh full verification:

   ```sh
   npm run media:migrate -- --verify
   ```

   This downloads each Cloudinary original and checks its stored checksum. Any remaining legacy-only reference or missing/corrupt Cloudinary asset fails verification. Verification does **not** silently accept the local fallback. Also sample historical order/Tracking previews, replacements, removals and restricted-user access in the UI.
5. Keep backups, local files and the legacy adapter until full verification and an agreed retention window have completed. This release deliberately does not remove the old adapter or provide an automatic local-file purge. A later reviewed change may retire it after production verification. A migrated preview can still fall back to its retained local file if Cloudinary is unavailable.

Rollback: keep this dual-read version running, stop maintenance jobs, and use the manifest plus a current database backup to target only affected migrated image subdocuments. Clear their Cloudinary fields while retaining `_id`, `key`, uploader/time and current order/report data; increment optimistic/order revisions. Confirm the local previews first. Queue any now-unused Cloudinary public IDs for reference-checked cleanup. Never restore an old whole-database snapshot over newer orders or roll back to a version that cannot read Cloudinary-only uploads. Do not reintroduce removed public IDs while cleanup is running. No production migration is run by install/build/start or tests.

## Asset cleanup and failures

Every upload gets a durable `MediaCleanup` outbox record **before** the remote call. The successful attachment transaction removes it. Failed uploads, interrupted requests, verification failures and failed/ambiguous Mongo commits leave the record with a 24-hour grace period, covering assets the provider may have stored despite a timeout. No catch block blindly deletes a possibly committed image.

Replacement/removal queues the previous asset in the same Mongo transaction as the reference change. The backend checks the queue every minute (up to 50 records), with a five-minute worker lease. It checks references in **all** order images and report attachments, including soft-deleted orders and resolved reports. Only an unreferenced managed public ID is destroyed using the SDK, with CDN invalidation. Shared assets are retained and rechecked the following day. Failed deletes retain a retry record (`attempts`, `notBefore`); storage errors do not undo a completed CRM action. Local legacy files are never deleted by this queue.

For operational recovery, run one bounded cleanup pass:

```sh
npm run media:migrate -- --cleanup
```

Monitor failed/deferred queue counts and the backend's cleanup warning. Keep the server process running or invoke the command periodically. Cleanup is eventually consistent; removing an image detaches it immediately, while provider deletion happens on a later successful pass. Only fresh server-generated IDs can be attached by the API; clients cannot restore/share arbitrary existing public IDs. Manual DB edits/imports that reintroduce IDs must be coordinated with maintenance.

## Validation

`npm test` includes focused media integration tests against a disposable MongoDB replica set. SDK upload/destroy and remote image bytes are mocked; validation, authentication, authorization, Mongo transactions, queue recovery and migration run for real. Tests cover MIME spoofing, SVG/size limits, missing config, unauthorized uploads/deletes/previews, origin checks, stale writes, failed uploads, shared references, deleted orders, retries/concurrent workers, migration idempotency/checksums/fallback and signed optimized delivery URLs.

`npm run test:tracking-browser` exercises the real browser against the same fake external boundary, including order uploads and report attachments, replacements/removals and existing workflows. Run `npm run lint`, `npm test`, `npm run build`, and the browser checks before release. Real Cloudinary credentials are still required for a staging smoke test of upload, transformed preview, replacement and deletion; mocks cannot establish account capability or network access.

SDK references: [Node.js uploads](https://cloudinary.com/documentation/node_image_and_video_upload), [Upload/destroy API](https://cloudinary.com/documentation/image_upload_api_reference), [image optimization](https://cloudinary.com/documentation/image_optimization).
