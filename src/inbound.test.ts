import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleTelnyxSmsWebhook, setTelnyxSmsRuntime } from "./inbound.js";
import { telnyxSmsEventLog } from "./event-log.js";
import type { TelnyxWebhookPayload } from "./types.js";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import crypto from "node:crypto";

// Shared Ed25519 keypair for these tests (Telnyx-style signing).
const { privateKey: TEST_PRIV, publicKey: TEST_PUB } = crypto.generateKeyPairSync("ed25519");
const TEST_PUBLIC_KEY_B64 = TEST_PUB.export({ format: "der", type: "spki" }).slice(-32).toString("base64");

function signedHeader(body: unknown): Record<string, string> {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  const t = String(Math.floor(Date.now() / 1000));
  const sig = crypto.sign(null, Buffer.from(`${t}|${raw}`, "utf8"), TEST_PRIV).toString("base64");
  return {
    "telnyx-signature-ed25519": sig,
    "telnyx-timestamp": t,
  };
}

// ─── Helpers ───────────────────────────────────────────────────

function createMockReq(
  method: string,
  headers: Record<string, string | string[] | undefined>,
  body: unknown,
): IncomingMessage {
  const emitter = new EventEmitter() as IncomingMessage;
  emitter.method = method;
  emitter.headers = headers;
  emitter.url = "/telnyx-sms/webhook";

  // Simulate request body delivery on next tick
  process.nextTick(() => {
    if (typeof body === "string") {
      emitter.emit("data", Buffer.from(body));
    } else if (body) {
      emitter.emit("data", Buffer.from(JSON.stringify(body)));
    }
    emitter.emit("end");
  });

  return emitter;
}

function createMockRes(): ServerResponse & { body: string } {
  const res = {
    statusCode: 200,
    body: "",
    end(chunk?: unknown) {
      res.body = typeof chunk === "string" ? chunk : "";
    },
  } as ServerResponse & { body: string };
  return res;
}

// ─── Inbound webhook handler ───────────────────────────────────────

describe("handleTelnyxSmsWebhook", () => {
  let resolveAgentRouteMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();

    resolveAgentRouteMock = vi.fn().mockReturnValue({
      agentId: "default",
      sessionKey: "telnyx-sms:direct:+15551234567",
    });

    const mockRuntime = {
      channel: {
        routing: { resolveAgentRoute: resolveAgentRouteMock },
        session: {
          resolveStorePath: vi.fn().mockReturnValue("/tmp/sessions"),
          readSessionUpdatedAt: vi.fn().mockReturnValue(undefined),
          recordInboundSession: vi.fn(),
        },
        reply: {
          resolveEnvelopeFormatOptions: vi.fn().mockReturnValue({}),
          formatAgentEnvelope: vi.fn().mockReturnValue({}),
          finalizeInboundContext: vi.fn().mockReturnValue({}),
          dispatchReplyWithBufferedBlockDispatcher: vi.fn().mockResolvedValue(undefined),
        },
      },
    };

    setTelnyxSmsRuntime(mockRuntime);
    telnyxSmsEventLog.clear();
  });

  const validPayload: TelnyxWebhookPayload = {
    data: {
      event_type: "message.received",
      id: "evt-123",
      occurred_at: "2026-04-23T08:00:00Z",
      payload: {
        from: { phone_number: "+15551234567" },
        to: { phone_number: "+15559876543" },
        text: "Hello from SMS!",
        message_id: "msg-abc123",
        messaging_profile_id: "profile-1",
      },
    },
  };

  const baseCfg = {
    channels: {
      "telnyx-sms": {
        apiKey: "test-key",
        defaultFromNumber: "+15559876543",
        publicKey: TEST_PUBLIC_KEY_B64,
      },
    },
  };

  it("rejects non-POST requests", async () => {
    const req = createMockReq("GET", {}, "");
    const res = createMockRes();
    await handleTelnyxSmsWebhook(req, res, baseCfg as any);
    expect(res.statusCode).toBe(405);
  });

  it("rejects invalid JSON body", async () => {
    const req = createMockReq("POST", {}, "not-json");
    const res = createMockRes();
    await handleTelnyxSmsWebhook(req, res, baseCfg as any);
    expect(res.statusCode).toBe(400);
    expect(res.body).toBe("Invalid JSON");
  });

  it("acknowledges non-message.received events", async () => {
    const deliveryPayload = { ...validPayload, data: { ...validPayload.data, event_type: "message.delivered" } };
    const req = createMockReq("POST", signedHeader(deliveryPayload), deliveryPayload);
    const res = createMockRes();
    await handleTelnyxSmsWebhook(req, res, baseCfg as any);
    expect(res.statusCode).toBe(200);
  });

  it("rejects invalid webhook signature when publicKey is configured", async () => {
    const req = createMockReq(
      "POST",
      {
        "telnyx-signature-ed25519": Buffer.alloc(64).toString("base64"),
        "telnyx-timestamp": String(Math.floor(Date.now() / 1000)),
      },
      validPayload,
    );
    const res = createMockRes();
    await handleTelnyxSmsWebhook(req, res, baseCfg as any);
    expect(res.statusCode).toBe(401);
  });

  it("accepts valid payload with valid signature and records the event", async () => {
    const req = createMockReq("POST", signedHeader(validPayload), validPayload);
    const res = createMockRes();
    await handleTelnyxSmsWebhook(req, res, baseCfg as any);
    expect(resolveAgentRouteMock).toHaveBeenCalled();
    expect(telnyxSmsEventLog.recent()).toEqual([
      expect.objectContaining({
        direction: "inbound",
        status: "received",
        phoneNumber: "+15551234567",
        messageId: "msg-abc123",
      }),
    ]);
  });

  it("rejects signed payload with missing from/to phone numbers", async () => {
    const badPayload = { data: { event_type: "message.received", payload: { from: {}, to: {} } } };
    const req = createMockReq("POST", signedHeader(badPayload), badPayload);
    const res = createMockRes();
    await handleTelnyxSmsWebhook(req, res, baseCfg as any);
    expect(res.statusCode).toBe(400);
    expect(res.body).toBe("Invalid payload");
  });

  it("rejects signed payload with unsafe MMS media URL", async () => {
    const payload: TelnyxWebhookPayload = {
      data: {
        event_type: "message.received",
        payload: {
          from: { phone_number: "+15551234567" },
          to: { phone_number: "+15559876543" },
          text: "image",
          media: [{ url: "https://169.254.169.254/latest/meta-data", content_type: "image/jpeg" }],
          message_id: "msg-media",
          messaging_profile_id: "profile-1",
        },
      },
    };
    const req = createMockReq("POST", signedHeader(payload), payload);
    const res = createMockRes();
    await handleTelnyxSmsWebhook(req, res, baseCfg as any);
    expect(res.statusCode).toBe(400);
    expect(res.body).toBe("Invalid media URL");
    expect(telnyxSmsEventLog.recent()[0]).toEqual(
      expect.objectContaining({ status: "blocked", reason: expect.stringContaining("blocked MMS media URL") }),
    );
  });

  it("records delivery status webhook events", async () => {
    const payload: TelnyxWebhookPayload = {
      data: {
        event_type: "message.finalized",
        id: "evt-finalized",
        payload: {
          from: { phone_number: "+15559876543" },
          to: [{ phone_number: "+15551234567", status: "delivered" }] as any,
          text: "reply",
          message_id: "msg-outbound",
          messaging_profile_id: "profile-1",
          errors: [],
        },
      },
    };
    const req = createMockReq("POST", signedHeader(payload), payload);
    const res = createMockRes();
    await handleTelnyxSmsWebhook(req, res, baseCfg as any);
    expect(res.statusCode).toBe(200);
    expect(telnyxSmsEventLog.recent()[0]).toEqual(
      expect.objectContaining({ direction: "outbound", status: "sent", messageId: "msg-outbound" }),
    );
  });

  it("rejects oversized MMS media", async () => {
    const payload: TelnyxWebhookPayload = {
      data: {
        event_type: "message.received",
        payload: {
          from: { phone_number: "+15551234567" },
          to: { phone_number: "+15559876543" },
          text: "big image",
          media: [{ url: "https://media.telnyx.com/big.jpg", content_type: "image/jpeg", size: 1024 * 1024 + 1 }],
          message_id: "msg-big-media",
          messaging_profile_id: "profile-1",
        },
      },
    };
    const req = createMockReq("POST", signedHeader(payload), payload);
    const res = createMockRes();
    await handleTelnyxSmsWebhook(req, res, baseCfg as any);
    expect(res.statusCode).toBe(400);
    expect(res.body).toBe("Invalid media size");
  });

  it("rejects webhook when publicKey is not configured", async () => {
    const cfgNoKey = {
      channels: {
        "telnyx-sms": { apiKey: "test-key", defaultFromNumber: "+15559876543" },
      },
    };
    const req = createMockReq("POST", {}, validPayload);
    const res = createMockRes();
    await handleTelnyxSmsWebhook(req, res, cfgNoKey as any);
    expect(res.statusCode).toBe(503);
  });
});
