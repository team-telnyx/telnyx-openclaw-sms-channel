import net from "node:net";

export interface MediaUrlPolicyResult {
  ok: boolean;
  reason?: string;
}

const ALLOWED_HOST_SUFFIXES = [
  ".telnyx.com",
  ".telnyxcdn.com",
  ".telnyx.net",
];

/**
 * Defense-in-depth guard for inbound MMS media URLs.
 *
 * Telnyx webhooks are signature verified, but media URLs are still treated as
 * untrusted input. If the plugin or a future OpenClaw media pipeline fetches
 * these URLs, they must not be allowed to target localhost, private IP ranges,
 * metadata services, or arbitrary third-party hosts.
 */
export function validateMediaUrl(url: string): MediaUrlPolicyResult {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: "invalid URL" };
  }

  if (parsed.protocol !== "https:") {
    return { ok: false, reason: "media URL must use https" };
  }

  if (parsed.username || parsed.password) {
    return { ok: false, reason: "media URL must not contain credentials" };
  }

  const host = parsed.hostname.toLowerCase();
  if (!host) return { ok: false, reason: "missing host" };

  if (host === "localhost" || host.endsWith(".localhost")) {
    return { ok: false, reason: "localhost is not allowed" };
  }

  const ipVersion = net.isIP(host);
  if (ipVersion !== 0) {
    return isPublicIp(host)
      ? { ok: false, reason: "IP-literal media URLs are not allowed" }
      : { ok: false, reason: "private or reserved IP address is not allowed" };
  }

  const allowed = ALLOWED_HOST_SUFFIXES.some((suffix) => host === suffix.slice(1) || host.endsWith(suffix));
  if (!allowed) {
    return { ok: false, reason: `host is not an allowed Telnyx media host: ${host}` };
  }

  return { ok: true };
}

function isPublicIp(host: string): boolean {
  if (host.includes(":")) {
    return isPublicIpv6(host);
  }
  return isPublicIpv4(host);
}

function isPublicIpv4(host: string): boolean {
  const parts = host.split(".").map((p) => Number.parseInt(p, 10));
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return false;
  const [a, b] = parts;
  if (a === 10) return false;
  if (a === 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 0) return false;
  if (a >= 224) return false;
  return true;
}

function isPublicIpv6(host: string): boolean {
  const normalized = host.toLowerCase();
  if (normalized === "::1") return false;
  if (normalized === "::") return false;
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return false;
  if (normalized.startsWith("fe80")) return false;
  return true;
}
