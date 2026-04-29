export type TelnyxSmsEventDirection = "inbound" | "outbound";
export type TelnyxSmsEventStatus = "received" | "sent" | "blocked" | "error" | "ignored";

export interface TelnyxSmsEvent {
  timestamp: string;
  direction: TelnyxSmsEventDirection;
  status: TelnyxSmsEventStatus;
  phoneNumber?: string;
  accountId?: string | null;
  messageId?: string;
  preview?: string;
  reason?: string;
}

const DEFAULT_LIMIT = 50;

export class TelnyxSmsEventLog {
  private readonly limit: number;
  private events: TelnyxSmsEvent[] = [];

  constructor(limit = DEFAULT_LIMIT) {
    this.limit = Math.max(1, limit);
  }

  record(event: Omit<TelnyxSmsEvent, "timestamp"> & { timestamp?: string }): TelnyxSmsEvent {
    const entry: TelnyxSmsEvent = {
      timestamp: event.timestamp ?? new Date().toISOString(),
      direction: event.direction,
      status: event.status,
      phoneNumber: event.phoneNumber,
      accountId: event.accountId,
      messageId: event.messageId,
      preview: event.preview,
      reason: event.reason,
    };
    this.events.push(entry);
    if (this.events.length > this.limit) {
      this.events = this.events.slice(-this.limit);
    }
    return entry;
  }

  recent(limit = this.limit): TelnyxSmsEvent[] {
    return this.events.slice(-Math.max(1, limit));
  }

  clear(): void {
    this.events = [];
  }
}

export const telnyxSmsEventLog = new TelnyxSmsEventLog();

export function previewText(value: string | undefined, max = 120): string | undefined {
  if (!value) return undefined;
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > max ? `${compact.slice(0, max - 1)}…` : compact;
}
