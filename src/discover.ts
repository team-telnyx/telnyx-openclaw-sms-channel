/**
 * Auto-discover account defaults from just an API key.
 *
 * Telnyx's API can tell us everything we need if the customer has at least
 * one SMS-capable number on their account:
 *   - GET /v2/phone_numbers      → list numbers, pick one
 *   - GET /v2/phone_numbers/:id  → number's messaging_profile_id
 *
 * This lets setup be "paste API key, done" instead of asking for
 * Profile ID + From Number up front.
 */

export interface DiscoveredDefaults {
  /** E.164 number to send from. */
  fromNumber: string;
  /** Messaging profile that owns fromNumber. */
  messagingProfileId: string;
}

export interface DiscoveryError {
  code:
    | "no_numbers"
    | "auth_failed"
    | "api_error"
    | "no_profile";
  message: string;
  hint?: string;
}

interface TelnyxPhoneNumber {
  id: string;
  phone_number: string;
  messaging_profile_id?: string | null;
  features?: Array<{ name?: string } | string>;
}

/**
 * Fetch the account's numbers and pick a sensible SMS-capable default.
 * If `preferredNumber` is given, use it when present; otherwise use the first
 * number that has SMS features.
 */
export interface DiscoverOptions {
  /** If set, honor this number (even if it's already on a profile). */
  preferredNumber?: string;
}

export async function discoverDefaults(
  apiKey: string,
  preferredNumberOrOptions?: string | DiscoverOptions,
): Promise<DiscoveredDefaults | DiscoveryError> {
  const opts: DiscoverOptions =
    typeof preferredNumberOrOptions === "string"
      ? { preferredNumber: preferredNumberOrOptions }
      : (preferredNumberOrOptions ?? {});
  const { preferredNumber } = opts;
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };

  let listResp: Response;
  try {
    listResp = await fetch(
      "https://api.telnyx.com/v2/phone_numbers?page[size]=100",
      { headers },
    );
  } catch (err) {
    return {
      code: "api_error",
      message: `Failed to reach Telnyx API: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (listResp.status === 401 || listResp.status === 403) {
    return {
      code: "auth_failed",
      message: `Telnyx rejected the API key (${listResp.status}). Check that channels.telnyx-sms.apiKey is a valid v2 key.`,
      hint: "Create one at https://portal.telnyx.com/#/app/api-keys",
    };
  }

  if (!listResp.ok) {
    const body = await listResp.text().catch(() => "");
    return {
      code: "api_error",
      message: `Telnyx API returned ${listResp.status} ${listResp.statusText}: ${body.slice(0, 300)}`,
    };
  }

  const listJson = (await listResp.json()) as { data?: TelnyxPhoneNumber[] };
  const numbers = listJson.data ?? [];

  if (numbers.length === 0) {
    return {
      code: "no_numbers",
      message:
        "Your Telnyx account has no phone numbers. SMS requires at least one number.",
      hint: "Buy one at https://portal.telnyx.com/#/app/numbers/search-numbers or port one at https://portal.telnyx.com/#/app/numbers/port-numbers",
    };
  }

  const isSmsCapable = (n: TelnyxPhoneNumber): boolean => {
    if (!n.features || n.features.length === 0) return true; // assume yes if unknown
    return n.features.some((f) => {
      const name = typeof f === "string" ? f : f?.name;
      return name === "sms" || name === "mms";
    });
  };

  let picked: TelnyxPhoneNumber | undefined;
  if (preferredNumber) {
    const normalized = preferredNumber.replace(/\s/g, "");
    picked = numbers.find((n) => n.phone_number === normalized);
    if (!picked) {
      return {
        code: "no_numbers",
        message: `Configured defaultFromNumber ${preferredNumber} is not on this Telnyx account.`,
        hint: `Available numbers: ${numbers.map((n) => n.phone_number).join(", ")}`,
      };
    }
  } else {
    // Prefer orphan (unassigned) numbers so we can create our own profile
    // rather than piggyback on an existing integration. Fall back to a
    // profiled number if no orphan exists — the webhook-overwrite guard
    // in configureTelnyxWebhook will still protect any existing webhook URL.
    const orphan = numbers.find((n) => !n.messaging_profile_id && isSmsCapable(n))
                 ?? numbers.find((n) => !n.messaging_profile_id);
    picked = orphan ?? numbers.find(isSmsCapable) ?? numbers[0];
  }

  if (!picked.messaging_profile_id) {
    return {
      code: "no_profile",
      message: `Number ${picked.phone_number} is not attached to a messaging profile.`,
      hint: "Attach it in the Telnyx portal: Messaging → Profiles → select a profile → Numbers tab.",
    };
  }

  return {
    fromNumber: picked.phone_number,
    messagingProfileId: picked.messaging_profile_id,
  };
}

export function isDiscoveryError(
  v: DiscoveredDefaults | DiscoveryError,
): v is DiscoveryError {
  return "code" in v;
}

/**
 * Create a new Telnyx messaging profile with the given name and attach the
 * given phone number to it. Used when the account has numbers but none are
 * attached to a profile — we'd rather bootstrap than bail.
 *
 * Returns the new messaging profile ID on success, or null on failure (the
 * caller should already be logging).
 */
export async function createProfileAndAttach(
  apiKey: string,
  profileName: string,
  phoneNumberId: string,
): Promise<string | null> {
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };

  // 1. Create the profile
  let createResp: Response;
  try {
    createResp = await fetch("https://api.telnyx.com/v2/messaging_profiles", {
      method: "POST",
      headers,
      body: JSON.stringify({ name: profileName }),
    });
  } catch (err) {
    console.error(
      `[telnyx-sms] failed to create messaging profile: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }

  if (!createResp.ok) {
    const body = await createResp.text().catch(() => "");
    console.error(
      `[telnyx-sms] Telnyx rejected profile creation: ${createResp.status} ${createResp.statusText} body=${body.slice(0, 400)}`,
    );
    return null;
  }

  const created = (await createResp.json()) as { data?: { id?: string } };
  const newProfileId = created.data?.id;
  if (!newProfileId) {
    console.error("[telnyx-sms] profile creation returned no id");
    return null;
  }

  // 2. Attach the phone number to it
  try {
    const patchResp = await fetch(
      `https://api.telnyx.com/v2/phone_numbers/${phoneNumberId}`,
      {
        method: "PATCH",
        headers,
        body: JSON.stringify({ messaging_profile_id: newProfileId }),
      },
    );
    if (!patchResp.ok) {
      const body = await patchResp.text().catch(() => "");
      console.error(
        `[telnyx-sms] profile ${newProfileId} created, but attaching number ${phoneNumberId} failed: ` +
        `${patchResp.status} ${patchResp.statusText} body=${body.slice(0, 400)}`,
      );
      return null;
    }
  } catch (err) {
    console.error(
      `[telnyx-sms] attaching number to profile failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }

  return newProfileId;
}

/**
 * Fetch the organization-wide Ed25519 webhook public key from Telnyx.
 * Same key signs all products (SMS, Voice, Verify, Numbers...).
 *
 * Endpoint: GET /v2/public_key — response.data.public is base64-encoded.
 * Returns the base64 key, or null on failure (caller should log).
 */
export async function fetchPublicKey(apiKey: string): Promise<string | null> {
  try {
    const resp = await fetch("https://api.telnyx.com/v2/public_key", {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!resp.ok) return null;
    const json = (await resp.json()) as { data?: { public?: string } };
    return json.data?.public ?? null;
  } catch {
    return null;
  }
}

/**
 * Find the first orphan number (no messaging_profile_id) on the account.
 * Returns its {id, phone_number} or null if none exists.
 */
export async function findOrphanNumber(
  apiKey: string,
  preferredNumber?: string,
): Promise<{ id: string; phone_number: string } | null> {
  const headers = { Authorization: `Bearer ${apiKey}` };
  let resp: Response;
  try {
    resp = await fetch(
      "https://api.telnyx.com/v2/phone_numbers?page[size]=100",
      { headers },
    );
  } catch {
    return null;
  }
  if (!resp.ok) return null;
  const json = (await resp.json()) as { data?: TelnyxPhoneNumber[] };
  const numbers = json.data ?? [];

  if (preferredNumber) {
    const normalized = preferredNumber.replace(/\s/g, "");
    const match = numbers.find((n) => n.phone_number === normalized);
    if (match) return { id: match.id, phone_number: match.phone_number };
  }
  const orphan = numbers.find((n) => !n.messaging_profile_id);
  if (orphan) return { id: orphan.id, phone_number: orphan.phone_number };

  // No true orphan — fall back to the first number but warn that it already
  // has a messaging profile attached. The caller should prompt the user
  // before reassigning it.
  if (numbers[0]) {
    console.warn(
      `[telnyx-sms] no orphan (unassigned) numbers found on this account. ` +
      `Falling back to ${numbers[0].phone_number}, which already has a messaging profile. ` +
      `Proceeding will update the webhook URL on that profile. ` +
      `If that profile is used by another integration, consider creating a separate profile instead.`,
    );
    return { id: numbers[0].id, phone_number: numbers[0].phone_number };
  }
  return null;
}
