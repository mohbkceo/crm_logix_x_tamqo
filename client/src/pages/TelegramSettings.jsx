import { useState } from "react";
import {
  Send,
  ShieldCheck,
  Plus,
  Pencil,
  Trash2,
  Link2,
  Unlink,
  Copy,
  RefreshCw,
  Check,
  Info,
} from "lucide-react";
import { api, useApi, date } from "../api";
import { P, can, useUser } from "../access";
import { Panel, ErrorBox, Field, Modal, Badge, Empty } from "../components";
import "./telegram.css";

const BUSINESS_OPTIONS = [
  ["LOGIX_ONLY", "Logix"],
  ["TAMQO_ONLY", "Tamqo"],
  ["PARTNERSHIP", "Partnership"],
];
const businessLabel = (b) => BUSINESS_OPTIONS.find(([v]) => v === b)?.[1] || b;
const when = (d) =>
  d
    ? `${date(d)} ${new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Africa/Algiers" }).format(new Date(d))}`
    : "—";
const blankDestination = {
  name: "",
  chatId: "",
  messageThreadId: "",
  businessTypes: [],
  enabled: true,
};

export function TelegramSettings() {
  const user = useUser();
  const manage = can(user, P.settings.manage);
  const settings = useApi("/settings/telegram");
  const [state, setState] = useState(null);
  const data = state || settings.data;
  const [token, setToken] = useState("");
  const [replacing, setReplacing] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [editing, setEditing] = useState(null);
  const [confirm, setConfirm] = useState(null);

  async function run(key, path, options, success) {
    setBusy(key);
    setError("");
    setMessage("");
    try {
      const result = await api("/settings/telegram" + path, options);
      if (result?.destinations) setState(result);
      if (success) setMessage(success);
      return result;
    } catch (e) {
      setError(e.message);
      // Test failures update stored diagnostics; show them too.
      settings.reload();
      setState(null);
      return null;
    } finally {
      setBusy("");
    }
  }
  async function connect(e) {
    e.preventDefault();
    const result = await run(
      "connect",
      "",
      { method: "PUT", body: { token } },
      "Bot connected.",
    );
    if (result) {
      setToken("");
      setReplacing(false);
    }
  }
  async function saveDestination(e) {
    e.preventDefault();
    const { _id, name, chatId, messageThreadId, businessTypes, enabled } =
      editing;
    const body = {
      name,
      chatId: chatId.trim(),
      messageThreadId: String(messageThreadId ?? "").trim(),
      businessTypes,
      enabled,
    };
    const result = await run(
      "destination",
      _id ? `/destinations/${_id}` : "/destinations",
      { method: _id ? "PATCH" : "POST", body },
      _id
        ? "Destination updated."
        : "Destination added. Press Test to verify it.",
    );
    if (result) setEditing(null);
  }

  if (settings.loading && !data)
    return (
      <Panel title="Telegram">
        <p className="muted">Loading Telegram settings…</p>
      </Panel>
    );
  if (!data) return <ErrorBox error={settings.error} />;
  const showTokenInput = !data.configured || replacing;

  return (
    <div className="telegram-settings">
      <ErrorBox error={error} />
      {message && (
        <div className="success">
          <Check size={17} />
          {message}
        </div>
      )}

      <Panel
        title="Bot connection"
        subtitle="Order notifications and operational commands in Telegram."
        action={<Send size={20} />}
      >
        <div className="detail-body">
          <div className="integration-status">
            <span>Status</span>
            <Badge
              tone={
                data.configured
                  ? data.connected
                    ? "delivered"
                    : "failed_delivery"
                  : ""
              }
            >
              {data.configured
                ? data.connected
                  ? "Connected"
                  : "Connection problem"
                : "Not connected"}
            </Badge>
          </div>
          {data.configured && (
            <div className="integration-status">
              <span>Bot</span>
              <b>@{data.botUsername}</b>
            </div>
          )}
          <div className="integration-status">
            <span>Notifications</span>
            <Badge tone={data.enabled ? "delivered" : "cancelled"}>
              {data.enabled ? "Enabled" : "Disabled"}
            </Badge>
          </div>
          {data.configured && (
            <div className="integration-status">
              <span>Webhook (commands &amp; buttons)</span>
              <Badge
                tone={data.webhookConfigured ? "delivered" : "failed_delivery"}
              >
                {data.webhookConfigured ? "Configured" : "Not configured"}
              </Badge>
            </div>
          )}
          {data.configured && data.webhookError && (
            <p className="note telegram-warning">
              <Info size={15} />
              {data.webhookError}
            </p>
          )}
          {manage && showTokenInput && (
            <form className="telegram-token" onSubmit={connect}>
              <Field
                label="Bot token"
                hint="Create a bot with @BotFather in Telegram and paste the token it gives you. The token is encrypted on the server and never shown again."
              >
                <input
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  required
                  placeholder={
                    data.configured ? "Paste the new token" : "123456789:ABC…"
                  }
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                />
              </Field>
              <div className="row-actions">
                <button
                  className="primary"
                  disabled={busy === "connect" || !token.trim()}
                >
                  <ShieldCheck size={15} />
                  {busy === "connect" ? "Connecting…" : "Save & Connect"}
                </button>
                {replacing && (
                  <button
                    type="button"
                    onClick={() => {
                      setReplacing(false);
                      setToken("");
                    }}
                  >
                    Cancel
                  </button>
                )}
              </div>
            </form>
          )}
          {data.configured && !replacing && (
            <Field label="Bot token">
              <input
                readOnly
                value="••••••••••••••••••••••••"
                aria-readonly="true"
              />
            </Field>
          )}
          {manage && data.configured && (
            <div className="row-actions">
              {!replacing && (
                <button onClick={() => setReplacing(true)}>
                  Replace token
                </button>
              )}
              <button
                disabled={!!busy}
                onClick={() =>
                  run(
                    "test",
                    "/test-connection",
                    { method: "POST" },
                    "Connection verified.",
                  )
                }
              >
                <RefreshCw size={15} />
                {busy === "test" ? "Testing…" : "Test connection"}
              </button>
              <button
                disabled={!!busy}
                onClick={() =>
                  run(
                    "toggle",
                    "",
                    { method: "PUT", body: { enabled: !data.enabled } },
                    data.enabled
                      ? "Notifications disabled."
                      : "Notifications enabled.",
                  )
                }
              >
                {data.enabled ? "Disable" : "Enable"}
              </button>
              <button
                className="danger-text"
                disabled={!!busy}
                onClick={() => setConfirm({ kind: "disconnect" })}
              >
                Disconnect bot
              </button>
            </div>
          )}
        </div>
      </Panel>

      <Panel
        title="Notification destinations"
        subtitle="Each destination is one Telegram group or one forum topic. Orders go to every enabled destination whose businesses include the order's business."
        action={
          manage && (
            <button
              className="primary"
              onClick={() => {
                setError("");
                setEditing({ ...blankDestination });
              }}
            >
              <Plus size={15} />
              Add destination
            </button>
          )
        }
      >
        <div className="detail-body">
          {data.destinations.length === 0 ? (
            <Empty
              title="No destinations yet"
              text="Add a Telegram group to start receiving order notifications."
            />
          ) : (
            <ul className="telegram-destinations">
              {data.destinations.map((d) => (
                <li key={d._id}>
                  <div className="telegram-destination-head">
                    <b>{d.name}</b>
                    <Badge tone={d.enabled ? "delivered" : "cancelled"}>
                      {d.enabled ? "Enabled" : "Disabled"}
                    </Badge>
                  </div>
                  <dl>
                    <div>
                      <dt>Business</dt>
                      <dd>{d.businessTypes.map(businessLabel).join(", ")}</dd>
                    </div>
                    <div>
                      <dt>Group ID</dt>
                      <dd>
                        <code>{d.chatId}</code>
                        {d.chatTitle && (
                          <span className="muted"> · {d.chatTitle}</span>
                        )}
                      </dd>
                    </div>
                    <div>
                      <dt>Topic ID</dt>
                      <dd>
                        {d.messageThreadId ?? (
                          <span className="muted">None</span>
                        )}
                      </dd>
                    </div>
                    <div>
                      <dt>Last test</dt>
                      <dd>
                        {d.lastTestAt ? (
                          <>
                            {d.lastTestOk ? "✅ Delivered" : "⚠️ Failed"} ·{" "}
                            {when(d.lastTestAt)}
                          </>
                        ) : (
                          <span className="muted">Not tested</span>
                        )}
                      </dd>
                    </div>
                  </dl>
                  {d.lastTestOk === false && d.lastError && (
                    <p className="note telegram-warning">
                      <Info size={15} />
                      {d.lastError}
                    </p>
                  )}
                  {manage && (
                    <div className="row-actions">
                      <button
                        disabled={!!busy || !data.configured}
                        onClick={() =>
                          run(
                            "test-" + d._id,
                            `/destinations/${d._id}/test`,
                            { method: "POST" },
                            `Test message delivered to ${d.name}.`,
                          )
                        }
                      >
                        <Send size={14} />
                        {busy === "test-" + d._id ? "Sending…" : "Test"}
                      </button>
                      <button
                        onClick={() => {
                          setError("");
                          setEditing({
                            ...d,
                            messageThreadId: d.messageThreadId ?? "",
                          });
                        }}
                      >
                        <Pencil size={14} />
                        Edit
                      </button>
                      <button
                        className="danger-text"
                        onClick={() =>
                          setConfirm({ kind: "delete", destination: d })
                        }
                      >
                        <Trash2 size={14} />
                        Delete
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
          <SetupSteps />
        </div>
      </Panel>

      <TelegramLinkCard />

      <Panel
        title="Advanced"
        subtitle="Diagnostics. Nothing here needs to be configured manually."
      >
        <details className="telegram-advanced">
          <summary>Show advanced configuration</summary>
          <div className="detail-body">
            <div className="integration-status">
              <span>Webhook status</span>
              <b>
                {data.webhookConfigured
                  ? `Configured · ${when(data.webhookConfiguredAt)}`
                  : "Not configured"}
              </b>
            </div>
            <Field
              label="Public webhook URL"
              hint="Set automatically from the application URL (CLIENT_URL or TELEGRAM_WEBHOOK_BASE_URL)."
            >
              <input readOnly value={data.webhookUrl} />
            </Field>
            <div className="integration-status">
              <span>Bot identity</span>
              <b>
                {data.botUsername
                  ? `${data.botName} (@${data.botUsername})`
                  : "—"}
              </b>
            </div>
            <div className="integration-status">
              <span>Last connection test</span>
              <b>
                {data.lastConnectionTestAt
                  ? `${data.lastConnectionTestOk ? "OK" : "Failed"} · ${when(data.lastConnectionTestAt)}`
                  : "—"}
              </b>
            </div>
            <div className="integration-status">
              <span>Last notification error</span>
              <b>
                {data.lastNotificationError
                  ? `${data.lastNotificationError.message} ${data.lastNotificationError.destinationName ? `(${data.lastNotificationError.destinationName})` : ""} · ${when(data.lastNotificationError.at)}`
                  : "None"}
              </b>
            </div>
            <label className="checkbox-field">
              <input
                type="checkbox"
                disabled={!manage || !!busy}
                checked={data.events.ORDER_CREATED}
                onChange={(e) =>
                  run(
                    "events",
                    "",
                    {
                      method: "PUT",
                      body: { events: { ORDER_CREATED: e.target.checked } },
                    },
                    "Notification events saved.",
                  )
                }
              />
              Notify when an order is created in the CRM (imports never notify)
            </label>
            {data.recentFailures.length > 0 && (
              <>
                <h3>Failed notifications</h3>
                <ul className="telegram-failures">
                  {data.recentFailures.map((f) => (
                    <li key={f._id}>
                      <span>
                        <b>{f.orderNumber}</b> ·{" "}
                        {f.lastError || "Delivery failed"} · {when(f.at)}
                      </span>
                      {manage && (
                        <button
                          disabled={!!busy}
                          onClick={() =>
                            run(
                              "retry-" + f._id,
                              `/notifications/${f._id}/retry`,
                              { method: "POST" },
                              "Notification queued again.",
                            )
                          }
                        >
                          Retry
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        </details>
      </Panel>

      {editing && (
        <Modal
          title={editing._id ? "Edit destination" : "Add destination"}
          onClose={() => setEditing(null)}
        >
          <form className="modal-body" onSubmit={saveDestination}>
            <ErrorBox error={error} />
            <Field label="Name" hint="For example: Logix Orders">
              <input
                required
                maxLength={100}
                value={editing.name}
                onChange={(e) =>
                  setEditing({ ...editing, name: e.target.value })
                }
              />
            </Field>
            <fieldset className="telegram-business">
              <legend>Business</legend>
              {BUSINESS_OPTIONS.map(([value, label]) => (
                <label className="checkbox-field" key={value}>
                  <input
                    type="checkbox"
                    checked={editing.businessTypes.includes(value)}
                    onChange={(e) =>
                      setEditing({
                        ...editing,
                        businessTypes: e.target.checked
                          ? [...editing.businessTypes, value]
                          : editing.businessTypes.filter((b) => b !== value),
                      })
                    }
                  />
                  {label}
                </label>
              ))}
              <small className="muted">
                Partnership orders are only sent to destinations that include
                Partnership.
              </small>
            </fieldset>
            <Field
              label="Group ID"
              hint="Send /chatid in the group and copy the Chat ID (usually starts with -100)."
            >
              <input
                required
                inputMode="numeric"
                pattern="-?[0-9]{5,20}"
                placeholder="-1001234567890"
                value={editing.chatId}
                onChange={(e) =>
                  setEditing({ ...editing, chatId: e.target.value })
                }
              />
            </Field>
            <Field
              label="Topic ID (optional)"
              hint="Only for forum topics. Send /chatid inside the topic."
            >
              <input
                inputMode="numeric"
                pattern="[0-9]{1,10}"
                value={editing.messageThreadId}
                onChange={(e) =>
                  setEditing({ ...editing, messageThreadId: e.target.value })
                }
              />
            </Field>
            <label className="checkbox-field">
              <input
                type="checkbox"
                checked={editing.enabled}
                onChange={(e) =>
                  setEditing({ ...editing, enabled: e.target.checked })
                }
              />
              Enabled
            </label>
            <div className="modal-actions">
              <button type="button" onClick={() => setEditing(null)}>
                Cancel
              </button>
              <button
                className="primary"
                disabled={
                  busy === "destination" || editing.businessTypes.length === 0
                }
              >
                {busy === "destination" ? "Saving…" : "Save destination"}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {confirm && (
        <Modal
          title={
            confirm.kind === "disconnect"
              ? "Disconnect the bot?"
              : "Delete destination?"
          }
          onClose={() => setConfirm(null)}
        >
          <div className="modal-body">
            <p>
              {confirm.kind === "disconnect"
                ? "Notifications and Telegram commands stop immediately. The stored token is deleted; destinations and linked accounts are kept."
                : `“${confirm.destination.name}” will stop receiving notifications.`}
            </p>
            <div className="modal-actions">
              <button onClick={() => setConfirm(null)}>Cancel</button>
              <button
                className="primary"
                disabled={!!busy}
                onClick={async () => {
                  const ok =
                    confirm.kind === "disconnect"
                      ? await run(
                          "disconnect",
                          "/disconnect",
                          { method: "POST" },
                          "Bot disconnected.",
                        )
                      : await run(
                          "delete",
                          `/destinations/${confirm.destination._id}`,
                          { method: "DELETE" },
                          "Destination deleted.",
                        );
                  if (ok) setConfirm(null);
                }}
              >
                {confirm.kind === "disconnect" ? "Disconnect" : "Delete"}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

function SetupSteps() {
  return (
    <div className="telegram-steps">
      <b>How to find the Group ID and Topic ID</b>
      <ol>
        <li>Add your bot to the Telegram group.</li>
        <li>Open the desired topic, if using forum topics.</li>
        <li>
          Send <code>/chatid</code> (or <code>/chatid@YourBot</code> if the bot
          does not answer).
        </li>
        <li>Copy the returned values.</li>
        <li>Add the destination here.</li>
        <li>
          Press <b>Test</b> to verify it.
        </li>
      </ol>
    </div>
  );
}

// Available to every signed-in employee (also shown in My profile).
export function TelegramLinkCard() {
  const link = useApi("/settings/telegram/link");
  const [code, setCode] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  async function act(method, path) {
    setBusy(true);
    setError("");
    try {
      const result = await api("/settings/telegram" + path, { method });
      if (method === "POST") setCode(result);
      else {
        setCode(null);
        link.reload();
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  const data = link.data;
  return (
    <Panel
      title="My Telegram account"
      subtitle="Link your Telegram account to use order commands and status buttons as yourself."
      action={<Link2 size={20} />}
    >
      <div className="detail-body">
        <ErrorBox error={error || link.error} />
        {data?.linked ? (
          <>
            <div className="integration-status">
              <span>Linked account</span>
              <b>
                {data.telegramUsername
                  ? "@" + data.telegramUsername
                  : "Telegram account"}{" "}
                · {date(data.linkedAt)}
              </b>
            </div>
            <div className="row-actions">
              <button disabled={busy} onClick={() => act("DELETE", "/link")}>
                <Unlink size={15} />
                Unlink my Telegram
              </button>
            </div>
          </>
        ) : code ? (
          <div className="telegram-code">
            <p>
              Send this to <b>@{code.botUsername}</b> in a private chat within
              10 minutes:
            </p>
            <div className="telegram-code-value">
              <code>/link {code.code}</code>
              <button
                className="icon-button"
                title="Copy command"
                onClick={() => {
                  navigator.clipboard?.writeText(`/link ${code.code}`).then(
                    () => setCopied(true),
                    () => {},
                  );
                }}
              >
                {copied ? <Check size={15} /> : <Copy size={15} />}
              </button>
            </div>
            <div className="row-actions">
              <button
                className="primary"
                onClick={() =>
                  window.open(code.deepLink, "_blank", "noopener,noreferrer")
                }
              >
                Open Telegram
              </button>
              <button
                onClick={() => {
                  setCode(null);
                  setCopied(false);
                  link.reload();
                }}
              >
                I've sent it
              </button>
            </div>
            <small className="muted">
              The code works once and expires at {when(code.expiresAt)}.
            </small>
          </div>
        ) : (
          <div className="row-actions">
            <button
              className="primary"
              disabled={busy || !data?.available}
              onClick={() => act("POST", "/link-code")}
            >
              <Link2 size={15} />
              Link my Telegram
            </button>
            {data && !data.available && (
              <span className="muted">
                An administrator must connect the bot first.
              </span>
            )}
          </div>
        )}
      </div>
    </Panel>
  );
}
