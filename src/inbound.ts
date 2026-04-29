import type { IncomingMessage, ServerResponse } from "node:http";
import { dispatchInboundDirectDmWithRuntime } from "openclaw/plugin-sdk/direct-dm";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import type { TelnyxWebhookPayload, TelnyxSmsConfig } from "./types.js";
import { resolveAccount, assertOutboundAllowed } from "./channel.js";
import { verifyWebhookSignature, parseInboundPayload } from "./webhook.js";
import { TelnyxClient } from "./client.js";
import { telnyxSmsEventLog, previewText } from "./event-log.js";
import { validateMediaUrl } from "./media-url-policy.js";

/** Stored runtime reference — set once during plugin registration. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let channelRuntime: any | undefined;

/** Called by setRuntime to capture the channel runtime. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function setTelnyxSmsRuntime(runtime: any) {
  channelRuntime = runtime;
}

/**
 * Collect the raw body from a Node.js IncomingMessage.
 */
function collectRawBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * Handle an inbound Telnyx SMS webhook HTTP request.
 * Registered via api.registerHttpRoute in registerFull.
 *
 * Telnyx sends POST requests to your webhook URL with:
 * - Headers: telnyx-signature-ed25519, telnyx-timestamp (Ed25519 signature)
 * - Body: JSON with event_type, payload containing from/to/text
 *
 * This handler:
 * 1. Reads and parses the webhook body
 * 2. Verifies the Ed25519 signature against the account publicKey
 * 3. Parses the inbound SMS/MMS payload
 * 4. Dispatches the message into OpenClaw via dispatchInboundDirectDmWithRuntime
 * 5. The agent's reply is delivered back via Telnyx SMS
 */
export async function handleTelnyxSmsWebhook(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: OpenClawConfig,
): Promise<void> {
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.end("Method Not Allowed");
    return;
  }

  if (!channelRuntime) {
    console.error("[telnyx-sms] runtime not initialized");
    res.statusCode = 500;
    res.end("Runtime not ready");
    return;
  }

  // Read raw body
  let rawBody: string;
  try {
    rawBody = await collectRawBody(req);
  } catch {
    res.statusCode = 400;
    res.end("Failed to read body");
    return;
  }

  // Parse JSON
  let parsed: TelnyxWebhookPayload;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    res.statusCode = 400;
    res.end("Invalid JSON");
    return;
  }

  const eventType = parsed?.data?.event_type;

  // Resolve account and verify webhook signature (ed25519)
  const account = resolveAccount(cfg, null);
  const signatureHeader = req.headers["telnyx-signature-ed25519"] as string | undefined;
  const timestampHeader = req.headers["telnyx-timestamp"] as string | undefined;

  // Defense-in-depth: plugin refuses to register without publicKey, but
  // guard at the request path too so a config reload can't open a hole.
  if (!account.publicKey) {
    res.statusCode = 503;
    res.end("Webhook not configured");
    return;
  }
  const isValid = verifyWebhookSignature(rawBody, signatureHeader, timestampHeader, account.publicKey);
  if (!isValid) {
    res.statusCode = 401;
    res.end("Invalid signature");
    return;
  }

  if (eventType === "message.sent" || eventType === "message.finalized") {
    recordDeliveryStatusEvent(parsed, eventType, cfg);
    res.statusCode = 200;
    res.end("OK");
    return;
  }

  if (eventType && eventType !== "message.received") {
    telnyxSmsEventLog.record({
      direction: "inbound",
      status: "ignored",
      reason: `ignored event type: ${eventType}`,
      messageId: stringOrUndefined(parsed.data?.payload?.message_id ?? parsed.data?.payload?.id),
    });
    res.statusCode = 200;
    res.end("OK");
    return;
  }

  // Parse the inbound payload
  const inbound = parseInboundPayload(parsed);
  if (!inbound) {
    res.statusCode = 400;
    res.end("Invalid payload");
    return;
  }

  // Resolve accountId for multi-account support based on messaging profile
  const accountId = resolveAccountIdForInbound(cfg, inbound.messagingProfileId);

  for (const media of inbound.media) {
    if (typeof media.size === "number" && media.size > 1024 * 1024) {
      telnyxSmsEventLog.record({
        direction: "inbound",
        status: "blocked",
        phoneNumber: inbound.from,
        accountId,
        messageId: inbound.messageId,
        preview: previewText(inbound.text),
        reason: `blocked MMS media larger than 1 MB: ${media.size} bytes`,
      });
      res.statusCode = 400;
      res.end("Invalid media size");
      return;
    }
    const policy = validateMediaUrl(media.url);
    if (!policy.ok) {
      telnyxSmsEventLog.record({
        direction: "inbound",
        status: "blocked",
        phoneNumber: inbound.from,
        accountId,
        messageId: inbound.messageId,
        preview: previewText(inbound.text),
        reason: `blocked MMS media URL: ${policy.reason}`,
      });
      res.statusCode = 400;
      res.end("Invalid media URL");
      return;
    }
  }

  telnyxSmsEventLog.record({
    direction: "inbound",
    status: "received",
    phoneNumber: inbound.from,
    accountId,
    messageId: inbound.messageId,
    preview: previewText(inbound.text),
    reason: inbound.media.length ? `${inbound.media.length} media attachment(s)` : undefined,
  });

  // Telnyx expects a 2xx acknowledgement quickly (within ~2 seconds) to avoid
  // webhook retries. Once the webhook is authenticated and validated, ACK first
  // and continue dispatching the message into OpenClaw.
  res.statusCode = 200;
  res.end("OK");

  // Dispatch into OpenClaw via the standard direct-DM pipeline
  try {
    await dispatchInboundDirectDmWithRuntime({
      cfg,
      runtime: channelRuntime as Parameters<typeof dispatchInboundDirectDmWithRuntime>[0]["runtime"],
      channel: "telnyx-sms",
      channelLabel: "Telnyx SMS",
      accountId,
      peer: { kind: "direct", id: inbound.from },
      senderId: inbound.from,
      senderAddress: inbound.from,
      recipientAddress: inbound.to,
      conversationLabel: inbound.from,
      rawBody: inbound.text ?? "",
      messageId: inbound.messageId ?? "",
      // Deliver the agent's reply back via Telnyx SMS
      deliver: async (payload: { text?: string }) => {
        const replyAccount = resolveAccount(cfg, accountId);
        if (!replyAccount.defaultFromNumber) return;
        assertOutboundAllowed(replyAccount, inbound.from);

        const client = new TelnyxClient(replyAccount.apiKey);
        const result = await client.sendMessage({
          from: replyAccount.defaultFromNumber,
          to: inbound.from,
          text: payload.text ?? "",
          ...(replyAccount.messagingProfileId
            ? { messaging_profile_id: replyAccount.messagingProfileId }
            : {}),
        });
        telnyxSmsEventLog.record({
          direction: "outbound",
          status: "sent",
          phoneNumber: inbound.from,
          accountId,
          messageId: result.data.id,
          preview: previewText(payload.text),
        });
      },
      onRecordError: (err: unknown) => {
        console.error("[telnyx-sms] session record error:", err);
      },
      onDispatchError: (err: unknown, info: { kind: string }) => {
        telnyxSmsEventLog.record({
          direction: "inbound",
          status: "error",
          phoneNumber: inbound.from,
          accountId,
          messageId: inbound.messageId,
          preview: previewText(inbound.text),
          reason: `dispatch error (${info.kind}): ${err instanceof Error ? err.message : String(err)}`,
        });
        console.error(`[telnyx-sms] dispatch error (${info.kind}):`, err);
      },
    });

    res.statusCode = 200;
    res.end("OK");
  } catch (err) {
    telnyxSmsEventLog.record({
      direction: "inbound",
      status: "error",
      phoneNumber: inbound.from,
      accountId,
      messageId: inbound.messageId,
      preview: previewText(inbound.text),
      reason: `inbound dispatch error: ${err instanceof Error ? err.message : String(err)}`,
    });
    console.error("[telnyx-sms] inbound dispatch error:", err);
  }
}

function recordDeliveryStatusEvent(
  parsed: TelnyxWebhookPayload,
  eventType: "message.sent" | "message.finalized",
  cfg: OpenClawConfig,
): void {
  const payload = parsed.data?.payload;
  const from = payload?.from?.phone_number;
  const toField = payload?.to as unknown;
  const firstTo = Array.isArray(toField)
    ? (toField[0] as { phone_number?: string; status?: string } | undefined)
    : (toField as { phone_number?: string; status?: string } | undefined);
  const status = firstTo?.status;
  const errors = payload?.errors ?? [];
  const accountId = resolveAccountIdForInbound(cfg, payload?.messaging_profile_id);
  const messageId = stringOrUndefined(payload?.message_id ?? payload?.id ?? parsed.data?.id);
  telnyxSmsEventLog.record({
    direction: "outbound",
    status: errors.length ? "error" : eventType === "message.finalized" ? "sent" : "sent",
    phoneNumber: firstTo?.phone_number ?? from,
    accountId,
    messageId,
    preview: previewText(payload?.text),
    reason: [
      eventType,
      status ? `status=${status}` : undefined,
      errors.length ? `errors=${errors.map((e) => e.code ?? e.title ?? e.detail ?? "unknown").join(",")}` : undefined,
    ].filter(Boolean).join(" "),
  });
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * Resolve which account an inbound message is for based on messaging profile ID.
 */
function resolveAccountIdForInbound(cfg: OpenClawConfig, messagingProfileId?: string): string {
  if (!messagingProfileId) return "default";

  const section = (cfg as TelnyxSmsConfig).channels?.["telnyx-sms"];
  if (section?.accounts) {
    for (const [accountId, acct] of Object.entries(section.accounts)) {
      if ((acct as { messagingProfileId?: string }).messagingProfileId === messagingProfileId) {
        return accountId;
      }
    }
  }

  return "default";
}

/**
 * Longest-prefix map from E.164 calling code to ISO-3166 alpha-2.
 * Covers common destinations. Ambiguous codes (+1, +7) default to the
 * dominant country. Existing entries on the profile are never removed —
 * we only add what's derivable from allowFrom.
 */
const CALLING_CODE_TO_ISO2 = [
  ["1876", "JM"], ["1869", "KN"], ["1868", "TT"], ["1784", "VC"], ["1767", "DM"],
  ["1758", "LC"], ["1664", "MS"], ["1649", "TC"], ["1473", "GD"], ["1441", "BM"],
  ["1345", "KY"], ["1284", "VG"], ["1268", "AG"], ["1264", "AI"], ["1246", "BB"],
  ["1242", "BS"], ["1", "US"],
  ["7", "RU"],
  ["20", "EG"], ["27", "ZA"], ["30", "GR"], ["31", "NL"], ["32", "BE"],
  ["33", "FR"], ["34", "ES"], ["36", "HU"], ["39", "IT"], ["40", "RO"],
  ["41", "CH"], ["43", "AT"], ["44", "GB"], ["45", "DK"], ["46", "SE"],
  ["47", "NO"], ["48", "PL"], ["49", "DE"],
  ["51", "PE"], ["52", "MX"], ["53", "CU"], ["54", "AR"], ["55", "BR"],
  ["56", "CL"], ["57", "CO"], ["58", "VE"],
  ["60", "MY"], ["61", "AU"], ["62", "ID"], ["63", "PH"], ["64", "NZ"],
  ["65", "SG"], ["66", "TH"],
  ["81", "JP"], ["82", "KR"], ["84", "VN"], ["86", "CN"],
  ["90", "TR"], ["91", "IN"], ["92", "PK"], ["93", "AF"], ["94", "LK"],
  ["95", "MM"], ["98", "IR"],
  ["212", "MA"], ["213", "DZ"], ["216", "TN"], ["218", "LY"], ["220", "GM"],
  ["221", "SN"], ["233", "GH"], ["234", "NG"], ["254", "KE"], ["255", "TZ"],
  ["256", "UG"], ["260", "ZM"], ["263", "ZW"],
  ["351", "PT"], ["352", "LU"], ["353", "IE"], ["354", "IS"], ["356", "MT"],
  ["358", "FI"], ["359", "BG"], ["370", "LT"], ["371", "LV"], ["372", "EE"],
  ["380", "UA"], ["381", "RS"], ["385", "HR"], ["386", "SI"], ["420", "CZ"],
  ["421", "SK"],
  ["852", "HK"], ["853", "MO"], ["855", "KH"], ["856", "LA"], ["880", "BD"],
  ["886", "TW"],
  ["960", "MV"], ["961", "LB"], ["962", "JO"], ["963", "SY"], ["964", "IQ"],
  ["965", "KW"], ["966", "SA"], ["967", "YE"], ["968", "OM"], ["971", "AE"],
  ["972", "IL"], ["973", "BH"], ["974", "QA"], ["975", "BT"], ["976", "MN"],
  ["977", "NP"],
] as [string, string][];

CALLING_CODE_TO_ISO2.sort((a, b) => b[0].length - a[0].length);

/** Derive ISO-2 country code from an E.164 number; null if unknown. */
export function countryCodeForE164(e164: string): string | null {
  const digits = e164.replace(/\D/g, "");
  for (const [prefix, iso] of CALLING_CODE_TO_ISO2) {
    if (digits.startsWith(prefix)) return iso;
  }
  return null;
}

/**
 * Outcome of webhook auto-configuration.
 * - `configured`: we set (or confirmed) our webhook on the profile
 * - `skipped_foreign_webhook`: profile already has a DIFFERENT webhook URL;
 *   we refused to overwrite. Caller should log the existing URL and ours.
 * - `failed`: Telnyx API rejected the call
 */
export type WebhookConfigureResult =
  | { status: "configured"; storedUrl: string }
  | { status: "skipped_foreign_webhook"; existingUrl: string }
  | { status: "verify_mismatch"; sentUrl: string; storedUrl: string }
  | { status: "failed"; detail: string };

/**
 * Hostnames that we consider to be "ours" or stale-self by virtue of being
 * dev/tunnel domains. If a profile's existing webhook_url points to one of
 * these, it's almost certainly a stale OpenClaw tunnel from a previous run
 * and is safe to overwrite without `overwriteExistingWebhook`.
 */
const SELF_OWNED_HOST_SUFFIXES = [
  ".trycloudflare.com",
  ".ngrok.io",
  ".ngrok-free.app",
  ".ngrok.dev",
  ".ngrok.app",
  ".loca.lt",
  ".lhr.life",
  ".ts.net", // tailscale funnel
];

/**
 * Decide whether `existingUrl` looks like a stale-self URL we can safely
 * overwrite without forcing the operator to set `overwriteExistingWebhook`.
 *
 * Treated as stale-self:
 * - hostname matches a known dev-tunnel suffix (trycloudflare, ngrok, etc.)
 * - URL path matches `expectedPath` exactly (clearly an OpenClaw-shaped URL,
 *   even if hostname is custom)
 *
 * Anything else (Zapier, customer's own server, etc.) is treated as foreign.
 */
function isStaleSelfWebhookUrl(existingUrl: string, expectedPath: string): boolean {
  try {
    const parsed = new URL(existingUrl);
    const host = parsed.hostname.toLowerCase();
    if (SELF_OWNED_HOST_SUFFIXES.some((s) => host.endsWith(s))) return true;
    if (parsed.pathname === expectedPath) return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * Read the messaging profile's currently-stored webhook_url. Used by the
 * post-setup watchdog to detect drift (someone edited the profile in the
 * Telnyx dashboard, another integration overwrote it, etc.) without
 * mutating anything.
 */
export async function fetchTelnyxProfileWebhookUrl(
  apiKey: string,
  messagingProfileId: string,
): Promise<{ ok: true; webhookUrl: string } | { ok: false; detail: string }> {
  const url = `https://api.telnyx.com/v2/messaging_profiles/${messagingProfileId}`;
  try {
    const resp = await fetch(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      return {
        ok: false,
        detail: `${resp.status} ${resp.statusText} ${body.slice(0, 200)}`,
      };
    }
    const data = (await resp.json()) as { data?: { webhook_url?: string | null } };
    return { ok: true, webhookUrl: (data.data?.webhook_url ?? "").trim() };
  } catch (err) {
    return {
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Auto-configure the Telnyx messaging profile webhook URL.
 *
 * Safety: if the profile already has a webhook_url set to something OTHER than
 * ours, refuse to overwrite unless `overwrite` is true. This prevents wiping
 * out a customer's Zapier/production webhook just because they pointed
 * OpenClaw at a shared profile.
 *
 * Also merges ISO country codes derived from `allowFrom` into
 * `whitelisted_destinations`, so outbound SMS to those countries isn't
 * rejected by Telnyx with 40010.
 */
export async function configureTelnyxWebhook(
  apiKey: string,
  messagingProfileId: string,
  publicUrl: string,
  allowFrom: string[] = [],
  options: { overwrite?: boolean } = {},
): Promise<WebhookConfigureResult> {
  const url = `https://api.telnyx.com/v2/messaging_profiles/${messagingProfileId}`;
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };

  try {
    // 1. Fetch the current profile — we need whitelisted_destinations (Telnyx
    //    validates the whole payload on PATCH) and the existing webhook_url
    //    so we don't silently overwrite someone else's integration.
    const getResp = await fetch(url, { headers });
    if (!getResp.ok) {
      const body = await getResp.text().catch(() => "");
      return {
        status: "failed",
        detail: `profile fetch rejected: ${getResp.status} ${getResp.statusText} ${body.slice(0, 300)}`,
      };
    }
    const profile = (await getResp.json()) as {
      data?: {
        whitelisted_destinations?: string[];
        webhook_url?: string | null;
      };
    };

    const existingWebhook = (profile.data?.webhook_url ?? "").trim();
    let expectedPath = "";
    try {
      expectedPath = new URL(publicUrl).pathname;
    } catch {
      // publicUrl is malformed — caller built it; let the PATCH fail loudly.
    }
    if (existingWebhook && existingWebhook !== publicUrl) {
      const staleSelf = expectedPath
        ? isStaleSelfWebhookUrl(existingWebhook, expectedPath)
        : false;
      if (!options.overwrite && !staleSelf) {
        return { status: "skipped_foreign_webhook", existingUrl: existingWebhook };
      }
      // staleSelf or operator-forced — proceed to PATCH below.
    }

    // 2. Merge country codes derived from allowFrom into whitelisted_destinations
    const existing = new Set(profile.data?.whitelisted_destinations ?? []);
    const derived: string[] = [];
    for (const num of allowFrom) {
      if (num === "*") continue;
      const iso = countryCodeForE164(num);
      if (iso && !existing.has(iso)) {
        existing.add(iso);
        derived.push(iso);
      }
    }
    const merged = existing.size > 0 ? Array.from(existing) : ["*"];

    // 3. PATCH webhook_url + whitelisted_destinations
    const patchResp = await fetch(url, {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        webhook_url: publicUrl,
        whitelisted_destinations: merged,
      }),
    });
    if (!patchResp.ok) {
      const body = await patchResp.text().catch(() => "");
      return {
        status: "failed",
        detail: `webhook update rejected: ${patchResp.status} ${patchResp.statusText} ${body.slice(0, 300)}`,
      };
    }
    if (derived.length > 0) {
      console.info(
        `[telnyx-sms] added ${derived.join(",")} to whitelisted_destinations (derived from allowFrom)`,
      );
    }

    // 4. Verify Telnyx actually stored the URL we sent. The PATCH response
    //    body itself contains the stored value, so we trust that over a
    //    second GET (saves a round-trip). If it diverges from what we sent,
    //    surface it loudly — silent storage divergence has bitten us before.
    let storedUrl = publicUrl;
    try {
      const patchBody = (await patchResp.json()) as {
        data?: { webhook_url?: string | null };
      };
      const echoed = (patchBody.data?.webhook_url ?? "").trim();
      if (echoed) storedUrl = echoed;
    } catch {
      // PATCH 200 but no parseable body — assume server stored what we sent.
    }
    if (storedUrl !== publicUrl) {
      return { status: "verify_mismatch", sentUrl: publicUrl, storedUrl };
    }
    return { status: "configured", storedUrl };
  } catch (err) {
    return {
      status: "failed",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}
