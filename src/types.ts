/** Type definitions for the Telnyx SMS channel plugin. */

import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";

/** Resolved account config after looking up multi-account or default settings. */
export interface ResolvedAccount {
  accountId: string | null;
  apiKey: string;
  messagingProfileId?: string;
  defaultFromNumber?: string;
  allowFrom: string[];
  dmPolicy: "allowlist" | "open" | undefined;
  /** Base64 Ed25519 public key from portal.telnyx.com/#/account/public-key. */
  publicKey?: string;
}

/** Telnyx Messaging API send request body. */
export interface TelnyxSendMessageParams {
  from: string;
  to: string;
  text?: string;
  media_urls?: string[];
  messaging_profile_id?: string;
  subject?: string;
}

/** Telnyx Messaging API response (simplified). */
export interface TelnyxMessageResponse {
  data: {
    id: string;
    from: { phone_number: string };
    to: { phone_number: string } | Array<{ phone_number: string; status?: string }>;
    text: string;
    media?: Array<{ url: string; content_type: string }>;
  };
}

/** Telnyx inbound webhook payload structure. */
export interface TelnyxWebhookPayload {
  data: {
    event_type?: string;
    id?: string;
    occurred_at?: string;
    payload: {
      from: { phone_number: string };
      to: { phone_number: string; status?: string } | Array<{ phone_number: string; status?: string }>;
      text?: string;
      media?: Array<{ url: string; content_type: string; sha1?: string; sha256?: string; size?: number }>;
      messaging_profile_id?: string;
      direction?: "inbound" | "outbound";
      errors?: Array<{ code?: string; title?: string; detail?: string }>;
      completed_at?: string | null;
      message_id?: string;
      [key: string]: unknown;
    };
  };
}

/** Webhook exposure config — how the gateway becomes reachable for Telnyx webhooks. */
export interface WebhookExposureConfig {
  /** Customer provides their own stable public URL. */
  publicUrl?: string;
  /** Auto-launch a tunnel (ngrok or cloudflared). */
  tunnel?: { provider: "ngrok" | "cloudflared" };
  /** Auto-expose via Tailscale Funnel. */
  tailscale?: { mode: "funnel"; path?: string };
}

/** Config shape under channels.telnyx-sms */
export interface TelnyxSmsAccountConfig {
  apiKey?: string;
  messagingProfileId?: string;
  defaultFromNumber?: string;
  allowFrom?: string[];
  dmSecurity?: "allowlist" | "open";
  /**
   * Base64 Ed25519 public key for verifying Telnyx webhooks.
   * Organization-wide — copy from https://portal.telnyx.com/#/account/public-key.
   */
  publicKey?: string;
  /** How to expose the webhook publicly. Auto-detected if omitted. */
  exposure?: WebhookExposureConfig;
  /** Webhook path (default: /telnyx-sms/webhook). Only change if you know what you're doing. */
  webhookPath?: string;
  /**
   * If the Telnyx profile already has a different webhook URL, refuse to
   * overwrite it unless this is true. Default false (safe).
   */
  overwriteExistingWebhook?: boolean;
  /** Name to use when the plugin auto-creates a Telnyx messaging profile. */
  profileName?: string;
  /**
   * Explicit opt-in to auto-create a Telnyx messaging profile and attach an
   * orphan number when the account has no profile yet. Default false — the
   * plugin will log what it *would* do and wait for the customer to set this
   * to true. Because gateway startup is non-interactive, we can't prompt.
   */
  autoCreateProfile?: boolean;
}

/** Top-level config for resolving accounts. */
export type TelnyxSmsConfig = OpenClawConfig & {
  channels?: {
    "telnyx-sms"?: TelnyxSmsAccountConfig & {
      accounts?: Record<string, TelnyxSmsAccountConfig>;
    };
  };
};
