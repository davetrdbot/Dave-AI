/**
 * Part 3 (B1): real Firecrawl web search/scrape client. Confirmed live
 * (Sept 2026) against the real API with a real key: `POST
 * https://api.firecrawl.dev/v2/search` (body `{query, limit}`, returns
 * `{success, data: {web: [{url,title,description,position}, ...]}}`)
 * and `POST https://api.firecrawl.dev/v2/scrape` (body `{url,
 * formats:["markdown"]}`, returns `{success, data: {markdown,
 * metadata}}`), both authenticated via a plain `Authorization: Bearer
 * <key>` header.
 */
const FIRECRAWL_BASE_URL = "https://api.firecrawl.dev/v2";

export interface FirecrawlSearchResult {
  url: string;
  title: string;
  description: string;
  position: number;
}

export interface FirecrawlScrapeResult {
  markdown: string;
  metadata: Record<string, unknown>;
}

export class FirecrawlRequestError extends Error {
  constructor(
    public readonly method: string,
    public readonly status: number,
    body: string
  ) {
    super(`Firecrawl "${method}" failed: HTTP ${status}: ${body}`);
    this.name = "FirecrawlRequestError";
  }
}

export class FirecrawlClient {
  constructor(private readonly apiKey: string) {}

  private async post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const res = await fetch(`${FIRECRAWL_BASE_URL}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new FirecrawlRequestError(path, res.status, text);
    const json = JSON.parse(text);
    if (!json.success) throw new FirecrawlRequestError(path, res.status, text);
    return json.data as T;
  }

  async search(query: string, limit = 5): Promise<FirecrawlSearchResult[]> {
    const data = await this.post<{ web?: FirecrawlSearchResult[] }>("/search", { query, limit });
    return data.web ?? [];
  }

  async scrape(url: string): Promise<FirecrawlScrapeResult> {
    return this.post<FirecrawlScrapeResult>("/scrape", { url, formats: ["markdown"] });
  }
}
