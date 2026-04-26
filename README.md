# telnyx-sms-channel

OpenClaw channel plugin that sends and receives SMS/MMS via the Telnyx
Messaging API. An inbound text becomes a direct-DM into the OpenClaw runtime;
the agent's reply is sent back over Telnyx as an SMS.

## What it does

- Registers an HTTP route on the OpenClaw gateway to receive Telnyx webhooks
- **Auto-configures the Telnyx messaging profile on every startup** — sets
  `webhook_url` to the live public URL, merges country codes derived from
  `allowFrom` into `whitelisted_destinations`, all without you touching the
  Telnyx dashboard
- Verifies inbound webhooks with the org Ed25519 public key (defense in depth)
- Auto-discovers your Telnyx defaults (number, messaging profile, public key)
  from the API key alone — one-field setup in the common case
- Self-probes the URL before pushing it to Telnyx (never registers a URL it
  can't prove routes back to this gateway)
- Runs a 5-minute watchdog post-setup: re-probes routing and re-checks the
  Telnyx-stored webhook URL, logs drift on transitions

## Prerequisites

- **OpenClaw gateway** installed and configured (`openclaw configure`).
  Plugin is loaded into a running gateway, not standalone.
- **Node.js 20+** (matches OpenClaw's runtime)
- **Telnyx account** with:
  - At least one phone number (SMS-capable)
  - A messaging profile (the plugin can create one if you opt in via
    `autoCreateProfile: true`)
  - An API key with `messaging:read` and `messaging:write` scopes
- **Public URL for the webhook.** Pick one:
  - `cloudflared` (`brew install cloudflared`) for a quick tunnel
  - `ngrok` with a reserved domain (recommended for stability)
  - Tailscale Funnel
  - Your own stable HTTPS endpoint that proxies `/telnyx-sms/webhook` to
    `http://127.0.0.1:18789` on the host

> You do **not** need to manually set the webhook URL in the Telnyx portal.
> The plugin PATCHes the messaging profile on every gateway start. Just hand
> it an API key + a number + a profile (or let it auto-create the profile).

## Install

```bash
git clone git@github.com:team-telnyx/telnyx-sms-channel.git
cd telnyx-sms-channel
npm install
openclaw plugin install --path .
```

This registers the plugin under `~/.openclaw/extensions/telnyx-sms` and adds
the entry to `~/.openclaw/openclaw.json` under `plugins.installs`.

## Configure

Edit `~/.openclaw/openclaw.json` and add a `channels.telnyx-sms` block. The
minimal config is just an API key — defaults are discovered:

```json
{
  "channels": {
    "telnyx-sms": {
      "apiKey": "KEY...",
      "allowFrom": ["+15551234567"],
      "exposure": {
        "publicUrl": "https://your-tunnel.example.com"
      }
    }
  }
}
```

Full config:

| Field                       | Required | Default                  | Notes |
|-----------------------------|----------|--------------------------|-------|
| `apiKey`                    | yes      | —                        | Telnyx API v2 key |
| `defaultFromNumber`         | no       | first number on account  | E.164, e.g. `+18005551234` |
| `messagingProfileId`        | no       | first profile on account | UUID |
| `publicKey`                 | no       | fetched from Telnyx API  | Ed25519, base64 |
| `allowFrom`                 | no       | `[]` (deny all inbound)  | Allowlist of E.164 numbers, or `["*"]` for open |
| `dmSecurity`                | no       | `allowlist`              | `allowlist` or `open` |
| `exposure.publicUrl`        | yes\*    | —                        | Stable HTTPS URL Telnyx will POST to |
| `exposure.tunnel.provider`  | no       | —                        | `cloudflared` or `ngrok` (auto-launches) |
| `webhookPath`               | no       | `/telnyx-sms/webhook`    | Only change if you have a routing reason |
| `overwriteExistingWebhook`  | no       | `false`                  | Force-overwrite a profile webhook that isn't ours |
| `autoCreateProfile`         | no       | `false`                  | Let the plugin create a profile + attach an orphan number |
| `profileName`               | no       | derived from agent name  | Used only when auto-creating |

\* Either `exposure.publicUrl` OR `exposure.tunnel` must be set.

### Quick start with cloudflared (free, ephemeral)

```bash
brew install cloudflared
cloudflared tunnel --url http://127.0.0.1:18789
# Copy the printed https://*.trycloudflare.com URL into exposure.publicUrl
```

> Free trycloudflare URLs change every restart. For production use a named
> tunnel with a custom domain, or an ngrok reserved domain.

## Run

```bash
openclaw gateway restart
tail -f ~/.openclaw/logs/gateway.log | grep telnyx-sms
```

A clean startup logs:

```
[telnyx-sms] registered inbound webhook route at /telnyx-sms/webhook
[telnyx-sms] auto-discovered webhook public key from Telnyx API
[telnyx-sms] webhook exposed via configured: https://...
[telnyx-sms] publicUrl self-probe OK — ... reaches this gateway (401 as expected)
[telnyx-sms] configured messaging profile <id> webhook → https://.../telnyx-sms/webhook
[telnyx-sms] watchdog active — re-checking routing + Telnyx state every 5m
```

Test by texting your Telnyx number from a number in `allowFrom`. The agent's
reply comes back over SMS.

## How it works

```
inbound SMS  → Telnyx → POST publicUrl/telnyx-sms/webhook
             → gateway HTTP route
             → Ed25519 signature check
             → dispatchInboundDirectDmWithRuntime → agent
             → deliver(text) → Telnyx /v2/messages → outbound SMS
```

Three safety nets:

1. **Pre-PATCH self-probe.** Before telling Telnyx where to POST, the plugin
   POSTs to that exact URL itself and expects 401 from its own handler.
   Anything else (200/404/timeout) means the URL is misrouted, and the PATCH
   is skipped.
2. **Stale-self detection.** If the profile already has a webhook URL on a
   known dev-tunnel host (`*.trycloudflare.com`, `*.ngrok.io`, …) it's
   treated as our own stale URL and overwritten without forcing
   `overwriteExistingWebhook`. Foreign integrations are preserved.
3. **Watchdog.** Every 5 minutes after setup, re-runs the self-probe and
   re-fetches the Telnyx-stored `webhook_url`. Logs on transitions only
   (no spam during persistent outages).

## Troubleshooting

| Symptom in logs                                    | Fix |
|----------------------------------------------------|-----|
| `self-probe attempt N/3: ... returned 503`         | Public key not yet discovered. Restart gateway; if it persists, paste the key from portal.telnyx.com/#/account/public-key into `publicKey`. |
| `self-probe ... returned 200` (or 404)             | `publicUrl` points to the wrong process. Check the tunnel target is `http://127.0.0.1:18789`. |
| `skipping Telnyx webhook auto-configure`           | Probe failed all 3 attempts. Tunnel is down or `publicUrl` stale. |
| `skipped_foreign_webhook`                          | Profile has a non-OpenClaw webhook. Set `overwriteExistingWebhook: true` or use a different `messagingProfileId`. |
| `watchdog: ... no longer routes to this gateway`   | Tunnel died or rotated. Restart the tunnel; on next gateway restart it re-PATCHes Telnyx. |
| `watchdog: Telnyx profile webhook drifted`         | Someone (or another integration) edited the profile in the portal. Restart gateway to reconcile. |
| Inbound texts silently lost                        | Check `allowFrom` includes the sender (E.164). Default policy is allowlist. |
| 401 on outbound `/v2/messages`                     | API key invalid or scope-limited. |
| `40010 destination not whitelisted`                | Plugin auto-derives countries from `allowFrom`; add the recipient's number to `allowFrom` and restart. |

## Security model

- **Inbound:** Ed25519 signature required. Unsigned/invalid → 401 dropped.
  Allowlist filter applied after signature check.
- **Outbound:** `assertOutboundAllowed` enforces `allowFrom` before send;
  `dmSecurity: "open"` disables this — use only with explicit consent.
- **Webhook URL:** never registered without a successful self-probe.
- **Foreign webhook protection:** never silently overwrites a non-self-owned
  profile webhook.

## Development

```bash
npm install
npm test                    # vitest
npx tsc --noEmit            # type check
```

Plugin source layout:

```
index.ts                  # registerFull entry, watchdog
src/channel.ts            # outbound, account resolution, dmSecurity
src/inbound.ts            # webhook handler, profile configure, watchdog helper
src/discover.ts           # one-key auto-discovery of profile/number/public key
src/exposure.ts           # tunnel + publicUrl resolution
src/webhook.ts            # Ed25519 verify, payload parse
src/client.ts             # thin Telnyx /v2/messages client
```

## License

Internal — Telnyx team only.
