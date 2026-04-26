import { describe, it, expect, vi, beforeEach } from "vitest";
import { resolveAccount } from "./channel.js";
import { parseInboundPayload, verifyWebhookSignature } from "./webhook.js";
import { TelnyxClient } from "./client.js";
import type { TelnyxSmsConfig, TelnyxWebhookPayload } from "./types.js";

// ─── resolveAccount ───────────────────────────────────────────────

describe("resolveAccount", () => {
  it("resolves default account from config", () => {
    const cfg = {
      channels: {
        "telnyx-sms": {
          apiKey: "test-key",
          messagingProfileId: "profile-1",
          defaultFromNumber: "+1234567890",
          allowFrom: ["+0987654321"],
          dmSecurity: "allowlist" as const,
        },
      },
    };
    const account = resolveAccount(cfg as any, undefined);
    expect(account.apiKey).toBe("test-key");
    expect(account.defaultFromNumber).toBe("+1234567890");
    expect(account.allowFrom).toEqual(["+0987654321"]);
    expect(account.dmPolicy).toBe("allowlist");
    expect(account.accountId).toBeNull();
  });

  it("resolves named account from config", () => {
    const cfg = {
      channels: {
        "telnyx-sms": {
          apiKey: "default-key",
          accounts: {
            work: {
              apiKey: "work-key",
              defaultFromNumber: "+1111111111",
            },
          },
        },
      },
    };
    const account = resolveAccount(cfg as any, "work");
    expect(account.apiKey).toBe("work-key");
    expect(account.accountId).toBe("work");
    expect(account.defaultFromNumber).toBe("+1111111111");
  });

  it("throws when apiKey is missing on default", () => {
    const cfg = {
      channels: {
        "telnyx-sms": { defaultFromNumber: "+1234567890" },
      },
    };
    expect(() => resolveAccount(cfg as any, undefined)).toThrow("apiKey is required");
  });

  it("throws when apiKey is missing on named account", () => {
    const cfg = {
      channels: {
        "telnyx-sms": {
          apiKey: "default-key",
          accounts: { work: { defaultFromNumber: "+1111111111" } },
        },
      },
    };
    expect(() => resolveAccount(cfg as any, "work")).toThrow("missing apiKey");
  });

  it("throws when named account not found", () => {
    const cfg = {
      channels: {
        "telnyx-sms": { apiKey: "default-key" },
      },
    };
    expect(() => resolveAccount(cfg as any, "nonexistent")).toThrow("account \"nonexistent\" not found");
  });

  it("defaults allowFrom to empty array", () => {
    const cfg = {
      channels: { "telnyx-sms": { apiKey: "test-key" } },
    };
    const account = resolveAccount(cfg as any, undefined);
    expect(account.allowFrom).toEqual([]);
  });

  it("preserves publicKey", () => {
    const cfg = {
      channels: {
        "telnyx-sms": { apiKey: "test-key", publicKey: "pk-b64" },
      },
    };
    const account = resolveAccount(cfg as any, undefined);
    expect(account.publicKey).toBe("pk-b64");
  });
});

// ─── parseInboundPayload ──────────────────────────────────────────

describe("parseInboundPayload", () => {
  it("parses a valid inbound SMS payload", () => {
    const payload: TelnyxWebhookPayload = {
      data: {
        event_type: "message.received",
        payload: {
          from: { phone_number: "+0987654321" },
          to: { phone_number: "+1234567890" },
          text: "Hello!",
          media: [],
          message_id: "msg-123",
        },
      },
    };

    const result = parseInboundPayload(payload);
    expect(result).not.toBeNull();
    expect(result!.from).toBe("+0987654321");
    expect(result!.to).toBe("+1234567890");
    expect(result!.text).toBe("Hello!");
    expect(result!.messageId).toBe("msg-123");
    expect(result!.media).toHaveLength(0);
  });

  it("parses inbound MMS with media", () => {
    const payload: TelnyxWebhookPayload = {
      data: {
        payload: {
          from: { phone_number: "+0987654321" },
          to: { phone_number: "+1234567890" },
          text: "Check this out",
          media: [
            { url: "https://example.com/image.jpg", content_type: "image/jpeg" },
          ],
        },
      },
    };

    const result = parseInboundPayload(payload);
    expect(result!.media).toHaveLength(1);
    expect(result!.media[0].url).toBe("https://example.com/image.jpg");
    expect(result!.media[0].contentType).toBe("image/jpeg");
  });

  it("returns null for missing from", () => {
    const payload = {
      data: { payload: { to: { phone_number: "+1234567890" }, text: "Hi" } },
    };
    expect(parseInboundPayload(payload as any)).toBeNull();
  });

  it("returns null for missing to", () => {
    const payload = {
      data: { payload: { from: { phone_number: "+0987654321" }, text: "Hi" } },
    };
    expect(parseInboundPayload(payload as any)).toBeNull();
  });

  it("returns null for empty object", () => {
    expect(parseInboundPayload({} as any)).toBeNull();
    expect(parseInboundPayload({ data: {} } as any)).toBeNull();
    expect(parseInboundPayload({ data: { payload: {} } } as any)).toBeNull();
  });

  it("handles missing text gracefully", () => {
    const payload: TelnyxWebhookPayload = {
      data: {
        payload: {
          from: { phone_number: "+0987654321" },
          to: { phone_number: "+1234567890" },
          media: [],
        },
      },
    };
    const result = parseInboundPayload(payload);
    expect(result!.text).toBeUndefined();
  });

  it("preserves messagingProfileId", () => {
    const payload: TelnyxWebhookPayload = {
      data: {
        payload: {
          from: { phone_number: "+0987654321" },
          to: { phone_number: "+1234567890" },
          messaging_profile_id: "profile-abc",
        },
      },
    };
    const result = parseInboundPayload(payload);
    expect(result!.messagingProfileId).toBe("profile-abc");
  });
});

// ─── verifyWebhookSignature (Ed25519) ─────────────────────────────

describe("verifyWebhookSignature", () => {
  // Generate a test Ed25519 keypair and return { publicKeyB64, sign(body, ts) }
  function makeSigner() {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const crypto = require("crypto") as typeof import("crypto");
    const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
    const raw = publicKey.export({ format: "der", type: "spki" }).slice(-32);
    const publicKeyB64 = raw.toString("base64");
    return {
      publicKeyB64,
      sign: (body: string, ts: string) => {
        const sig = crypto.sign(
          null,
          Buffer.from(`${ts}|${body}`, "utf8"),
          privateKey,
        );
        return sig.toString("base64");
      },
    };
  }

  it("returns false when any input is missing", () => {
    expect(verifyWebhookSignature("body", undefined, "123", "pk")).toBe(false);
    expect(verifyWebhookSignature("body", "sig", undefined, "pk")).toBe(false);
    expect(verifyWebhookSignature("body", "sig", "123", "")).toBe(false);
  });

  it("verifies a valid Ed25519 signature", () => {
    const { publicKeyB64, sign } = makeSigner();
    const body = '{"data":{"payload":{}}}';
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = sign(body, ts);
    expect(verifyWebhookSignature(body, sig, ts, publicKeyB64)).toBe(true);
  });

  it("rejects a tampered body", () => {
    const { publicKeyB64, sign } = makeSigner();
    const body = '{"data":{"payload":{}}}';
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = sign(body, ts);
    expect(verifyWebhookSignature("tampered", sig, ts, publicKeyB64)).toBe(false);
  });

  it("rejects a stale timestamp (replay protection)", () => {
    const { publicKeyB64, sign } = makeSigner();
    const body = '{"data":{"payload":{}}}';
    const ts = String(Math.floor(Date.now() / 1000) - 3600); // 1hr old
    const sig = sign(body, ts);
    expect(verifyWebhookSignature(body, sig, ts, publicKeyB64)).toBe(false);
  });

  it("rejects signature from a different key", () => {
    const signer = makeSigner();
    const other = makeSigner();
    const body = '{"data":{"payload":{}}}';
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = signer.sign(body, ts);
    expect(verifyWebhookSignature(body, sig, ts, other.publicKeyB64)).toBe(false);
  });

  it("rejects a malformed public key", () => {
    const body = '{"data":{"payload":{}}}';
    const ts = String(Math.floor(Date.now() / 1000));
    expect(verifyWebhookSignature(body, "sig", ts, "not-a-key")).toBe(false);
  });
});

// ─── TelnyxClient ─────────────────────────────────────────────────

describe("TelnyxClient", () => {
  it("sends SMS via the API", async () => {
    const mockResponse = {
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          id: "msg-abc",
          from: { phone_number: "+1234567890" },
          to: { phone_number: "+0987654321" },
          text: "Hello!",
        },
      }),
    };

    const originalFetch = globalThis.fetch;
    // @ts-ignore
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse);

    const client = new TelnyxClient("test-key");
    const result = await client.sendMessage({
      from: "+1234567890",
      to: "+0987654321",
      text: "Hello!",
    });

    expect(result.data.id).toBe("msg-abc");
    expect(fetch).toHaveBeenCalledWith(
      "https://api.telnyx.com/v2/messages",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer test-key",
        }),
      }),
    );

    globalThis.fetch = originalFetch;
  });

  it("sends MMS with media_urls", async () => {
    const mockResponse = {
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          id: "msg-mms",
          from: { phone_number: "+1234567890" },
          to: { phone_number: "+0987654321" },
          text: "Check this",
          media: [{ url: "https://example.com/img.jpg", content_type: "image/jpeg" }],
        },
      }),
    };

    const originalFetch = globalThis.fetch;
    // @ts-ignore
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse);

    const client = new TelnyxClient("test-key");
    const result = await client.sendMessage({
      from: "+1234567890",
      to: "+0987654321",
      text: "Check this",
      media_urls: ["https://example.com/img.jpg"],
    });

    expect(result.data.id).toBe("msg-mms");
    const callBody = JSON.parse((fetch as any).mock.calls[0][1].body);
    expect(callBody.media_urls).toEqual(["https://example.com/img.jpg"]);

    globalThis.fetch = originalFetch;
  });

  it("throws on API error", async () => {
    const mockResponse = {
      ok: false,
      status: 422,
      text: async () => '{"errors":["Invalid phone number"]}',
    };

    const originalFetch = globalThis.fetch;
    // @ts-ignore
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse);

    const client = new TelnyxClient("test-key");
    await expect(
      client.sendMessage({
        from: "+1234567890",
        to: "invalid",
        text: "Hi",
      }),
    ).rejects.toThrow("Telnyx API error 422");

    globalThis.fetch = originalFetch;
  });
});
