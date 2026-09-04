import type { DavemaEndpoint } from "./endpoints.js";

/**
 * Step 7.2: Dave calls DAVEMA directly over HTTPS, no sandbox routing
 * needed -- this client makes plain fetch() calls, nothing else.
 */

export const DAVEMA_BASE_URL = "https://srzaqmvrnfeduivqvbgv.supabase.co/functions/v1/v1";

export interface DavemaEnvelope<T = unknown> {
  symbol: string;
  timeframe: string;
  timestamp: string;
  endpoint: string;
  data: T;
}

export class DavemaError extends Error {
  constructor(
    public readonly status: number,
    public readonly endpoint: string,
    message: string
  ) {
    super(`DAVEMA ${endpoint} -> HTTP ${status}: ${message}`);
    this.name = "DavemaError";
  }
}

export interface HistoryParams {
  from: string; // ISO-8601
  to: string; // ISO-8601
}

export class DavemaClient {
  constructor(
    private readonly apiKey: string | undefined,
    private readonly baseUrl: string = DAVEMA_BASE_URL
  ) {}

  /** /ping needs no key, per the skill doc -- useful as a pre-flight health check. */
  async ping(): Promise<{ status: string; time: string }> {
    const res = await fetch(`${this.baseUrl}/ping`);
    if (!res.ok) throw new DavemaError(res.status, "ping", await res.text());
    return res.json();
  }

  async get<T = unknown>(
    endpoint: DavemaEndpoint,
    symbol: string,
    tf = "M15",
    history?: HistoryParams
  ): Promise<DavemaEnvelope<T>> {
    const params = new URLSearchParams({ symbol, tf });
    if (history) {
      params.set("from", history.from);
      params.set("to", history.to);
    }
    const headers: Record<string, string> = {};
    if (this.apiKey) headers["x-api-key"] = this.apiKey;

    const res = await fetch(`${this.baseUrl}/${endpoint}?${params.toString()}`, { headers });
    if (!res.ok) {
      throw new DavemaError(res.status, endpoint, await res.text());
    }
    return res.json();
  }

  /** Convenience matching the skill doc's `get(endpoint, symbol, tf)` recipes -- returns just `.data`. */
  async data<T = unknown>(endpoint: DavemaEndpoint, symbol: string, tf = "M15"): Promise<T> {
    return (await this.get<T>(endpoint, symbol, tf)).data;
  }
}
