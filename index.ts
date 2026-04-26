import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { telnyxSmsPlugin, setDiscoveredDefaults, resolveAccount } from "./src/channel.js";
import {
  setTelnyxSmsRuntime,
  handleTelnyxSmsWebhook,
  configureTelnyxWebhook,
  fetchTelnyxProfileWebhookUrl,
} from "./src/inbound.js";
import { resolveWebhookExposure } from "./src/exposure.js";
import {
  discoverDefaults,
  isDiscoveryError,
  createProfileAndAttach,
  findOrphanNumber,
  fetchPublicKey,
} from "./src/discover.js";
import type { TelnyxSmsConfig } from "./src/types.js";

/** Stored cleanup function for the tunnel process. */
let tunnelCleanup: (() => void) | undefined;

/** Stored watchdog timer — cleared on plugin destroy. */
let watchdogTimer: ReturnType<typeof setInterval> | undefined;

/** How often the watchdog re-checks routing + Telnyx state. */
const WATCHDOG_INTERVAL_MS = 5 * 60 * 1000;

/** Per-tick timeout for the lightweight self-probe (no retries — next tick covers transient blips). */
const WATCHDOG_PROBE_TIMEOUT_MS = 8_000;

type ProbeLogger = {
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
} | undefined;

/**
 * POST an unsigned probe to our own webhook URL and check the response.
 * Returns true iff the handler returned 401 (signature missing) — proving the
 * URL routes to THIS gateway's telnyx-sms handler and not some other process.
 *
 * Retries up to 3 attempts (10s timeout each, 2s linear backoff) to ride out
 * cold-start tunnel/DNS warm-up. A 401 anywhere along the way is success.
 */
async function selfProbeWithRetry(
  probeUrl: string,
  gatewayPort: number,
  logger: ProbeLogger,
): Promise<boolean> {
  const maxAttempts = 3;
  const timeoutMs = 10_000;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(probeUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ _probe: "openclaw-telnyx-sms" }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (res.status === 401) {
        logger?.info?.(
          `[telnyx-sms] publicUrl self-probe OK — ${probeUrl} reaches this gateway (401 as expected${attempt > 1 ? `, on attempt ${attempt}` : ""}).`,
        );
        return true;
      }
      logger?.warn?.(
        `[telnyx-sms] self-probe attempt ${attempt}/${maxAttempts}: POST ${probeUrl} returned ${res.status} (expected 401). ` +
        `URL likely points to a different process or port. Tunnel should target http://127.0.0.1:${gatewayPort}.`,
      );
      // Non-401 is unlikely to self-correct between attempts (it's a routing
      // misconfig, not a transient fetch failure), but try once more in case
      // a proxy is mid-startup.
    } catch (err) {
      clearTimeout(timer);
      const message = err instanceof Error ? err.message : String(err);
      logger?.warn?.(
        `[telnyx-sms] self-probe attempt ${attempt}/${maxAttempts} failed (${message}) — could not reach ${probeUrl}.`,
      );
    }
    if (attempt < maxAttempts) {
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
  return false;
}

/**
 * Single-shot self-probe used by the watchdog (no retries — interval handles that).
 * Returns true iff the URL responds with 401 from our own handler.
 */
async function selfProbeOnce(probeUrl: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WATCHDOG_PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(probeUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ _probe: "openclaw-telnyx-sms-watchdog" }),
      signal: controller.signal,
    });
    return res.status === 401;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Periodic post-setup watchdog. Detects two failure modes that the one-shot
 * registration probe can't catch:
 *  - publicUrl stops routing (cloudflared restarted with a new subdomain,
 *    tunnel process died, etc.)
 *  - Telnyx-stored webhook_url drifts away from ours (someone edited the
 *    profile in the dashboard, another integration overwrote it).
 *
 * Edge-triggered logging: only logs on transitions (ok→bad, bad→ok) so a
 * persistent outage doesn't spam the gateway log every 5 minutes.
 */
function startWebhookWatchdog(opts: {
  expectedUrl: string;
  apiKey: string;
  messagingProfileId: string;
  logger: ProbeLogger;
}): void {
  if (watchdogTimer) {
    clearInterval(watchdogTimer);
    watchdogTimer = undefined;
  }
  let lastProbeOk = true;
  let lastUrlMatch = true;

  const tick = async () => {
    const probeOk = await selfProbeOnce(opts.expectedUrl);
    if (!probeOk && lastProbeOk) {
      opts.logger?.warn?.(
        `[telnyx-sms] watchdog: ${opts.expectedUrl} no longer routes to this gateway. ` +
        `Tunnel may be dead or publicUrl stale — inbound SMS will be silently dropped by Telnyx until fixed.`,
      );
    } else if (probeOk && !lastProbeOk) {
      opts.logger?.info?.(`[telnyx-sms] watchdog: ${opts.expectedUrl} self-probe recovered.`);
    }
    lastProbeOk = probeOk;

    const fetched = await fetchTelnyxProfileWebhookUrl(
      opts.apiKey,
      opts.messagingProfileId,
    );
    if (!fetched.ok) {
      opts.logger?.warn?.(
        `[telnyx-sms] watchdog: Telnyx profile fetch failed (${fetched.detail})`,
      );
      return;
    }
    const match = fetched.webhookUrl === opts.expectedUrl;
    if (!match && lastUrlMatch) {
      opts.logger?.warn?.(
        `[telnyx-sms] watchdog: Telnyx profile webhook drifted. ` +
        `stored=${fetched.webhookUrl || "(empty)"} expected=${opts.expectedUrl}. ` +
        `Restart the gateway, or set channels.telnyx-sms.overwriteExistingWebhook=true to reconcile on next start.`,
      );
    } else if (match && !lastUrlMatch) {
      opts.logger?.info?.(`[telnyx-sms] watchdog: Telnyx profile webhook back in sync.`);
    }
    lastUrlMatch = match;
  };

  watchdogTimer = setInterval(() => {
    void tick().catch((err) => {
      opts.logger?.warn?.(
        `[telnyx-sms] watchdog tick failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }, WATCHDOG_INTERVAL_MS);
  if (typeof watchdogTimer.unref === "function") watchdogTimer.unref();
  opts.logger?.info?.(
    `[telnyx-sms] watchdog active — re-checking routing + Telnyx state every ${WATCHDOG_INTERVAL_MS / 60_000}m.`,
  );
}

/**
 * Derive a messaging profile name from the OpenClaw config so the profile
 * shown in the Telnyx dashboard matches the agent the customer is setting up.
 * Priority:
 *  1. channels.telnyx-sms.profileName (explicit override)
 *  2. meta.instance / meta.name (if the gateway exposes one)
 *  3. First agent directory name (from agents config)
 *  4. "OpenClaw Agent"
 */
function deriveProfileName(cfg: unknown): string {
  const c = cfg as {
    channels?: { "telnyx-sms"?: { profileName?: string } };
    meta?: { instance?: string; name?: string };
    agents?: Record<string, unknown>;
  };
  const override = c?.channels?.["telnyx-sms"]?.profileName;
  if (override && typeof override === "string") return override;
  if (c?.meta?.instance) return `OpenClaw — ${c.meta.instance}`;
  if (c?.meta?.name) return `OpenClaw — ${c.meta.name}`;
  const agentKeys = Object.keys(c?.agents ?? {}).filter((k) => k !== "defaults");
  if (agentKeys[0]) return `OpenClaw — ${agentKeys[0]}`;
  return "OpenClaw Agent";
}

export default defineChannelPluginEntry({
  id: "telnyx-sms",
  name: "Telnyx SMS",
  description: "Send and receive SMS/MMS via Telnyx Messaging API",
  plugin: telnyxSmsPlugin,

  // Capture the channel runtime (routing, session, reply dispatch)
  setRuntime: (runtime) => {
    setTelnyxSmsRuntime(runtime);
  },

  registerCliMetadata(api) {
    api.registerCli(
      ({ program }) => {
        program
          .command("telnyx-sms")
          .description("Telnyx SMS channel management");
      },
      {
        descriptors: [
          {
            name: "telnyx-sms",
            description: "Telnyx SMS channel management",
            hasSubcommands: false,
          },
        ],
      },
    );
  },

  // Full registration — register inbound webhook route synchronously FIRST,
  // then perform async discovery/exposure work. The OpenClaw plugin loader
  // wraps `api` in a guarded proxy that disables every method as soon as the
  // synchronous portion of `register` returns; any `api.*` call placed after
  // an `await` becomes a silent no-op, so the route would never reach the
  // gateway's HTTP route registry. Keep the sync prelude minimal and self-
  // contained, then kick off async setup as a fire-and-forget task.
  registerFull(api) {
    const cfg = api.config as TelnyxSmsConfig;
    const account = cfg?.channels?.["telnyx-sms"];
    if (!account) {
      api.logger?.warn?.("[telnyx-sms] no channels.telnyx-sms config found, skipping registration");
      return;
    }
    const exposure = account.exposure;
    const webhookPath = account.webhookPath ?? "/telnyx-sms/webhook";
    const gatewayPort = (api.config as any)?.gateway?.port ?? 18789;

    // SYNC: register the HTTP route up front so the gateway's route registry
    // sees it before the guarded api proxy is closed. The handler reads
    // discovered defaults at request time, so async key discovery below can
    // populate state after this returns.
    api.registerHttpRoute({
      path: webhookPath,
      auth: "plugin",
      match: "exact",
      handler: async (req, res) => {
        await handleTelnyxSmsWebhook(req, res, api.config);
      },
    });
    api.logger?.info?.(`[telnyx-sms] registered inbound webhook route at ${webhookPath}`);

    // ASYNC tail: discovery, exposure, and webhook auto-configuration. Note
    // that `api.*` methods are unreachable here — only `api.logger` is safe
    // because the proxy returns the underlying logger object (not a method).
    void (async () => {
      // Auto-fetch the organization Ed25519 public key if the customer hasn't
      // pasted one. Telnyx exposes it at GET /v2/public_key — one key signs
      // every webhook on the account (SMS, Voice, Verify, Numbers).
      let effectivePublicKey = account?.publicKey;
      if (!effectivePublicKey && account?.apiKey) {
        const pk = await fetchPublicKey(account.apiKey);
        if (pk) {
          effectivePublicKey = pk;
          setDiscoveredDefaults("default", { publicKey: pk });
          api.logger?.info?.(
            "[telnyx-sms] auto-discovered webhook public key from Telnyx API",
          );
        }
      }

      // Without a public key we can't verify webhook signatures. The handler
      // itself rejects unsigned requests, but warn now so operators see it at
      // startup time instead of only when a webhook arrives.
      if (!effectivePublicKey) {
        api.logger?.warn?.(
          "[telnyx-sms] could not obtain a webhook Ed25519 public key. " +
          "Inbound webhook will reject all requests until a key is provided. " +
          "Check that channels.telnyx-sms.apiKey is valid, or paste the key from " +
          "https://portal.telnyx.com/#/account/public-key into channels.telnyx-sms.publicKey.",
        );
      }

      // If the customer only set apiKey (no defaultFromNumber / messagingProfileId),
      // discover them from the Telnyx account so setup is truly one-field.
      if (account.apiKey && (!account.defaultFromNumber || !account.messagingProfileId)) {
        let discovered = await discoverDefaults(account.apiKey, {
          preferredNumber: account.defaultFromNumber,
        });

        if (isDiscoveryError(discovered) && discovered.code === "no_profile") {
          const orphan = await findOrphanNumber(account.apiKey, account.defaultFromNumber);
          if (orphan) {
            const profileName = deriveProfileName(cfg);
            if (account.autoCreateProfile !== true) {
              api.logger?.warn?.(
                `[telnyx-sms] account has no messaging profile. The plugin can create one for you:\n` +
                `    profile name : "${profileName}"\n` +
                `    attach number: ${orphan.phone_number}\n` +
                `  This will make API calls to Telnyx (visible in your dashboard).\n` +
                `  Note: if this number already has a messaging profile, its webhook URL will be updated.\n` +
                `  To opt in, set channels.telnyx-sms.autoCreateProfile=true in openclaw.json,\n` +
                `  or create the profile manually at https://portal.telnyx.com/#/app/messaging`,
              );
            } else {
              api.logger?.info?.(
                `[telnyx-sms] autoCreateProfile=true — creating profile "${profileName}" and attaching ${orphan.phone_number}`,
              );
              const newProfileId = await createProfileAndAttach(
                account.apiKey,
                profileName,
                orphan.id,
              );
              if (newProfileId) {
                discovered = {
                  fromNumber: orphan.phone_number,
                  messagingProfileId: newProfileId,
                };
                api.logger?.info?.(
                  `[telnyx-sms] created profile ${newProfileId} and attached ${orphan.phone_number}`,
                );
              }
            }
          }
        }

        if (isDiscoveryError(discovered)) {
          api.logger?.warn?.(
            `[telnyx-sms] account discovery failed (${discovered.code}): ${discovered.message}` +
            (discovered.hint ? ` — ${discovered.hint}` : ""),
          );
          if (
            discovered.code === "no_numbers" ||
            discovered.code === "no_profile"
          ) {
            api.logger?.warn?.(
              "[telnyx-sms] inbound and outbound SMS disabled until account setup is resolved.",
            );
            return;
          }
        } else {
          setDiscoveredDefaults("default", {
            fromNumber: discovered.fromNumber,
            messagingProfileId: discovered.messagingProfileId,
          });
          api.logger?.info?.(
            `[telnyx-sms] auto-discovered defaults: from=${discovered.fromNumber}, profile=${discovered.messagingProfileId}`,
          );
        }
      }

      let result: Awaited<ReturnType<typeof resolveWebhookExposure>> = null;
      try {
        result = await resolveWebhookExposure(exposure, gatewayPort, webhookPath);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        api.logger?.warn?.(
          `[telnyx-sms] tunnel startup failed (${message}). ` +
          "Inbound SMS disabled. Set channels.telnyx-sms.exposure.publicUrl to a stable URL to recover.",
        );
        return;
      }

      if (!result) {
        api.logger?.warn?.(
          "[telnyx-sms] inbound SMS will not work — no public URL configured. " +
          "Set channels.telnyx-sms.exposure.publicUrl, or install ngrok/cloudflared/enable Tailscale Funnel.",
        );
        return;
      }

      tunnelCleanup = result.cleanup;
      api.logger?.info?.(`[telnyx-sms] webhook exposed via ${result.method}: ${result.publicUrl}`);

      // Telnyx stores webhook_url verbatim and POSTs to it as-is. We MUST
      // include the plugin's path suffix when telling Telnyx — otherwise
      // inbound webhooks hit the gateway root (the dashboard SPA), not our
      // /telnyx-sms/webhook handler, and SMS silently disappears.
      const fullWebhookUrl = `${result.publicUrl.replace(/\/$/, "")}${webhookPath}`;

      // Self-probe: POST to the EXACT URL Telnyx will use, with retries to
      // ride out cold-start tunnel/DNS hiccups. Expecting 401 from our own
      // handler proves the URL actually reaches THIS gateway. Anything else
      // (200/404/timeout) means the URL is pointing somewhere else (stale
      // tunnel, wrong port, foreign service) and Telnyx would silently drop
      // every inbound SMS. We gate the Telnyx PATCH on this — never push a
      // URL we can't prove works.
      const probeOk = await selfProbeWithRetry(
        fullWebhookUrl,
        gatewayPort,
        api.logger,
      );
      if (!probeOk) {
        api.logger?.warn?.(
          `[telnyx-sms] skipping Telnyx webhook auto-configure — publicUrl ${fullWebhookUrl} did not pass the self-probe. ` +
          `Resolve the routing issue (tunnel down, wrong port, or stale publicUrl) and restart, ` +
          `or set the webhook manually in Telnyx Portal once the URL is reachable.`,
        );
        return;
      }

      let resolved;
      try {
        resolved = resolveAccount(cfg, null);
      } catch {
        api.logger?.warn?.(
          `[telnyx-sms] cannot auto-configure webhook — apiKey missing. ` +
          `Set it manually in the Telnyx dashboard to: ${fullWebhookUrl}`,
        );
        return;
      }

      if (!resolved.messagingProfileId) {
        api.logger?.warn?.(
          `[telnyx-sms] no messagingProfileId resolved — webhook URL NOT auto-registered. ` +
          `Set it manually in the Telnyx dashboard to: ${fullWebhookUrl}`,
        );
        return;
      }

      const overwrite = cfg?.channels?.["telnyx-sms"]?.overwriteExistingWebhook === true;
      const outcome = await configureTelnyxWebhook(
        resolved.apiKey,
        resolved.messagingProfileId,
        fullWebhookUrl,
        resolved.allowFrom ?? [],
        { overwrite },
      );
      if (outcome.status === "configured") {
        api.logger?.info?.(
          `[telnyx-sms] configured messaging profile ${resolved.messagingProfileId} webhook → ${outcome.storedUrl}`,
        );
        startWebhookWatchdog({
          expectedUrl: outcome.storedUrl,
          apiKey: resolved.apiKey,
          messagingProfileId: resolved.messagingProfileId,
          logger: api.logger,
        });
      } else if (outcome.status === "verify_mismatch") {
        api.logger?.warn?.(
          `[telnyx-sms] post-PATCH verification MISMATCH on profile ${resolved.messagingProfileId}: ` +
          `we sent ${outcome.sentUrl} but Telnyx stored ${outcome.storedUrl}. ` +
          `Inbound webhooks will go to the stored URL. Reconcile manually in Telnyx Portal.`,
        );
      } else if (outcome.status === "skipped_foreign_webhook") {
        api.logger?.warn?.(
          `[telnyx-sms] profile ${resolved.messagingProfileId} already has a webhook URL set to: ${outcome.existingUrl}\n` +
          `  Refusing to overwrite (looks like a foreign integration, not a stale OpenClaw tunnel). Either:\n` +
          `    (a) set channels.telnyx-sms.overwriteExistingWebhook=true in openclaw.json, or\n` +
          `    (b) use a different messagingProfileId for OpenClaw, or\n` +
          `    (c) manually set the webhook URL in Telnyx to: ${fullWebhookUrl}`,
        );
      } else {
        api.logger?.warn?.(
          `[telnyx-sms] webhook auto-configure failed (${outcome.detail}). ` +
          `Set it manually in the Telnyx dashboard to: ${fullWebhookUrl}`,
        );
      }
    })().catch((err) => {
      api.logger?.warn?.(
        `[telnyx-sms] async setup failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  },

  // Cleanup tunnel on shutdown
  // @ts-expect-error — destroy is called by OpenClaw at gateway shutdown but not yet in the type definition
  destroy() {
    if (watchdogTimer) {
      clearInterval(watchdogTimer);
      watchdogTimer = undefined;
    }
    if (tunnelCleanup) {
      tunnelCleanup();
      tunnelCleanup = undefined;
    }
  },
});
