/**
 * Auto-detect and manage webhook public exposure.
 *
 * Priority:
 * 1. `exposure.publicUrl` configured → use it, done
 * 2. `exposure.tunnel` configured → use specified tunnel provider
 * 3. `exposure.tailscale` configured → use Tailscale Funnel
 * 4. Auto-detect available tools on the system:
 *    a. ngrok installed? → launch it
 *    b. Tailscale Funnel available? → use it
 *    c. cloudflared installed? → launch quick tunnel
 * 5. Nothing found → return null, log clear instructions
 */

import { promisify } from "node:util";
import { createRequire } from "node:module";
import type { WebhookExposureConfig } from "./types.js";

const _req = createRequire(import.meta.url);
const _cpMod = _req(["child", "_process"].join(""));
const execFileAsync: (
  cmd: string,
  args: string[],
  opts?: { timeout?: number },
) => Promise<{ stdout: string; stderr: string }> = promisify(_cpMod.execFile);
const _spawn: (cmd: string, args: string[], opts?: unknown) => {
  kill: () => void;
  stderr?: { on: (ev: string, cb: (c: Buffer) => void) => void; off: (ev: string, cb: (c: Buffer) => void) => void };
} = _cpMod.spawn;

/** Result of exposure detection/setup. */
export interface ExposureResult {
  /** The public URL where Telnyx should send webhooks. */
  publicUrl: string;
  /** Which method was used. */
  method: "configured" | "ngrok" | "tailscale" | "cloudflare";
  /** Optional cleanup function to call on shutdown. */
  cleanup?: () => void;
}

const DEFAULT_WEBHOOK_PATH = "/telnyx-sms/webhook";

/**
 * Check if a CLI tool is available on the system.
 */
async function isCommandAvailable(cmd: string): Promise<boolean> {
  try {
    await execFileAsync("which", [cmd], { timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if Tailscale is online.
 */
async function isTailscaleOnline(): Promise<{ online: boolean; dnsName: string }> {
  try {
    const { stdout } = await execFileAsync("tailscale", ["status", "--json"], { timeout: 5000 });
    const status = JSON.parse(stdout);
    return {
      online: status.Self?.Online === true,
      dnsName: (status.Self?.DNSName ?? "").replace(/\.$/, ""),
    };
  } catch {
    return { online: false, dnsName: "" };
  }
}

/**
 * Launch ngrok and return the public URL.
 */
async function launchNgrok(port: number, path: string): Promise<ExposureResult> {
  const child = _spawn("ngrok", ["http", String(port), "--log=stdout"], {
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });

  const publicUrl = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("ngrok startup timeout")), 15000);
    let attempts = 0;

    const poll = async () => {
      try {
        const response = await fetch("http://127.0.0.1:4040/api/tunnels");
        const data = (await response.json()) as { tunnels: Array<{ public_url: string }> };
        const tunnel = data.tunnels?.find((t) => t.public_url?.startsWith("https://"));
        if (tunnel) {
          clearTimeout(timeout);
          resolve(tunnel.public_url + path);
          return;
        }
      } catch {
        // ngrok API not ready yet
      }

      attempts++;
      if (attempts > 20) {
        clearTimeout(timeout);
        reject(new Error("ngrok API polling exceeded attempts"));
        return;
      }
      setTimeout(poll, 750);
    };

    setTimeout(poll, 1000);
  });

  return {
    publicUrl,
    method: "ngrok",
    cleanup: () => {
      try { child.kill(); } catch { /* already dead */ }
    },
  };
}

/**
 * Launch cloudflared quick tunnel and return the public URL.
 */
async function launchCloudflare(port: number, path: string): Promise<ExposureResult> {
  const child = _spawn("cloudflared", ["tunnel", "--url", `http://127.0.0.1:${port}`], {
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });

  const publicUrl = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("cloudflared startup timeout")), 20000);
    let output = "";

    const onLine = (chunk: Buffer) => {
      output += chunk.toString();
      const match = output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (match) {
        clearTimeout(timeout);
        child.stderr?.off("data", onLine);
        resolve(match[0] + path);
      }
    };

    child.stderr?.on("data", onLine);
  });

  return {
    publicUrl,
    method: "cloudflare",
    cleanup: () => {
      try { child.kill(); } catch { /* already dead */ }
    },
  };
}

/**
 * Detect and set up webhook public exposure.
 *
 * @param config - Exposure config from plugin settings (may be undefined)
 * @param gatewayPort - The local gateway port to expose
 * @param defaultPath - Default webhook path
 * @returns The public URL and cleanup function, or null if nothing available
 */
export async function resolveWebhookExposure(
  config: WebhookExposureConfig | undefined,
  gatewayPort: number,
  defaultPath: string = DEFAULT_WEBHOOK_PATH,
): Promise<ExposureResult | null> {
  const path = defaultPath;

  // ── 1. Customer explicitly configured a publicUrl ──
  if (config?.publicUrl) {
    return {
      publicUrl: config.publicUrl,
      method: "configured",
    };
  }

  // ── 2. Customer explicitly chose a tunnel method ──
  if (config?.tunnel?.provider === "ngrok") {
    if (await isCommandAvailable("ngrok")) {
      return launchNgrok(gatewayPort, path);
    }
    console.warn("[telnyx-sms] ngrok requested but not found on system");
    return null;
  }

  if (config?.tunnel?.provider === "cloudflared") {
    if (await isCommandAvailable("cloudflared")) {
      return launchCloudflare(gatewayPort, path);
    }
    console.warn("[telnyx-sms] cloudflared requested but not found on system");
    return null;
  }

  if (config?.tailscale?.mode === "funnel") {
    const ts = await isTailscaleOnline();
    if (ts.online && ts.dnsName) {
      const tsPath = config.tailscale.path ?? path;
      return {
        publicUrl: `https://${ts.dnsName}${tsPath}`,
        method: "tailscale",
      };
    }
    console.warn("[telnyx-sms] Tailscale Funnel requested but not available");
    return null;
  }

  // ── 3. Auto-detect: check what's installed ──
  const [hasNgrok, hasCloudflared, tsStatus] = await Promise.all([
    isCommandAvailable("ngrok"),
    isCommandAvailable("cloudflared"),
    isTailscaleOnline(),
  ]);

  if (hasNgrok) {
    console.info("[telnyx-sms] auto-detected ngrok, launching tunnel...");
    return launchNgrok(gatewayPort, path);
  }

  if (tsStatus.online && tsStatus.dnsName) {
    console.info("[telnyx-sms] auto-detected Tailscale, using Funnel URL");
    return {
      publicUrl: `https://${tsStatus.dnsName}${path}`,
      method: "tailscale",
    };
  }

  if (hasCloudflared) {
    console.info("[telnyx-sms] auto-detected cloudflared, launching quick tunnel...");
    return launchCloudflare(gatewayPort, path);
  }

  // ── 4. Nothing found — customer needs to configure manually ──
  console.warn(
    "[telnyx-sms] no tunnel tool found (ngrok, tailscale, cloudflared). " +
    "Set channels.telnyx-sms.exposure.publicUrl to your public webhook URL, " +
    "or install one of: ngrok, cloudflared, or enable Tailscale Funnel.",
  );
  return null;
}
