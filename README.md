<!-- markdownlint-disable MD013 -->

# Telnyx SMS/MMS Channel for OpenClaw

Official Telnyx SMS/MMS channel for OpenClaw. Give an OpenClaw agent a real Telnyx phone number, then let people text it over SMS or MMS.

Start with a Telnyx API key and a public webhook URL. The plugin can discover the phone number, Messaging Profile, and webhook public key, then configure the Telnyx webhook safely without replacing another integration unless you explicitly allow it.

## Highlights

- **Official Telnyx channel** — built for Telnyx Messaging and OpenClaw.
- **Fast setup** — one Telnyx API key is enough for discovery in the common case.
- **Automatic discovery** — finds the Telnyx number, Messaging Profile, and account webhook public key when possible.
- **Safe webhook setup** — configures the Messaging Profile webhook only when it can do so safely.
- **No surprise overwrites** — existing third-party webhook URLs are protected by default.
- **SMS and MMS** — receive and send text messages and MMS media.
- **Secure inbound webhooks** — verifies Telnyx Ed25519 signatures before dispatching messages.
- **Access control** — allowlist mode is the default, with optional open mode.
- **Production diagnostics** — includes self-probe, watchdog checks, and a recent event log.
- **Multi-account support** — run multiple Telnyx numbers or profiles from one OpenClaw gateway.

## Prerequisites

- OpenClaw `2026.4.21` or later
- A Telnyx account
- A Telnyx API v2 key, starts with `KEY...`
- A Telnyx phone number with SMS/MMS capability
- A public URL that can reach your OpenClaw gateway
- For US A2P traffic, approved 10DLC setup where required

## Install

From ClawHub:

```sh
openclaw plugins install clawhub:telnyx-openclaw-sms-channel
```

From source:

```sh
git clone https://github.com/team-telnyx/telnyx-openclaw-sms-channel.git
cd telnyx-openclaw-sms-channel
npm install
npm run build
```

## Quick start

The happy path is three values: your Telnyx API key, your public webhook URL, and the phone numbers allowed to message the agent.

### 1. Create a Telnyx API key

In the Telnyx Mission Control Portal:

1. Go to **Account → API Keys**.
2. Create or copy an API v2 key.
3. Keep it private. It should start with `KEY...`.

### 2. Confirm you have an SMS/MMS number

Your Telnyx account needs at least one SMS/MMS-capable phone number.

If the number is already assigned to a Messaging Profile, the plugin can reuse that profile. If the number is not assigned to a profile, keep setup manual or set `autoCreateProfile: true` when you intentionally want OpenClaw to create a Messaging Profile and attach the number.

### 3. Add the OpenClaw channel config

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

With this config, the plugin attempts to discover:

- `defaultFromNumber`
- `messagingProfileId`
- `publicKey`

The `publicKey` is the Telnyx account-wide Ed25519 public key used to verify incoming webhooks.

### 4. Start OpenClaw

On startup, the plugin:

1. Registers the local webhook route, default `/telnyx-sms/webhook`.
2. Discovers missing Telnyx defaults when possible.
3. Resolves the public webhook URL.
4. Probes the public URL to confirm it reaches this gateway.
5. Configures the Telnyx Messaging Profile webhook URL when it is safe.
6. Starts a watchdog for route/profile drift.

### 5. Text the Telnyx number

If `dmSecurity` is `allowlist`, only numbers in `allowFrom` can message the agent.

If `dmSecurity` is `open`, anyone who knows the number can message the agent.

## Full configuration

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

### Configuration reference

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `apiKey` | string | Yes | — | Telnyx API v2 key. This is the only required field for discovery. |
| `defaultFromNumber` | string | No | Auto-discovered | E.164 Telnyx number used for outbound SMS/MMS. |
| `messagingProfileId` | string | No | Auto-discovered | Telnyx Messaging Profile ID. |
| `publicKey` | string | No | Auto-discovered | Base64 Ed25519 public key for verifying Telnyx webhooks. |
| `dmSecurity` | string | No | `allowlist` | DM policy: `allowlist` or `open`. |
| `allowFrom` | string[] | No | `[]` | E.164 phone numbers allowed to message the agent in allowlist mode. |
| `webhookPath` | string | No | `/telnyx-sms/webhook` | Local OpenClaw route for Telnyx webhooks. |
| `exposure.publicUrl` | string | Recommended | — | Stable public URL Telnyx should call for webhooks. |
| `exposure.tunnel.provider` | string | No | — | Development tunnel provider, `ngrok` or `cloudflared`, when supported locally. |
| `exposure.tailscale.mode` | string | No | — | Tailscale exposure mode, currently `funnel`. |
| `overwriteExistingWebhook` | boolean | No | `false` | Allows the plugin to replace an existing Messaging Profile webhook URL. |
| `profileName` | string | No | Derived | Name to use when auto-creating a Messaging Profile. |
| `autoCreateProfile` | boolean | No | `false` | Allows profile creation and orphan-number attachment when no profile exists. |
| `accounts` | object | No | — | Named account configs for multiple numbers/profiles. |

## Automatic setup behavior

This plugin is designed to remove most manual Telnyx Portal setup.

When possible, it will:

- Find an SMS/MMS-capable Telnyx phone number.
- Find the Messaging Profile attached to that number.
- Fetch the account webhook public key.
- Register the OpenClaw webhook route.
- Confirm your public URL reaches the local gateway.
- Configure the Messaging Profile webhook URL.

The safety rule is simple: the plugin will not silently replace another webhook. If a Messaging Profile already points to a different URL, setup fails safe unless `overwriteExistingWebhook` is `true`.

Use a dedicated Messaging Profile and number when you do not want OpenClaw to touch an existing production integration.

## Multi-account setup

Use `accounts` when one OpenClaw instance should serve multiple Telnyx numbers or profiles.

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

## Message flow

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
   │ direct message thread
   ▼
Agent response
   │ outbound SMS/MMS
   ▼
Telnyx Messaging API
```

Inbound flow:

1. A user texts your Telnyx number.
2. Telnyx sends a `message.received` webhook to OpenClaw.
3. The plugin verifies the Ed25519 signature.
4. The sender is checked against `dmSecurity` and `allowFrom`.
5. SMS text and safe MMS media are normalized into an OpenClaw direct message.
6. The agent replies through Telnyx SMS/MMS.

Outbound flow:

1. OpenClaw sends a message through the `telnyx-sms` channel.
2. The plugin selects the configured or discovered Telnyx number.
3. In allowlist mode, the recipient must be in `allowFrom`.
4. The message is sent through Telnyx `POST /v2/messages`.

## Related X/Twitter workflows

Keep this plugin responsible for private SMS/MMS conversations, MMS media, webhook delivery, allowlist policy, and Telnyx Messaging setup. When the same OpenClaw agent also needs public X/Twitter data or visible X/Twitter actions, install TweetClaw separately:

```sh
openclaw plugins install @xquik/tweetclaw
```

TweetClaw covers scrape tweets, search tweets, search tweet replies, follower export, user lookup, media workflows, direct messages, monitor tweets, webhooks, giveaway draws, and approval-gated post tweets or post tweet replies. Use [GitHub](https://github.com/Xquik-dev/tweetclaw) and [npm](https://www.npmjs.com/package/@xquik/tweetclaw) for setup details; the [ClawHub discovery page](https://clawhub.ai/plugins/@xquik/tweetclaw) is useful for browsing while its listing lags behind the npm release. Keep X/Twitter connection settings separate from Telnyx channel settings, and review visible X/Twitter actions through OpenClaw approval flows.

## Security model

- Webhooks are verified with Telnyx Ed25519 signatures.
- Webhook requests without a configured or discovered public key are rejected.
- `allowlist` is the default DM security mode.
- Outbound sends honor `allowFrom` in allowlist mode.
- Existing foreign profile webhooks are protected by default.
- MMS media URLs are validated before use to reduce SSRF risk.
- API keys should live in OpenClaw config or secrets, never in source control.

## Troubleshooting

### Inbound messages are not arriving

Check:

- OpenClaw gateway is running.
- The Telnyx Messaging Profile webhook URL points to your public URL.
- The public URL routes to the OpenClaw gateway.
- The route path matches `webhookPath`, default `/telnyx-sms/webhook`.
- Startup logs show a successful public URL self-probe.
- The Telnyx public key was discovered or configured.
- The sender is allowed by `dmSecurity` and `allowFrom`.

### Webhook signature errors

Check:

- `publicKey` is the Telnyx account-wide Ed25519 public key.
- The request body is not modified by a proxy before reaching OpenClaw.
- The public key belongs to the same Telnyx account that sends the webhook.

### Outbound sends fail

Check:

- `apiKey` is valid.
- `defaultFromNumber` belongs to the Telnyx account.
- The number is SMS/MMS capable.
- The recipient is in `allowFrom` when `dmSecurity` is `allowlist`.
- US A2P traffic has approved 10DLC registration where required.

### Webhook configuration was skipped

If logs mention an existing foreign webhook, the plugin is protecting another integration.

Options:

1. Manually update the Telnyx Messaging Profile webhook in the portal.
2. Use a separate Messaging Profile and number for OpenClaw.
3. Set `overwriteExistingWebhook: true` only when you intentionally want OpenClaw to replace the existing webhook.

### MMS media is blocked

The plugin blocks risky media URLs before passing MMS attachments to OpenClaw.

Check that the media URL is HTTPS, belongs to an expected Telnyx media host, and is not a private, localhost, or metadata-service address.

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

## Support

For plugin bugs, open an issue in the source repository.

For Telnyx account, phone number, campaign, or Messaging API issues, contact Telnyx Support.

When asking for help, include:

- OpenClaw version
- Plugin version
- Exposure method, for example `publicUrl`, `cloudflared`, `ngrok`, or Tailscale Funnel
- Telnyx Messaging Profile ID, if available
- Relevant OpenClaw gateway logs with API keys and phone numbers redacted

## License

MIT
