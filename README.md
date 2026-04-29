# Telnyx SMS/MMS Channel for OpenClaw

Official Telnyx SMS plugin for OpenClaw. Give any OpenClaw agent a real Telnyx phone number so people can text the agent directly over SMS/MMS.

This package is the Telnyx-owned channel plugin for OpenClaw. It is designed around a one-key Telnyx setup path: paste a Telnyx API key, let the plugin discover the phone number, messaging profile, and webhook public key, then let it configure the messaging profile webhook safely.

## Why this plugin

- Official Telnyx-maintained OpenClaw SMS/MMS channel.
- One-key setup path using a Telnyx API v2 key.
- Auto-discovers the Telnyx phone number, messaging profile, and Ed25519 public key when possible.
- Automatically registers the OpenClaw webhook route.
- Can PATCH the Telnyx messaging profile webhook URL for you.
- Refuses to overwrite an existing third-party webhook unless explicitly allowed.
- Self-probes the public webhook URL to confirm it reaches this OpenClaw gateway.
- Runs a watchdog to detect tunnel or Telnyx profile webhook drift.
- Supports inbound SMS/MMS, outbound SMS/MMS, allowlisted access, and multi-account setups.

## Telnyx-native setup

This plugin is built for the official Telnyx path:

- Start with a single Telnyx API v2 key.
- Discover the Telnyx number, messaging profile, and webhook public key automatically when possible.
- Configure the Telnyx Messaging Profile webhook URL from OpenClaw.
- Protect existing webhook URLs by default.
- Confirm the public webhook URL reaches this OpenClaw gateway before using it.
- Watch for tunnel or webhook drift after setup.

## Features

- Inbound SMS through Telnyx Messaging webhooks.
- Inbound MMS payload parsing and delivery to OpenClaw.
- Outbound SMS replies through `POST /v2/messages`.
- Outbound MMS with `media_urls`.
- Ed25519 webhook signature verification using Telnyx webhook headers.
- OpenClaw direct-message threading by phone number.
- Optional pairing via SMS verification code.
- `allowlist` or `open` DM security mode.
- Outbound allowlist enforcement so an allowlisted bot cannot accidentally send to unknown numbers.
- Multi-account config for multiple Telnyx numbers/profiles from one OpenClaw instance.
- Automatic public key discovery from `GET /v2/public_key`.
- Automatic number/profile discovery from Telnyx phone-number APIs.
- Optional messaging profile creation and orphan-number attachment with explicit opt-in.
- Automatic webhook configuration with safe overwrite protection.
- Public URL self-probe and periodic webhook watchdog.
- In-memory status/event log for recent inbound, outbound, blocked, and error events.
- MMS media URL safety checks to prevent SSRF-style fetch risks.

## Prerequisites

- OpenClaw `2026.4.21` or later.
- A Telnyx account.
- A Telnyx API v2 key.
- A Telnyx phone number with SMS/MMS capability.
- A publicly reachable webhook URL for inbound SMS/MMS.
- For US A2P messaging, approved 10DLC brand/campaign setup in Telnyx.

## Install

From ClawHub:

```sh
clawhub package install telnyx-openclaw-sms-channel
```

From source while developing:

```sh
git clone https://github.com/team-telnyx/telnyx-openclaw-sms-channel.git
cd telnyx-openclaw-sms-channel
npm install
npm run build
```

## Quick start

### 1. Create a Telnyx API key

In the Telnyx Mission Control Portal:

1. Go to API Keys.
2. Create or copy an API v2 key.
3. Keep it private. It should start with `KEY...`.

### 2. Make sure you have an SMS-capable Telnyx number

The plugin can discover your number automatically, but the account still needs at least one SMS/MMS-capable number.

If the number is already attached to a Messaging Profile, the plugin can reuse that profile. If the number is not attached to a profile, set `autoCreateProfile: true` only when you want the plugin to create a profile and attach the orphan number for you.

### 3. Configure OpenClaw

Minimal config:

```json
{
  "channels": {
    "telnyx-sms": {
      "apiKey": "KEY...",
      "allowFrom": ["+15551234567"],
      "exposure": {
        "publicUrl": "https://agent.example.com/telnyx-sms/webhook"
      }
    }
  }
}
```

With only `apiKey`, the plugin attempts to discover:

- `defaultFromNumber`
- `messagingProfileId`
- `publicKey`

The `publicKey` is the Telnyx account-wide Ed25519 webhook public key from `GET /v2/public_key`.

### 4. Start OpenClaw

When the gateway starts, the plugin:

1. Registers the local webhook route, default `/telnyx-sms/webhook`.
2. Discovers missing Telnyx defaults when possible.
3. Resolves the public webhook URL.
4. Self-probes the public URL.
5. Configures the Telnyx Messaging Profile webhook URL if safe.
6. Starts a watchdog for route/profile drift.
7. Acknowledges validated webhooks quickly with `200 OK` so Telnyx does not retry unnecessarily.

### 5. Text the Telnyx number

If `dmSecurity` is `allowlist`, the sender must be in `allowFrom`.

If `dmSecurity` is `open`, anyone who knows the number can message the agent.

## Configuration reference

Full single-account example:

```json
{
  "channels": {
    "telnyx-sms": {
      "apiKey": "KEY...",
      "defaultFromNumber": "+15551234567",
      "messagingProfileId": "40000000-0000-0000-0000-000000000000",
      "publicKey": "base64-ed25519-public-key",
      "dmSecurity": "allowlist",
      "allowFrom": ["+15557654321"],
      "webhookPath": "/telnyx-sms/webhook",
      "exposure": {
        "publicUrl": "https://agent.example.com/telnyx-sms/webhook"
      },
      "overwriteExistingWebhook": false,
      "profileName": "OpenClaw Agent",
      "autoCreateProfile": false
    }
  }
}
```

### `apiKey`

Telnyx API v2 key. Required.

### `defaultFromNumber`

E.164 Telnyx number used for outbound SMS/MMS. Optional when discovery can find a number.

### `messagingProfileId`

Telnyx Messaging Profile ID. Optional when discovery can find the profile attached to `defaultFromNumber`.

### `publicKey`

Base64 Ed25519 public key used to verify Telnyx webhooks. Optional when discovery can fetch it from `GET /v2/public_key`.

### `dmSecurity`

Inbound/outbound DM security policy.

Allowed values:

- `allowlist`, default. Only numbers in `allowFrom` can message the bot. Outbound sends are also restricted to `allowFrom`.
- `open`. Any phone number can message the bot.

### `allowFrom`

Phone numbers allowed to message the bot when `dmSecurity` is `allowlist`.

```json
"allowFrom": ["+15551234567", "+15557654321"]
```

### `webhookPath`

Local OpenClaw route for Telnyx webhooks.

Default:

```json
"/telnyx-sms/webhook"
```

### `exposure.publicUrl`

Stable public URL that Telnyx should call.

```json
{
  "exposure": {
    "publicUrl": "https://agent.example.com/telnyx-sms/webhook"
  }
}
```

### `exposure.tunnel`

Development tunnel option when supported by the local machine.

```json
{
  "exposure": {
    "tunnel": { "provider": "cloudflared" }
  }
}
```

or:

```json
{
  "exposure": {
    "tunnel": { "provider": "ngrok" }
  }
}
```

### `overwriteExistingWebhook`

Default: `false`.

When false, the plugin refuses to overwrite a Telnyx Messaging Profile webhook URL that points somewhere else. This protects existing Zapier, production, or customer integrations.

Set to `true` only when you intentionally want this OpenClaw gateway to own the profile webhook.

### `profileName`

Name to use when auto-creating a Messaging Profile.

Default is derived from OpenClaw agent or instance metadata.

### `autoCreateProfile`

Default: `false`.

When true, the plugin may create a Messaging Profile and attach an orphan Telnyx number if no profile exists. This is explicit opt-in because profile/number changes are visible in the Telnyx dashboard and may affect billing or routing.

## Multi-account setup

Use `accounts` when one OpenClaw instance should serve multiple Telnyx numbers/profiles.

```json
{
  "channels": {
    "telnyx-sms": {
      "apiKey": "KEY-default",
      "allowFrom": ["+15550000001"],
      "accounts": {
        "support": {
          "apiKey": "KEY-support",
          "defaultFromNumber": "+15551230000",
          "messagingProfileId": "support-profile-id",
          "allowFrom": ["+15557654321"]
        },
        "sales": {
          "apiKey": "KEY-sales",
          "defaultFromNumber": "+15551230001",
          "messagingProfileId": "sales-profile-id",
          "dmSecurity": "open"
        }
      }
    }
  }
}
```

## Architecture

The plugin has four main parts:

1. **OpenClaw channel plugin**
   - Registers the `telnyx-sms` channel with OpenClaw.
   - Handles outbound delivery for SMS/MMS.
   - Exposes channel capabilities, setup flow, pairing, and account resolution.

2. **Telnyx Messaging API client**
   - Sends SMS/MMS through `POST https://api.telnyx.com/v2/messages`.
   - Uses the configured or discovered Telnyx phone number as `from`.
   - Includes `messaging_profile_id` when available.
   - Adds `media_urls` for MMS delivery.

3. **Inbound webhook handler**
   - Registers an HTTP route in the OpenClaw gateway.
   - Default route: `/telnyx-sms/webhook`.
   - Reads the raw request body.
   - Verifies Telnyx Ed25519 webhook signatures.
   - Parses inbound SMS/MMS payloads.
   - Dispatches messages into OpenClaw as direct conversations.

4. **Setup and watchdog layer**
   - Discovers phone number, messaging profile, and webhook public key from Telnyx.
   - Resolves the public webhook URL.
   - Optionally configures the Telnyx Messaging Profile webhook URL.
   - Self-probes the public URL to confirm traffic reaches this gateway.
   - Re-checks routing/profile state periodically and logs drift.

5. **Diagnostics and media-safety layer**
   - Keeps a bounded in-memory event log of recent SMS activity.
   - Records inbound receives, outbound sends, blocked media, and dispatch errors.
   - Validates inbound MMS media URLs before allowing them into the message pipeline.
   - Rejects localhost, private IPs, metadata-service IPs, non-HTTPS URLs, and non-Telnyx media hosts.

```text
User phone
   │ SMS/MMS
   ▼
Telnyx Messaging
   │ webhook event
   ▼
OpenClaw gateway /telnyx-sms/webhook
   │ verified + normalized
   ▼
OpenClaw telnyx-sms channel
   │ direct-message thread
   ▼
Agent
   │ reply
   ▼
Telnyx Messaging API /v2/messages
   │ SMS/MMS
   ▼
User phone
```

## How it works

### Startup lifecycle

When OpenClaw starts, the plugin:

1. Reads `channels.telnyx-sms` from OpenClaw config.
2. Registers the local webhook route synchronously so OpenClaw can receive inbound webhooks immediately.
3. Attempts to discover missing Telnyx defaults:
   - `defaultFromNumber`
   - `messagingProfileId`
   - `publicKey`
4. Resolves the public webhook URL from `exposure.publicUrl`, a configured tunnel, or another supported exposure mode.
5. Sends a self-probe to the public URL and expects the local handler to reject it with `401`, proving the public URL reaches this gateway.
6. Fetches the Telnyx Messaging Profile.
7. Configures or verifies the profile `webhook_url`.
8. Starts the watchdog.

### Inbound message flow

1. A user texts the Telnyx number.
2. Telnyx sends a webhook event to the configured Messaging Profile webhook URL.
3. The plugin verifies the `telnyx-signature-ed25519` and `telnyx-timestamp` headers.
4. The plugin validates any MMS media metadata.
5. The plugin acknowledges the webhook with `200 OK` after validation, then dispatches into OpenClaw.
6. The plugin parses the payload into OpenClaw's direct-message shape.
7. The sender phone number becomes the conversation identity.
8. OpenClaw routes the message to the agent.
9. If the agent replies, the plugin sends the response through the Telnyx Messaging API.

### Outbound message flow

1. OpenClaw asks the `telnyx-sms` channel to send a message.
2. The plugin resolves the configured account.
3. In `allowlist` mode, the plugin verifies the destination is allowed.
4. The plugin sends the message with `POST /v2/messages`.
5. If media is included, the plugin sends MMS using `media_urls`.
6. The Telnyx API returns the message ID, which OpenClaw records as the delivery result.
7. If Telnyx later sends `message.sent` or `message.finalized` webhooks, the plugin records them in the event log for delivery troubleshooting.

### Session routing

The plugin treats each phone number as a direct-message conversation.

- Sender phone number maps to the OpenClaw conversation identity.
- Replies go back to the same phone number.
- Multi-account setups can route through different configured Telnyx accounts/profiles.

### Status/event log

The plugin keeps a small in-memory ring buffer of recent SMS activity. It records events such as:

- inbound SMS/MMS received
- outbound SMS sent
- Telnyx delivery status webhooks, including `message.sent` and `message.finalized`
- blocked inbound media URL
- oversized inbound MMS media
- dispatch or delivery errors
- Telnyx message ID when available
- account ID, sender/recipient phone number, and a short text preview

The log is intended for operator debugging and supportability. It is intentionally bounded and in-memory, so it does not persist message history to disk.

### MMS media URL safety

Inbound MMS webhooks can include media URLs. Before those URLs are allowed into the message pipeline, the plugin validates them as untrusted input.

The policy requires:

- HTTPS only
- no embedded credentials
- no localhost
- no private or reserved IP addresses
- no cloud metadata-service IPs such as `169.254.169.254`
- host must be an allowed Telnyx media/CDN host
- inbound MMS media size must be 1 MB or smaller when Telnyx includes size metadata

This protects the gateway from SSRF-style risks where a crafted media URL could otherwise cause the server to access internal services.

### Webhook setup behavior

Telnyx sends inbound SMS/MMS events to the Messaging Profile webhook URL.

This plugin can configure that URL automatically:

1. Fetch the selected Messaging Profile.
2. Check the existing `webhook_url`.
3. If empty, set it to this OpenClaw gateway's public URL.
4. If it already points to this gateway or a stale dev tunnel owned by this setup, update it.
5. If it points somewhere else, skip safely unless `overwriteExistingWebhook` is true.
6. Verify the stored webhook URL after PATCH.

This avoids the common setup failure mode: OpenClaw is running, SMS sends work, but inbound messages disappear because the Telnyx profile webhook points at the wrong place.

## Telnyx messaging notes

### Webhook retries and failover

Telnyx expects webhook receivers to return a `2xx` response quickly. If a webhook endpoint does not respond in time or returns an error, Telnyx may retry delivery and then use a configured failover URL if one exists.

This plugin validates the webhook signature and payload first, then acknowledges valid webhook events quickly to avoid unnecessary retries while the agent work continues asynchronously.

### Delivery status and MDRs

Telnyx sends outbound status events such as `message.sent` and `message.finalized`. The plugin records those in the event log for troubleshooting.

For deeper troubleshooting, use the Telnyx message ID with Message Detail Records in the Telnyx API or portal. MDRs can show status, cost, parts, errors, and delivery failure details.

### Opt-out keywords

Telnyx handles standard English opt-out and opt-in keywords at the messaging profile level.

Common opt-out keywords include:

- `STOP`
- `STOPALL`
- `UNSUBSCRIBE`
- `CANCEL`
- `END`
- `QUIT`

Common opt-in keywords include:

- `START`
- `UNSTOP`

Opt-out words must generally be sent as the only words in the message. Once a recipient opts out, messages from numbers on the same messaging profile to that recipient may be blocked until they opt back in.

### MMS file types and size

Common MMS media types include:

- `text/plain`
- `text/vcard`
- `image/jpeg`
- `image/png`
- `image/gif`
- `video/3gpp`
- `video/mp4`

Carrier MMS size limits vary. This plugin uses a conservative 1 MB inbound media size guard when Telnyx includes media size metadata.

## Security model

- Webhooks are verified with Telnyx Ed25519 signatures.
- Inbound webhook requests without a configured/discovered public key are rejected.
- `allowlist` is the default DM security mode.
- Outbound sends honor `allowFrom` in allowlist mode.
- Existing foreign profile webhooks are protected by default.
- MMS media URLs are validated before use to reduce SSRF risk.
- API keys should be stored in OpenClaw config/secrets, not committed to source control.

## Troubleshooting

### Inbound messages are not arriving

Check:

- OpenClaw gateway is running.
- The Telnyx Messaging Profile webhook URL points to your public URL.
- The public URL routes to the OpenClaw gateway.
- The route path matches `webhookPath`, default `/telnyx-sms/webhook`.
- The plugin logs show a successful self-probe.
- The Telnyx public key was discovered or configured.

### Webhook signature errors

Check:

- `publicKey` is the Telnyx account-wide Ed25519 public key.
- The request body is not being modified by a proxy before reaching OpenClaw.
- You are not using a public key from a different Telnyx account.

### Outbound sends fail

Check:

- `apiKey` is valid.
- `defaultFromNumber` belongs to the Telnyx account.
- The number is SMS/MMS capable.
- The recipient is in `allowFrom` when `dmSecurity` is `allowlist`.
- US A2P traffic has approved 10DLC registration where required.

### The plugin skipped webhook configuration

If logs mention an existing foreign webhook, the plugin is protecting another integration.

Options:

1. Manually update the Telnyx Messaging Profile webhook in the portal.
2. Use a separate Messaging Profile/number for OpenClaw.
3. Set `overwriteExistingWebhook: true` only if you intentionally want OpenClaw to replace the existing webhook.

## Support

If you have issues with this plugin, contact Telnyx Support at support@telnyx.com.

When reaching out, include:

- OpenClaw version.
- Plugin version.
- Whether you are using `publicUrl`, `cloudflared`, `ngrok`, or another exposure method.
- The Telnyx Messaging Profile ID, if available.
- Relevant OpenClaw gateway logs with API keys and phone numbers redacted.

## Development

```sh
npm install
npm test
npm run typecheck
npm run build
npm pack --dry-run
```

## Package identity

- ClawHub package: `telnyx-openclaw-sms-channel`
- OpenClaw channel id: `telnyx-sms`
- Source repo: `https://github.com/team-telnyx/telnyx-openclaw-sms-channel`
- Maintainer: Telnyx

## License

MIT
