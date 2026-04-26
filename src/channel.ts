import {
  createChatChannelPlugin,
  createChannelPluginBase,
} from "openclaw/plugin-sdk/channel-core";
import { createHybridChannelConfigBase } from "openclaw/plugin-sdk/channel-config-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import type { ResolvedAccount, TelnyxSmsConfig } from "./types.js";
import { TelnyxClient } from "./client.js";
import { verifyWebhookSignature, parseInboundPayload } from "./webhook.js";
import { buildTelnyxSmsSetupWizard } from "./setup-wizard.js";

/**
 * Runtime-discovered defaults (populated at startup from Telnyx API when the
 * user hasn't explicitly configured defaultFromNumber/messagingProfileId/publicKey).
 * Keyed by accountId ("default" for the top-level section).
 */
const discoveredDefaults = new Map<
  string,
  { fromNumber?: string; messagingProfileId?: string; publicKey?: string }
>();

/** Called by registerFull after it resolves numbers+profile+publicKey via discovery. */
export function setDiscoveredDefaults(
  accountId: string,
  values: { fromNumber?: string; messagingProfileId?: string; publicKey?: string },
): void {
  const prev = discoveredDefaults.get(accountId) ?? {};
  discoveredDefaults.set(accountId, { ...prev, ...values });
}

/** List configured account IDs (default + named accounts under .accounts). */
function listTelnyxSmsAccountIds(cfg: OpenClawConfig): string[] {
  const section = (cfg as TelnyxSmsConfig).channels?.["telnyx-sms"];
  const ids: string[] = [];
  if (section?.apiKey) ids.push("default");
  if (section?.accounts) {
    for (const name of Object.keys(section.accounts)) {
      if (name !== "default") ids.push(name);
    }
  }
  return ids;
}

/** Pick the default account id — "default" if top-level configured, else first named account. */
function defaultTelnyxSmsAccountId(cfg: OpenClawConfig): string {
  const ids = listTelnyxSmsAccountIds(cfg);
  return ids[0] ?? "default";
}

/**
 * Resolve account config from OpenClaw config.
 * Supports multi-account via channels.telnyx-sms.accounts.<id>.
 */
export function resolveAccount(
  cfg: OpenClawConfig,
  accountId?: string | null,
): ResolvedAccount {
  const section = (cfg as TelnyxSmsConfig).channels?.["telnyx-sms"];

  // Multi-account lookup
  if (accountId && section?.accounts?.[accountId]) {
    const acct = section.accounts[accountId];
    if (!acct.apiKey) throw new Error(`telnyx-sms: account ${accountId} missing apiKey`);
    const discovered = discoveredDefaults.get(accountId) ?? {};
    return {
      accountId,
      apiKey: acct.apiKey,
      messagingProfileId: acct.messagingProfileId ?? discovered.messagingProfileId,
      defaultFromNumber: acct.defaultFromNumber ?? discovered.fromNumber,
      allowFrom: acct.allowFrom ?? [],
      dmPolicy: acct.dmSecurity,
      publicKey: acct.publicKey || discovered.publicKey,
    };
  }

  // Named account not found — refuse to silently fall through to default
  if (accountId && accountId !== "default") {
    throw new Error(
      `telnyx-sms: account "${accountId}" not found in channels.telnyx-sms.accounts. ` +
      `Available accounts: ${section?.accounts ? Object.keys(section.accounts).join(", ") : "(none)"}`,
    );
  }

  // Default account
  if (!section?.apiKey) throw new Error("telnyx-sms: apiKey is required");
  const discovered = discoveredDefaults.get("default") ?? {};
  return {
    accountId: accountId ?? null,
    apiKey: section.apiKey,
    messagingProfileId: section.messagingProfileId ?? discovered.messagingProfileId,
    defaultFromNumber: section.defaultFromNumber ?? discovered.fromNumber,
    allowFrom: section.allowFrom ?? [],
    dmPolicy: section.dmSecurity,
    publicKey: section.publicKey || discovered.publicKey,
  };
}

function buildOutboundParams(cfg: OpenClawConfig, accountId?: string | null) {
  const account = resolveAccount(cfg, accountId);
  if (!account.defaultFromNumber) {
    throw new Error("telnyx-sms: defaultFromNumber is required for outbound");
  }
  const client = new TelnyxClient(account.apiKey);
  return { account, client };
}

/** Normalize an E.164-ish phone number: strip spaces, dashes, parens. */
function normalizePhone(p: string): string {
  return p.replace(/[\s\-()]/g, "");
}

/**
 * Enforce channels.telnyx-sms.allowFrom on the outbound path. Called before
 * every outbound send so an allowlisted config can never leak messages to
 * unknown destinations.
 *
 * Policy: if dmPolicy === "allowlist" (default) AND allowFrom is non-empty
 * AND doesn't contain "*", the destination MUST match an entry.
 */
export function assertOutboundAllowed(
  account: ResolvedAccount,
  to: string,
): void {
  const policy = account.dmPolicy ?? "allowlist";
  if (policy !== "allowlist") return;
  const list = account.allowFrom ?? [];
  if (list.length === 0) return; // unconfigured = no restriction
  if (list.includes("*")) return;
  const target = normalizePhone(to);
  const ok = list.some((entry) => normalizePhone(entry) === target);
  if (!ok) {
    throw new Error(
      `telnyx-sms: outbound blocked — ${to} is not in channels.telnyx-sms.allowFrom. ` +
      `Add it to the config to permit sends.`,
    );
  }
}

export const telnyxSmsPlugin = createChatChannelPlugin<ResolvedAccount>({
  // @ts-expect-error — createChannelPluginBase infers capabilities as optional but createChatChannelPlugin requires it
  base: createChannelPluginBase<ResolvedAccount>({
    id: "telnyx-sms",
    capabilities: {
      chatTypes: ["direct"],
      media: true,
      reply: false,
      reactions: false,
      edit: false,
    },
    // Interactive prompts during `openclaw configure telnyx-sms`.
    // Currently asks how the webhook should be publicly reachable
    // (publicUrl / cloudflared / ngrok / tailscale / auto).
    setupWizard: buildTelnyxSmsSetupWizard(),
    // Account config adapter — required by the gateway health monitor and
    // other core call sites that invoke plugin.config.listAccountIds(cfg).
    // Without this the entire gateway crashes on plugin load/refresh.
    config: createHybridChannelConfigBase<ResolvedAccount>({
      sectionKey: "telnyx-sms",
      listAccountIds: listTelnyxSmsAccountIds,
      resolveAccount: (cfg, accountId) => resolveAccount(cfg, accountId),
      defaultAccountId: defaultTelnyxSmsAccountId,
      clearBaseFields: [
        "apiKey",
        "defaultFromNumber",
        "messagingProfileId",
        "publicKey",
        "allowFrom",
        "dmSecurity",
        "exposure",
      ],
    }),
    setup: {
      applyAccountConfig: ({ cfg, accountId, input }) => {
        const telnyxConfig = (cfg as TelnyxSmsConfig).channels?.["telnyx-sms"] ?? {};
        const apiKey = input.token;
        const defaultFromNumber = input.name; // Reuse name field for from number during setup

        if (accountId && accountId !== "default") {
          return {
            ...cfg,
            channels: {
              ...(cfg as TelnyxSmsConfig).channels,
              "telnyx-sms": {
                ...telnyxConfig,
                accounts: {
                  ...(telnyxConfig.accounts ?? {}),
                  [accountId]: {
                    ...(telnyxConfig.accounts?.[accountId] ?? {}),
                    ...(apiKey ? { apiKey } : {}),
                    ...(defaultFromNumber ? { defaultFromNumber } : {}),
                  },
                },
              },
            },
          };
        }

        return {
          ...cfg,
          channels: {
            ...(cfg as TelnyxSmsConfig).channels,
            "telnyx-sms": {
              ...telnyxConfig,
              ...(apiKey ? { apiKey } : {}),
              ...(defaultFromNumber ? { defaultFromNumber } : {}),
            },
          },
        };
      },
    },
  }),

  // DM security: allowlist by phone number
  security: {
    dm: {
      channelKey: "telnyx-sms",
      resolvePolicy: (account: ResolvedAccount) => account.dmPolicy ?? "allowlist",
      resolveAllowFrom: (account: ResolvedAccount) => account.allowFrom,
      defaultPolicy: "allowlist",
    },
  },

  // Pairing: verify phone number via SMS code
  pairing: {
    text: {
      idLabel: "Phone number",
      message: "Your verification code is:",
      notify: async ({ cfg, id, message, accountId }: {
        cfg: OpenClawConfig;
        id: string;
        message: string;
        accountId?: string;
      }) => {
        const { account, client } = buildOutboundParams(cfg, accountId);
        assertOutboundAllowed(account, id);
        await client.sendMessage({
          from: account.defaultFromNumber!,
          to: id,
          text: message,
          ...(account.messagingProfileId
            ? { messaging_profile_id: account.messagingProfileId }
            : {}),
        });
      },
    },
  },

  // Threading: each phone number is a conversation
  threading: { topLevelReplyToMode: "none" },

  // Session grammar: phone number = conversation id
  messaging: {
    resolveSessionConversation: ({ rawId }: { rawId: string }) => {
      return { conversationId: rawId };
    },
  },

  // Outbound: send SMS/MMS
  outbound: {
    base: {
      deliveryMode: "direct" as const,
      chunkerMode: "text" as const,
      sendFormattedText: async ({ cfg, to, text, accountId }: {
        cfg: OpenClawConfig;
        to: string;
        text: string;
        accountId?: string | null;
      }) => {
        const { account, client } = buildOutboundParams(cfg, accountId);
        assertOutboundAllowed(account, to);
        const result = await client.sendMessage({
          from: account.defaultFromNumber!,
          to,
          text,
          ...(account.messagingProfileId
            ? { messaging_profile_id: account.messagingProfileId }
            : {}),
        });
        return [{
          channel: "telnyx-sms" as const,
          messageId: result.data.id,
        }];
      },
      sendFormattedMedia: async ({ cfg, to, text, mediaUrl, accountId }: {
        cfg: OpenClawConfig;
        to: string;
        text: string;
        mediaUrl: string;
        accountId?: string | null;
      }) => {
        const { account, client } = buildOutboundParams(cfg, accountId);
        assertOutboundAllowed(account, to);
        const result = await client.sendMessage({
          from: account.defaultFromNumber!,
          to,
          text: text ?? undefined,
          media_urls: mediaUrl ? [mediaUrl] : undefined,
          ...(account.messagingProfileId
            ? { messaging_profile_id: account.messagingProfileId }
            : {}),
        });
        return {
          channel: "telnyx-sms" as const,
          messageId: result.data.id,
        };
      },
    },
    attachedResults: {
      channel: "telnyx-sms",
      sendText: async ({ cfg, to, text, accountId }: {
        cfg: OpenClawConfig;
        to: string;
        text: string;
        accountId?: string | null;
      }) => {
        const { account, client } = buildOutboundParams(cfg, accountId);
        assertOutboundAllowed(account, to);
        const result = await client.sendMessage({
          from: account.defaultFromNumber!,
          to,
          text,
          ...(account.messagingProfileId
            ? { messaging_profile_id: account.messagingProfileId }
            : {}),
        });
        return { messageId: result.data.id };
      },
      sendMedia: async ({ cfg, to, text, mediaUrl, accountId }: {
        cfg: OpenClawConfig;
        to: string;
        text: string;
        mediaUrl?: string;
        accountId?: string | null;
      }) => {
        const { account, client } = buildOutboundParams(cfg, accountId);
        assertOutboundAllowed(account, to);
        const result = await client.sendMessage({
          from: account.defaultFromNumber!,
          to,
          text: text ?? undefined,
          media_urls: mediaUrl ? [mediaUrl] : undefined,
          ...(account.messagingProfileId
            ? { messaging_profile_id: account.messagingProfileId }
            : {}),
        });
        return { messageId: result.data.id };
      },
    },
  },
});
