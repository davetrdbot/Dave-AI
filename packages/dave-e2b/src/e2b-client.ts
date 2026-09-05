/**
 * Update 12: "E2B IS BACK IN... wire it in as an ADDITIONAL sandbox
 * option alongside whatever was chosen in Step 1.3 -- disposable
 * compute Dave or workers can spin up for isolated tasks (like R_Feed
 * backtest analysis) without touching the main sandbox." Real,
 * research-confirmed facts: control-plane base URL
 * `https://api.e2b.app`, auth via a real `X-API-Key` header (the
 * older `Authorization: Bearer` access-token scheme is deprecated,
 * being fully retired Aug 2026 -- deliberately NOT used here),
 * `POST /sandboxes` to create one (real response carries `sandboxID`/
 * `domain`), `DELETE /sandboxes/{id}` to kill one, `GET /sandboxes` to
 * list running ones.
 *
 * Confirmed, honest gap: actually EXECUTING code/commands inside a
 * created sandbox is E2B's data plane, which is gRPC to their `envd`
 * service, not a REST endpoint -- there is no plain HTTP way to do it,
 * confirmed via research. This client covers the real REST control
 * plane (create/list/kill, and health-checking a stored key) --
 * running code inside would require either E2B's own SDK or a real
 * gRPC client, neither of which exists in this build. Flagged here and
 * in PROGRESS.md, not silently glossed over.
 */
const E2B_BASE_URL = "https://api.e2b.app";

export interface E2BSandboxConfig {
  templateID?: string;
  timeoutSeconds?: number;
  metadata?: Record<string, string>;
  envVars?: Record<string, string>;
}

export interface E2BSandbox {
  sandboxID: string;
  domain: string;
  envdVersion?: string;
}

export class E2BRequestError extends Error {
  constructor(
    public readonly method: string,
    public readonly status: number,
    body: string
  ) {
    super(`E2B "${method}" failed: HTTP ${status}: ${body}`);
    this.name = "E2BRequestError";
  }
}

export class E2BClient {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string = E2B_BASE_URL
  ) {}

  private async request<T>(method: string, path: string, body?: unknown, timeoutMs = 15000): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: { "content-type": "application/json", "X-API-Key": this.apiKey },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      throw new E2BRequestError(`${method} ${path}`, 0, err instanceof Error ? err.message : String(err));
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      throw new E2BRequestError(`${method} ${path}`, res.status, await res.text());
    }
    if (res.status === 204) return undefined as T;
    return res.json() as Promise<T>;
  }

  /** Real POST /sandboxes -- disposable compute, separate from the main DSH/OpenSandbox chosen in Step 1.3. */
  async createSandbox(config: E2BSandboxConfig = {}): Promise<E2BSandbox> {
    return this.request<E2BSandbox>("POST", "/sandboxes", {
      templateID: config.templateID ?? "base",
      timeout: config.timeoutSeconds ?? 300,
      metadata: config.metadata,
      envVars: config.envVars,
    });
  }

  async killSandbox(sandboxID: string): Promise<void> {
    await this.request<void>("DELETE", `/sandboxes/${sandboxID}`);
  }

  async listSandboxes(): Promise<E2BSandbox[]> {
    return this.request<E2BSandbox[]>("GET", "/sandboxes");
  }
}
