import crypto from "node:crypto";
import type { TelnyxWebhookPayload } from "./types.js";

/**
 * Telnyx webhook signing.
 *
 * Telnyx signs every webhook with Ed25519 using your **organization-level
 * public key** (viewable at https://portal.telnyx.com/#/account/public-key).
 *
 * Headers on the request:
 *   telnyx-signature-ed25519  → base64-encoded signature
 *   telnyx-timestamp          → unix seconds when the request was initiated
 *
 * Signed payload:   `${timestamp}|${rawBody}`  (pipe, not dot)
 *
 * The same public key signs SMS, Voice, Verify, Numbers — everything.
 *
 * Reference: https://developers.telnyx.com/development/api-fundamentals/webhooks/receiving-webhooks
 */

// SPKI DER prefix for an Ed25519 public key (12 bytes), to wrap the raw
// 32-byte key into a form Node's crypto module can import.
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** Reject webhooks older than this many seconds (replay protection). */
const MAX_CLOCK_SKEW_SECONDS = 300;

function ed25519KeyFromBase64(b64: string): crypto.KeyObject {
  const raw = Buffer.from(b64, "base64");
  if (raw.length !== 32) {
    throw new Error(
      `Expected a 32-byte Ed25519 public key, got ${raw.length} bytes. ` +
      `Paste the base64 key from https://portal.telnyx.com/#/account/public-key`,
    );
  }
  return crypto.createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
    format: "der",
    type: "spki",
  });
}

export function verifyWebhookSignature(
  body: string,
  signatureHeader: string | undefined,
  timestampHeader: string | undefined,
  publicKeyB64: string,
): boolean {
  if (!signatureHeader || !timestampHeader || !publicKeyB64) return false;

  // Replay protection: reject stale or future-dated timestamps.
  const ts = Number.parseInt(timestampHeader, 10);
  if (!Number.isFinite(ts)) return false;
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > MAX_CLOCK_SKEW_SECONDS) return false;

  const signedPayload = Buffer.from(`${timestampHeader}|${body}`, "utf8");
  const signature = Buffer.from(signatureHeader, "base64");
  if (signature.length !== 64) return false;

  try {
    const key = ed25519KeyFromBase64(publicKeyB64);
    return crypto.verify(null, signedPayload, key, signature);
  } catch {
    return false;
  }
}

/**
 * Parse an inbound Telnyx webhook payload.
 * Returns normalized fields or null if the payload is invalid.
 */
export function parseInboundPayload(
  payload: TelnyxWebhookPayload,
): {
  from: string;
  to: string;
  text: string | undefined;
  media: Array<{ url: string; contentType: string }>;
  messageId: string | undefined;
  messagingProfileId: string | undefined;
} | null {
  const p = payload?.data?.payload;
  const toField: unknown = (p as { to?: unknown })?.to;
  const toPhone = Array.isArray(toField)
    ? (toField[0] as { phone_number?: string } | undefined)?.phone_number
    : (toField as { phone_number?: string } | undefined)?.phone_number;
  if (!p?.from?.phone_number || !toPhone) return null;

  return {
    from: p.from.phone_number,
    to: toPhone,
    text: p.text,
    media: (p.media ?? []).map((m) => ({
      url: m.url,
      contentType: m.content_type,
    })),
    messageId: p.message_id,
    messagingProfileId: p.messaging_profile_id,
  };
}
