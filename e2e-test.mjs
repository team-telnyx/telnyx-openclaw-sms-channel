// Wire-by-wire E2E test for telnyx-sms channel plugin.
// Exercises every edge in the flow diagrams: setup → discovery → exposure →
// webhook config → inbound verify/dispatch → outbound allowlist.
//
// Tests against the REAL Telnyx account — state-mutating tests (webhook URL
// PATCH, profile/number attach) capture baseline first and restore at the end.
// No SMS is actually sent (outbound stops at the allowlist guard layer).

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { EventEmitter } from "node:events";
import crypto from "node:crypto";

const cfg = JSON.parse(readFileSync(`${homedir()}/.openclaw/openclaw.json`, "utf8"));
const section = cfg.channels["telnyx-sms"];
const apiKey = section.apiKey;
const profileId = section.messagingProfileId;
const fromNumber = section.defaultFromNumber;
const allowFrom = section.allowFrom ?? [];

if (!apiKey || !profileId) {
  console.error("FAIL: config missing apiKey or messagingProfileId");
  process.exit(2);
}

const headers = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
const profileUrl = `https://api.telnyx.com/v2/messaging_profiles/${profileId}`;

// Capture baseline so we can restore
const baselineResp = await fetch(profileUrl, { headers });
const baseline = (await baselineResp.json()).data;
const originalWebhook = baseline.webhook_url ?? "";
const originalDestinations = baseline.whitelisted_destinations ?? [];
console.log("baseline webhook_url:", originalWebhook || "(empty)");

let pass = 0, fail = 0;
const fails = [];
function ok(name) { console.log(`  ✓ ${name}`); pass++; }
function bad(name, detail) { console.error(`  ✗ ${name}: ${detail}`); fail++; fails.push(`${name}: ${detail}`); }
function section_(n, t) { console.log(`\n── ${n} ──────────────────────────────────\n${t}`); }

// Plugin sources (TS, resolved via tsx)
const { discoverDefaults, isDiscoveryError, fetchPublicKey, findOrphanNumber } = await import("./src/discover.ts");
const { configureTelnyxWebhook, handleTelnyxSmsWebhook, setTelnyxSmsRuntime } = await import("./src/inbound.ts");
const { assertOutboundAllowed, resolveAccount, setDiscoveredDefaults } = await import("./src/channel.ts");
const { verifyWebhookSignature, parseInboundPayload } = await import("./src/webhook.ts");

// ═══════════════════════════════════════════════════════════════════════
section_("WIRE 1", "fetchPublicKey — live Telnyx API");
// ═══════════════════════════════════════════════════════════════════════
const realPk = await fetchPublicKey(apiKey);
if (realPk && /^[A-Za-z0-9+/=]+$/.test(realPk) && Buffer.from(realPk, "base64").length === 32) {
  ok(`GET /v2/public_key → 32-byte base64 key: ${realPk.slice(0, 16)}…`);
} else {
  bad("fetchPublicKey valid key", `got ${realPk}`);
}

const pkBogus = await fetchPublicKey("KEY_bogus_asdf");
if (pkBogus === null) ok("bogus key → null"); else bad("bogus key should return null", pkBogus);

// ═══════════════════════════════════════════════════════════════════════
section_("WIRE 2", "discoverDefaults — all branches");
// ═══════════════════════════════════════════════════════════════════════
const d1 = await discoverDefaults(apiKey, fromNumber);
if (!isDiscoveryError(d1) && d1.fromNumber === fromNumber && d1.messagingProfileId === profileId) {
  ok(`with hint → honored: ${fromNumber} / ${profileId}`);
} else {
  bad("with hint", JSON.stringify(d1));
}

const d2 = await discoverDefaults(apiKey);
if (isDiscoveryError(d2) && d2.code === "no_profile") {
  ok(`without hint → orphan picked, no_profile: ${d2.message}`);
} else if (!isDiscoveryError(d2)) {
  ok(`without hint → profiled fallback: ${d2.fromNumber}`);
} else {
  bad("without hint unexpected", JSON.stringify(d2));
}

const d3 = await discoverDefaults("KEY_bogus_asdf");
if (isDiscoveryError(d3) && d3.code === "auth_failed") ok("bogus key → auth_failed");
else bad("bogus key should auth_failed", JSON.stringify(d3));

const d4 = await discoverDefaults(apiKey, "+19999999999");
if (isDiscoveryError(d4) && d4.code === "no_numbers") ok(`unknown hint → no_numbers`);
else bad("unknown hint should error", JSON.stringify(d4));

// ═══════════════════════════════════════════════════════════════════════
section_("WIRE 3", "findOrphanNumber — live account lookup");
// ═══════════════════════════════════════════════════════════════════════
const orphan = await findOrphanNumber(apiKey);
if (orphan && orphan.id && orphan.phone_number) {
  ok(`found candidate: ${orphan.phone_number} (id=${orphan.id.slice(0, 8)}…)`);
} else {
  bad("findOrphanNumber", "no candidate returned");
}

// ═══════════════════════════════════════════════════════════════════════
section_("WIRE 4", "verifyWebhookSignature — Ed25519 all variants");
// ═══════════════════════════════════════════════════════════════════════
function makeSigner() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const b64 = publicKey.export({ format: "der", type: "spki" }).slice(-32).toString("base64");
  return {
    pk: b64,
    sign: (body, ts) =>
      crypto.sign(null, Buffer.from(`${ts}|${body}`, "utf8"), privateKey).toString("base64"),
  };
}
const s1 = makeSigner();
const body = '{"data":{"event_type":"message.received","payload":{}}}';
const nowTs = String(Math.floor(Date.now() / 1000));

if (verifyWebhookSignature(body, s1.sign(body, nowTs), nowTs, s1.pk)) ok("valid sig → true");
else bad("valid sig", "got false");

if (!verifyWebhookSignature(body, s1.sign(body, nowTs), nowTs, makeSigner().pk)) ok("wrong key → false");
else bad("wrong key", "got true");

if (!verifyWebhookSignature("tampered", s1.sign(body, nowTs), nowTs, s1.pk)) ok("tampered body → false");
else bad("tampered body", "got true");

if (!verifyWebhookSignature(body, s1.sign(body, nowTs), String(+nowTs - 3600), s1.pk)) ok("stale ts → false");
else bad("stale ts", "got true");

if (!verifyWebhookSignature(body, s1.sign(body, nowTs), String(+nowTs + 3600), s1.pk)) ok("future ts → false");
else bad("future ts", "got true");

if (!verifyWebhookSignature(body, undefined, nowTs, s1.pk)) ok("no sig header → false");
else bad("no sig header", "got true");

if (!verifyWebhookSignature(body, s1.sign(body, nowTs), undefined, s1.pk)) ok("no ts header → false");
else bad("no ts header", "got true");

if (!verifyWebhookSignature(body, s1.sign(body, nowTs), nowTs, "")) ok("empty pk → false");
else bad("empty pk", "got true");

if (!verifyWebhookSignature(body, s1.sign(body, nowTs), nowTs, "not-a-real-key")) ok("malformed pk → false");
else bad("malformed pk", "got true");

// ═══════════════════════════════════════════════════════════════════════
section_("WIRE 5", "parseInboundPayload — edge cases");
// ═══════════════════════════════════════════════════════════════════════
const valid = { data: { event_type: "message.received", payload: { from: { phone_number: "+1" }, to: { phone_number: "+2" }, text: "hi" } } };
const p1 = parseInboundPayload(valid);
if (p1?.from === "+1" && p1?.to === "+2" && p1?.text === "hi") ok("valid payload parsed");
else bad("valid payload", JSON.stringify(p1));

const toArr = { data: { payload: { from: { phone_number: "+1" }, to: [{ phone_number: "+2" }], text: "x" } } };
if (parseInboundPayload(toArr)?.to === "+2") ok("to as array handled");
else bad("to as array", "not normalized");

if (parseInboundPayload({ data: { payload: { from: {}, to: {} } } }) === null) ok("missing phone_number → null");
else bad("missing phone", "parsed");

if (parseInboundPayload({}) === null) ok("empty → null"); else bad("empty", "parsed");

// ═══════════════════════════════════════════════════════════════════════
section_("WIRE 6", "resolveAccount + discovered-defaults cache");
// ═══════════════════════════════════════════════════════════════════════
const testCfg = { channels: { "telnyx-sms": { apiKey: "k" } } };
setDiscoveredDefaults("default", { fromNumber: "+111", messagingProfileId: "prof-1", publicKey: "pk-1" });
const acct = resolveAccount(testCfg, null);
if (acct.apiKey === "k" && acct.defaultFromNumber === "+111" && acct.messagingProfileId === "prof-1" && acct.publicKey === "pk-1") {
  ok("cache merge: apiKey + discovered from/profile/pk");
} else bad("cache merge", JSON.stringify(acct));

// Explicit config beats cache
const testCfg2 = { channels: { "telnyx-sms": { apiKey: "k", defaultFromNumber: "+999" } } };
const acct2 = resolveAccount(testCfg2, null);
if (acct2.defaultFromNumber === "+999") ok("explicit config beats cache"); else bad("explicit", acct2.defaultFromNumber);

// Missing apiKey throws
let threw = false;
try { resolveAccount({ channels: { "telnyx-sms": {} } }, null); } catch { threw = true; }
if (threw) ok("missing apiKey throws"); else bad("missing apiKey", "did not throw");

// ═══════════════════════════════════════════════════════════════════════
section_("WIRE 7", "assertOutboundAllowed — all policy branches");
// ═══════════════════════════════════════════════════════════════════════
const baseAcct = { accountId: null, apiKey, allowFrom, dmPolicy: "allowlist", defaultFromNumber: fromNumber, messagingProfileId: profileId };

let allOK = true;
for (const entry of allowFrom) {
  try { assertOutboundAllowed(baseAcct, entry); } catch (e) { allOK = false; bad(`allowFrom ${entry}`, e.message); }
}
if (allOK) ok(`${allowFrom.length} allowFrom entries permitted`);

try { assertOutboundAllowed(baseAcct, "+15555550123"); bad("non-allowlisted", "did not throw"); }
catch (e) { if (e.message.includes("outbound blocked")) ok("non-allowlisted blocked"); else bad("wrong error", e.message); }

try { assertOutboundAllowed({ ...baseAcct, dmPolicy: "open" }, "+15555550123"); ok("dmPolicy=open bypasses"); }
catch (e) { bad("open bypass", e.message); }

try { assertOutboundAllowed({ ...baseAcct, allowFrom: ["*"] }, "+15555550123"); ok('allowFrom=["*"] bypasses'); }
catch (e) { bad("wildcard bypass", e.message); }

try { assertOutboundAllowed({ ...baseAcct, allowFrom: [] }, "+15555550123"); ok("empty allowFrom → unrestricted"); }
catch (e) { bad("empty allowFrom", e.message); }

// Normalization: +1 (773) 302-2477 vs +17733022477
try { assertOutboundAllowed(baseAcct, "+1 (773) 302-2477"); ok("formatted number normalized"); }
catch (e) { bad("normalization", e.message); }

// ═══════════════════════════════════════════════════════════════════════
section_("WIRE 8", "configureTelnyxWebhook — live API with baseline restore");
// ═══════════════════════════════════════════════════════════════════════

// 8a: matching URL → idempotent configured
const outcomeMatch = await configureTelnyxWebhook(apiKey, profileId, originalWebhook, allowFrom);
if (outcomeMatch.status === "configured") ok("matching URL → configured (idempotent)");
else bad("matching URL", JSON.stringify(outcomeMatch));

// 8b: set foreign URL, expect skipped
await fetch(profileUrl, { method: "PATCH", headers, body: JSON.stringify({ webhook_url: "https://example.invalid/foreign", whitelisted_destinations: originalDestinations }) });
const outcomeForeign = await configureTelnyxWebhook(apiKey, profileId, "https://ours.test/webhook", allowFrom);
if (outcomeForeign.status === "skipped_foreign_webhook" && outcomeForeign.existingUrl === "https://example.invalid/foreign") {
  ok("foreign URL → skipped_foreign_webhook");
} else bad("foreign URL", JSON.stringify(outcomeForeign));

// 8c: overwrite=true → configured
const outcomeOverwrite = await configureTelnyxWebhook(apiKey, profileId, "https://ours.test/webhook", allowFrom, { overwrite: true });
if (outcomeOverwrite.status === "configured") ok("overwrite=true → configured");
else bad("overwrite", JSON.stringify(outcomeOverwrite));

// 8d: restore baseline
const restore = await configureTelnyxWebhook(apiKey, profileId, originalWebhook || "https://placeholder.test/webhook", allowFrom, { overwrite: true });
if (restore.status === "configured") ok(`restored baseline → ${originalWebhook || "(placeholder)"}`);
else bad("restore", JSON.stringify(restore));

// ═══════════════════════════════════════════════════════════════════════
section_("WIRE 9", "handleTelnyxSmsWebhook — HTTP handler end-to-end");
// ═══════════════════════════════════════════════════════════════════════
// Build a mock runtime that records deliveries but doesn't actually send
const dispatched = [];
setTelnyxSmsRuntime({
  channel: {
    routing: {
      resolveAgentRoute: () => ({ agentId: "default", sessionKey: "telnyx-sms:direct:+1" }),
    },
    session: {
      resolveStorePath: () => "/tmp/sessions",
      readSessionUpdatedAt: () => undefined,
      recordInboundSession: (x) => dispatched.push({ kind: "record", x }),
    },
    reply: {
      resolveEnvelopeFormatOptions: () => ({}),
      formatAgentEnvelope: () => ({}),
      finalizeInboundContext: () => ({}),
      dispatchReplyWithBufferedBlockDispatcher: async () => {},
    },
  },
});

// Ed25519 keypair for integration — cache as publicKey for resolveAccount
const wireKP = makeSigner();
setDiscoveredDefaults("default", { publicKey: wireKP.pk });

function mockReq(method, hdrs, body) {
  const em = new EventEmitter();
  em.method = method;
  em.headers = hdrs;
  em.url = "/telnyx-sms/webhook";
  process.nextTick(() => {
    if (body != null) em.emit("data", Buffer.from(typeof body === "string" ? body : JSON.stringify(body)));
    em.emit("end");
  });
  return em;
}
function mockRes() {
  return { statusCode: 200, body: "", end(c) { this.body = typeof c === "string" ? c : ""; } };
}

const webhookCfg = { channels: { "telnyx-sms": { apiKey: "k", defaultFromNumber: fromNumber } } };

// 9a: GET rejected
{
  const res = mockRes();
  await handleTelnyxSmsWebhook(mockReq("GET", {}, ""), res, webhookCfg);
  if (res.statusCode === 405) ok("GET → 405"); else bad("GET", res.statusCode);
}

// 9b: invalid JSON → 400
{
  const res = mockRes();
  await handleTelnyxSmsWebhook(mockReq("POST", {}, "not-json"), res, webhookCfg);
  if (res.statusCode === 400 && res.body === "Invalid JSON") ok("bad JSON → 400");
  else bad("bad JSON", `${res.statusCode} ${res.body}`);
}

// 9c: non-message.received → 200 ignored
{
  const payload = { data: { event_type: "message.delivered", payload: { from: { phone_number: "+1" }, to: { phone_number: "+2" } } } };
  const res = mockRes();
  await handleTelnyxSmsWebhook(mockReq("POST", {}, payload), res, webhookCfg);
  if (res.statusCode === 200) ok("non-message.received → 200 ignored"); else bad("non-msg event", res.statusCode);
}

// 9d: valid payload + VALID signature → dispatched
{
  const payload = { data: { event_type: "message.received", payload: { from: { phone_number: "+17733022477" }, to: { phone_number: fromNumber }, text: "hi", messaging_profile_id: profileId } } };
  const raw = JSON.stringify(payload);
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = wireKP.sign(raw, ts);
  const res = mockRes();
  await handleTelnyxSmsWebhook(
    mockReq("POST", { "telnyx-signature-ed25519": sig, "telnyx-timestamp": ts }, raw),
    res,
    webhookCfg,
  );
  if (res.statusCode === 200 && dispatched.length > 0) ok(`valid sig → 200 OK, dispatched (${dispatched.length} runtime events)`);
  else bad("valid sig", `status=${res.statusCode}, dispatches=${dispatched.length}`);
}

// 9e: invalid signature → 401
{
  const payload = { data: { event_type: "message.received", payload: { from: { phone_number: "+1" }, to: { phone_number: "+2" }, text: "x" } } };
  const ts = String(Math.floor(Date.now() / 1000));
  const badSig = Buffer.alloc(64).toString("base64");
  const res = mockRes();
  await handleTelnyxSmsWebhook(
    mockReq("POST", { "telnyx-signature-ed25519": badSig, "telnyx-timestamp": ts }, payload),
    res,
    webhookCfg,
  );
  if (res.statusCode === 401) ok("bad sig → 401"); else bad("bad sig", res.statusCode);
}

// 9f: missing sig headers → 401
{
  const payload = { data: { event_type: "message.received", payload: { from: { phone_number: "+1" }, to: { phone_number: "+2" } } } };
  const res = mockRes();
  await handleTelnyxSmsWebhook(mockReq("POST", {}, payload), res, webhookCfg);
  if (res.statusCode === 401) ok("no sig headers → 401"); else bad("no headers", res.statusCode);
}

// 9g: stale timestamp → 401
{
  const payload = { data: { event_type: "message.received", payload: { from: { phone_number: "+1" }, to: { phone_number: "+2" }, text: "x" } } };
  const raw = JSON.stringify(payload);
  const staleTs = String(Math.floor(Date.now() / 1000) - 3600);
  const sig = wireKP.sign(raw, staleTs);
  const res = mockRes();
  await handleTelnyxSmsWebhook(
    mockReq("POST", { "telnyx-signature-ed25519": sig, "telnyx-timestamp": staleTs }, raw),
    res,
    webhookCfg,
  );
  if (res.statusCode === 401) ok("stale ts → 401"); else bad("stale ts", res.statusCode);
}

// 9h: publicKey missing → 503
{
  const cfgNoPk = { channels: { "telnyx-sms": { apiKey: "k" } } };
  // Clear the discovered-defaults cache for this check
  setDiscoveredDefaults("default", { publicKey: undefined });
  const payload = { data: { event_type: "message.received", payload: { from: { phone_number: "+1" }, to: { phone_number: "+2" } } } };
  const res = mockRes();
  await handleTelnyxSmsWebhook(mockReq("POST", {}, payload), res, cfgNoPk);
  if (res.statusCode === 503) ok("no publicKey → 503"); else bad("no pk", res.statusCode);
  // Restore for any later tests
  setDiscoveredDefaults("default", { publicKey: wireKP.pk });
}

// 9i: valid sig but missing from/to → 400
{
  const payload = { data: { event_type: "message.received", payload: { from: {}, to: {} } } };
  const raw = JSON.stringify(payload);
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = wireKP.sign(raw, ts);
  const res = mockRes();
  await handleTelnyxSmsWebhook(
    mockReq("POST", { "telnyx-signature-ed25519": sig, "telnyx-timestamp": ts }, raw),
    res,
    webhookCfg,
  );
  if (res.statusCode === 400 && res.body === "Invalid payload") ok("valid sig + bad payload → 400");
  else bad("bad payload", `${res.statusCode} ${res.body}`);
}

// ═══════════════════════════════════════════════════════════════════════
section_("WIRE 10", "public tunnel reachability (live HTTP)");
// ═══════════════════════════════════════════════════════════════════════
const publicUrl = section.exposure?.publicUrl;
if (publicUrl) {
  // GET should be rejected by the handler (405), but the TUNNEL reaching the
  // gateway is what we're testing. Any 4xx response proves the wire works.
  try {
    const r = await fetch(`${publicUrl}/telnyx-sms/webhook`, { method: "GET" });
    if (r.status === 405) ok(`tunnel GET → 405 (path live, handler reached)`);
    else if (r.status >= 400 && r.status < 500) ok(`tunnel GET → ${r.status} (tunnel live)`);
    else bad("tunnel GET", `unexpected ${r.status}`);
  } catch (e) {
    bad("tunnel GET", e.message);
  }

  // POST with bad sig should get 401 — proves the whole pipeline up to
  // signature verification is wired (tunnel → HTTP srv → route → handler).
  try {
    const r = await fetch(`${publicUrl}/telnyx-sms/webhook`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "telnyx-signature-ed25519": Buffer.alloc(64).toString("base64"),
        "telnyx-timestamp": String(Math.floor(Date.now() / 1000)),
      },
      body: JSON.stringify({ data: { event_type: "message.received", payload: { from: { phone_number: "+1" }, to: { phone_number: "+2" } } } }),
    });
    if (r.status === 401) ok("tunnel POST bad-sig → 401 (full pipeline reached signature layer)");
    else bad("tunnel POST bad-sig", `status=${r.status}`);
  } catch (e) {
    bad("tunnel POST", e.message);
  }
} else {
  bad("tunnel reachability", "no publicUrl configured, skipping");
}

// ═══════════════════════════════════════════════════════════════════════
console.log(`\n══════════════════════════════════════════════════`);
console.log(`${pass} passed, ${fail} failed`);
if (fail) {
  console.log("\nFailures:");
  for (const f of fails) console.log(`  - ${f}`);
}
process.exit(fail === 0 ? 0 : 1);
