import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import type { WizardPrompter } from "openclaw/plugin-sdk/setup";
import type { TelnyxSmsConfig, WebhookExposureConfig } from "./types.js";

type ExposureChoice = "auto" | "ngrok" | "cloudflared" | "tailscale" | "publicUrl" | "skip";

/** Describe the currently configured exposure in one line for UI hints. */
function describeExposure(exposure: WebhookExposureConfig | undefined): string {
  if (!exposure) return "auto-detect";
  if (exposure.publicUrl) return `publicUrl (${exposure.publicUrl})`;
  if (exposure.tunnel?.provider) return `tunnel: ${exposure.tunnel.provider}`;
  if (exposure.tailscale?.mode === "funnel") return "tailscale funnel";
  return "auto-detect";
}

/** Build a new config with updated exposure under channels.telnyx-sms. */
function applyExposure(
  cfg: OpenClawConfig,
  exposure: WebhookExposureConfig | undefined,
): OpenClawConfig {
  const section = (cfg as TelnyxSmsConfig).channels?.["telnyx-sms"] ?? {};
  const nextSection = { ...section };
  if (exposure === undefined) {
    delete (nextSection as { exposure?: WebhookExposureConfig }).exposure;
  } else {
    nextSection.exposure = exposure;
  }
  return {
    ...cfg,
    channels: {
      ...(cfg as TelnyxSmsConfig).channels,
      "telnyx-sms": nextSection,
    },
  } as OpenClawConfig;
}

/** Prompt for exposure provider during `openclaw configure telnyx-sms`. */
export async function promptExposure(params: {
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
}): Promise<OpenClawConfig> {
  const { cfg, prompter } = params;
  const section = (cfg as TelnyxSmsConfig).channels?.["telnyx-sms"];
  const current = section?.exposure;

  await prompter.note(
    [
      `Current: ${describeExposure(current)}`,
      "Telnyx sends inbound SMS to a public webhook URL.",
      "Pick how this machine should be reachable from the public internet.",
    ].join("\n"),
    "Telnyx webhook exposure",
  );

  const choice = await prompter.select<ExposureChoice>({
    message: "How should Telnyx reach your webhook?",
    initialValue: current?.publicUrl
      ? "publicUrl"
      : current?.tunnel?.provider === "cloudflared"
        ? "cloudflared"
        : current?.tunnel?.provider === "ngrok"
          ? "ngrok"
          : current?.tailscale?.mode === "funnel"
            ? "tailscale"
            : "auto",
    options: [
      { value: "publicUrl", label: "Use a fixed public URL", hint: "paste a URL you already own" },
      { value: "cloudflared", label: "Cloudflare Tunnel", hint: "needs `cloudflared` installed" },
      { value: "ngrok", label: "ngrok", hint: "dynamic URL — rotates on every restart" },
      { value: "tailscale", label: "Tailscale Funnel", hint: "needs funnel enabled on tailnet" },
      { value: "auto", label: "Auto-detect", hint: "pick whichever tool is available" },
      { value: "skip", label: "Skip for now", hint: "inbound SMS disabled" },
    ],
  });

  if (choice === "skip") {
    return applyExposure(cfg, undefined);
  }

  if (choice === "auto") {
    return applyExposure(cfg, undefined);
  }

  if (choice === "publicUrl") {
    const url = await prompter.text({
      message: "Public URL for the webhook (must end at your gateway host, path is appended)",
      placeholder: "https://telnyx.example.com",
      initialValue: current?.publicUrl,
      validate: (v) => {
        const trimmed = v.trim();
        if (!trimmed) return "URL is required";
        if (!/^https?:\/\//i.test(trimmed)) return "must start with http(s)://";
        return undefined;
      },
    });
    return applyExposure(cfg, { publicUrl: url.trim() });
  }

  if (choice === "tailscale") {
    return applyExposure(cfg, { tailscale: { mode: "funnel" } });
  }

  // ngrok or cloudflared
  return applyExposure(cfg, { tunnel: { provider: choice } });
}

/** Build the setupWizard entry for the telnyx-sms plugin. */
export function buildTelnyxSmsSetupWizard() {
  return {
    channel: "telnyx-sms",
    resolveShouldPromptAccountIds: () => false,
    status: {
      configuredLabel: "configured",
      unconfiguredLabel: "needs API key",
      configuredHint: "configured",
      unconfiguredHint: "needs Telnyx API key",
      configuredScore: 1,
      unconfiguredScore: 0,
      resolveConfigured: ({ cfg }: { cfg: OpenClawConfig }) => {
        const section = (cfg as TelnyxSmsConfig).channels?.["telnyx-sms"];
        return Boolean(section?.apiKey);
      },
      resolveStatusLines: ({ cfg, configured }: { cfg: OpenClawConfig; configured: boolean }) => {
        if (!configured) return ["Telnyx SMS: set apiKey in openclaw.json first"];
        const section = (cfg as TelnyxSmsConfig).channels?.["telnyx-sms"];
        return [`Telnyx SMS: exposure = ${describeExposure(section?.exposure)}`];
      },
    },
    credentials: [],
    prepare: async (ctx: { cfg: OpenClawConfig; prompter: WizardPrompter }) => {
      const nextCfg = await promptExposure({ cfg: ctx.cfg, prompter: ctx.prompter });
      return { cfg: nextCfg };
    },
  };
}
