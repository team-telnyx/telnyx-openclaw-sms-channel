import type { TelnyxSendMessageParams, TelnyxMessageResponse } from "./types.js";

const TELNYX_API_BASE = "https://api.telnyx.com/v2";

/**
 * Telnyx Messaging API client.
 */
export class TelnyxClient {
  private apiKey: string;
  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  /**
   * Send an SMS or MMS via the Telnyx Messaging API.
   */
  async sendMessage(params: TelnyxSendMessageParams): Promise<TelnyxMessageResponse> {
    const url = `${TELNYX_API_BASE}/messages`;

    const body: Record<string, unknown> = {
      from: params.from,
      to: params.to,
    };

    if (params.text) body.text = params.text;
    if (params.media_urls && params.media_urls.length > 0) {
      body.media_urls = params.media_urls;
    }
    if (params.messaging_profile_id) {
      body.messaging_profile_id = params.messaging_profile_id;
    }
    if (params.subject) body.subject = params.subject;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "unknown error");
      throw new Error(
        `Telnyx API error ${response.status}: ${text}`
      );
    }

    return (await response.json()) as TelnyxMessageResponse;
  }
}
