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

/**
 * No fetch has a timeout without this -- a hung DAVEMA request would
 * otherwise block forever. DAVEMA is called before every trade decision
 * (IDENTITY.md), so a stuck request here stalls the whole analysis
 * pipeline, not just one call.
 */
async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export class DavemaClient {
  constructor(
    private readonly apiKey: string | undefined,
    private readonly baseUrl: string = DAVEMA_BASE_URL,
    private readonly timeoutMs: number = 10_000
  ) {}

  /** /ping needs no key, per the skill doc -- useful as a pre-flight health check. */
  async ping(): Promise<{ status: string; time: string }> {
    let res: Response;
    try {
      res = await fetchWithTimeout(`${this.baseUrl}/ping`, {}, this.timeoutMs);
    } catch (err) {
      throw new DavemaError(0, "ping", `request failed/timed out after ${this.timeoutMs}ms: ${err instanceof Error ? err.message : String(err)}`);
    }
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

    let res: Response;
    try {
      res = await fetchWithTimeout(`${this.baseUrl}/${endpoint}?${params.toString()}`, { headers }, this.timeoutMs);
    } catch (err) {
      // Includes AbortController timeouts -- converted to the same
      // DavemaError type callers already handle, rather than leaking a
      // raw AbortError that bypasses their `instanceof DavemaError` checks.
      throw new DavemaError(0, endpoint, `request failed/timed out after ${this.timeoutMs}ms: ${err instanceof Error ? err.message : String(err)}`);
    }
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
