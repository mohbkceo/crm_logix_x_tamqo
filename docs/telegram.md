# Telegram operations bot

The CRM can post a compact notification to Telegram for every order created in
the CRM, and lets linked team members look up orders and change their status
from Telegram. The CRM stays the source of truth: every Telegram action runs the
same business rules, permissions, audit log and concurrency checks as the web app.

## 1. Create the bot

1. In Telegram, open **@BotFather** and send `/newbot`.
2. Choose a display name and a username ending in `bot`.
3. BotFather replies with a token like `123456789:ABC…`. Treat it as a password.
4. Optional but recommended for groups: send `/setprivacy` to BotFather, choose
   your bot, then **Disable**. With privacy enabled, the bot only sees commands
   addressed to it explicitly (for example `/chatid@YourBot`).

## 2. Connect the token

Settings → **Telegram** → *Bot connection*:

1. Paste the token and press **Save & Connect**.
2. The server checks it with Telegram (`getMe`), encrypts it, configures the
   webhook automatically, and registers the command menu.
3. The card shows the bot username, the connection status and whether the
   webhook is configured.

The token is never shown again. To change it, press **Replace token**; leaving
the field empty keeps the stored token. **Disconnect bot** removes the stored
token and the webhook (destinations and linked accounts are kept).
**Test connection** re-checks the bot and repairs the webhook if needed.

Requirements on the server:

| Variable | Purpose |
| --- | --- |
| `DELIVERY_CREDENTIALS_ENCRYPTION_KEY` | Existing 64-hex-character key, reused to encrypt the bot token (AES-256-GCM). Saving a token is refused without it. |
| `CLIENT_URL` | Public application URL. Used for **Open Order** buttons (`/orders/:id`) and as the webhook base. |
| `TELEGRAM_WEBHOOK_BASE_URL` | Optional. Overrides the webhook base when the API is reached on a different public origin than the frontend. |

Telegram only delivers webhooks to **public HTTPS** addresses. The webhook path
is `<base>/api/webhooks/telegram`; the reverse proxy must forward it to the API.
Without HTTPS, notifications still work (they are outgoing), but commands and
buttons do not, and the Settings page shows a warning. **Open Order** buttons
appear only when `CLIENT_URL` is HTTPS.

The webhook is configured with a random `secret_token` (only its SHA-256 digest
is stored), only the `message` and `callback_query` update types, and without
dropping pending updates. Every request must carry a matching
`X-Telegram-Bot-Api-Secret-Token` header; anything else is rejected with 401.

## 3. Add groups (destinations)

1. Add the bot to the Telegram group. To post in a forum topic, also open that topic.
2. Send `/chatid` in the group or topic (or `/chatid@YourBot`).
3. The bot replies with the **Chat ID** (for example `-1001234567890`) and the
   **Topic ID** (or `Not applicable`). This works before the group is configured.
4. In Settings → Telegram → *Notification destinations*, press **Add destination**,
   paste the values, and tick the businesses this group should receive.
5. Press **Test**. A real test message is sent, which proves the bot can post there.

Routing uses the order's business type:

| Order | Sent to destinations whose businesses include |
| --- | --- |
| Logix only | Logix |
| Tamqo only | Tamqo |
| Partnership | Partnership |

Partnership orders are **not** sent to Logix or Tamqo groups unless those
destinations also tick *Partnership*. Several destinations may receive the same
business, and one destination may receive several.

## 4. What a notification looks like

Images (up to six) are sent first, as a single photo or an album, followed by:

```text
🆕 ORDER · #ORD-2026-000123

🟡 NEW

📦 Tracking: ABEX-123456

💰 11,400 DA | 3 Units

👤 Mohamed | Alger
📞 0550000000
```

Buttons: **Open Order**, **Update Status**, **Copy Tracking** (only when a
tracking number exists) and **Copy Phone**.

* Tracking comes from the courier shipment; it shows `Pending` until one exists.
* The amount is the order total including delivery; units are the sum of all item quantities.
* Images are read on the server (Cloudinary or legacy local storage) and uploaded
  to Telegram as files. Private image URLs are never sent.

Only orders created in the CRM order form notify. Excel imports never do.
Notifications are sent after the courier parcel has been created (and after the
images attached in the same form finished uploading), so the tracking number is
included when available.

### Reliability

Notifications are stored in a MongoDB outbox in the same transaction as the
order. A background worker sends them, retries network errors and Telegram
outages with backoff, and respects Telegram rate limits. A Telegram failure
never affects order creation. Permanent destination problems (bot removed,
missing rights, wrong Group/Topic ID) are not retried automatically; they appear
under **Advanced → Failed notifications** with a **Retry** button after the
problem is fixed.

## 5. Link employee accounts

Commands and buttons act as a real CRM user. Each employee links once:

1. In the CRM, open Settings → Telegram (or **My profile**) and press **Link my Telegram**.
2. Press **Open Telegram** (or send `/link CODE` to the bot in a **private chat**).
3. The bot confirms the link.

Codes are single-use, expire after 10 minutes, and are stored only as hashes.
A code posted in a group is invalidated. One Telegram account can be linked to
only one CRM user. Use **Unlink my Telegram** to remove the link. Disabled CRM
users lose Telegram access immediately.

Telegram usernames are never used for authorization—only the numeric Telegram
user ID linked through a code.

## 6. Commands

Hyphenated and underscore forms both work (`/week-production` = `/week_production`).

| Command | Result |
| --- | --- |
| `/start`, `/help` | Instructions and the command list |
| `/chatid` | Chat ID and Topic ID of the current group/topic |
| `/link CODE` | Link your CRM account (private chat) |
| `/today` | Orders created today (Africa/Algiers) |
| `/recent` | Latest 10 orders |
| `/pending-confirmation` | Orders with status NEW |
| `/order ORD-2026-000123` or `/order TRACKING` | One order with its buttons |
| `/production` | Orders currently in the *At Production* stage |
| `/week-production` | Created in the last 7 × 24 h and currently at production, longest in stage first |
| `/preparing`, `/ready-to-ship` | Orders in that production stage |
| `/shipped`, `/failed-delivery` | Orders with that order status |
| `/shipment-issues` | Shipments with courier **synchronization** errors (not delivery failures) |
| `/week-summary` | Last 7 days by status and business (order value, not realized revenue) |
| `/bot-status` | Integration health (Settings managers only) |

Lists show 10 orders per page; **Prev/Next** edit the same message. Results follow
the linked user's CRM permissions and business access.

### Update Status

The menu only lists actions the linked employee may perform on that order now:

* **Confirm** (`orders.confirm`) and **Mark Preparing** (`orders.prepare`), following the normal status rules.
* **Production stage** moves (Production / back to Preparing / Ready to Ship) using the Tracking permissions, operational roles, blocking reports and courier readiness checks.
* **Cancel** (`orders.cancel`), with a confirmation step, only when no courier parcel was requested. Orders with a parcel must be cancelled in the CRM, where provider cancellation is confirmed.

Buttons carry the order revision; if the order changed since the message was
sent, the action is refused and the message is refreshed. After a change, the
original notification(s) are updated in place—no new notification is sent.

## 7. Troubleshooting

| Symptom | Check |
| --- | --- |
| Test fails: *chat not found* | Group ID is wrong, or the bot is not in the group. Run `/chatid` again. |
| Test fails: *not a member* | The bot was removed. Add it back, then **Retry** failed notifications. |
| Test fails: *not allowed to send* | Give the bot permission to send messages and photos (or make it an admin). |
| Test fails: *forum topic not found* | Topic ID is wrong or the topic is closed. Run `/chatid` inside the topic. |
| *group was upgraded to a supergroup* | The Chat ID changed. Run `/chatid` and update the destination. |
| Bot ignores commands in a group | Disable privacy mode in BotFather, or use `/command@YourBot`. |
| Commands never answer | Webhook not configured: `CLIENT_URL`/`TELEGRAM_WEBHOOK_BASE_URL` must be public HTTPS and route `/api/webhooks/telegram` to the API. Press **Test connection**. |
| Buttons say “Link your Telegram account” | That person has not linked their CRM account, or their CRM user is disabled. |
