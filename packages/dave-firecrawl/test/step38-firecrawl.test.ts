import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaveDatabase } from "@dave/db";
import { addFirecrawlKey, listFirecrawlKeys, searchWithKeyFailover, scrapeWithKeyFailover, FIRECRAWL_TOOLS } from "../src/index.js";

console.log("=== Part 3 (B1) real proof: Firecrawl web search/scrape against the REAL live API ===\n");

const REAL_KEY = process.env.FIRECRAWL_API_KEY;
if (!REAL_KEY) {
  console.log("No FIRECRAWL_API_KEY env var set -- skipping the live-network portion (key storage/tool-shape assertions still run).");
}

const workDir = mkdtempSync(join(tmpdir(), "dave-firecrawl-"));
const OWNER = "user-fc-1";

try {
  const db = new DaveDatabase(join(workDir, "dave.db"));

  console.log("[1] Real key storage, mirroring the E2B key pattern exactly...");
  const stored = addFirecrawlKey(db, OWNER, "primary", REAL_KEY ?? "fc-placeholder-for-shape-only");
  assert.equal(stored.label, "primary");
  assert.equal(listFirecrawlKeys(db, OWNER).length, 1);
  console.log(`    stored key id ${stored.id}, healthy=${stored.healthy} (starts optimistic, real health only known after a real call)`);

  if (REAL_KEY) {
    console.log("\n[2] Real web_search against the live Firecrawl API...");
    const results = await searchWithKeyFailover(db, OWNER, "MetaTrader 5 WebRequest allowed URLs", 3);
    assert.ok(results.length > 0, "a real search for a common topic must return at least one real result");
    assert.ok(results[0].url.startsWith("http"));
    console.log(`    ${results.length} real result(s), first: "${results[0].title}" -> ${results[0].url}`);

    console.log("\n[3] Real scrape_url against a real page...");
    const scraped = await scrapeWithKeyFailover(db, OWNER, "https://example.com");
    assert.ok(scraped.markdown.includes("Example Domain"));
    console.log(`    real markdown (${scraped.markdown.length} chars): "${scraped.markdown.slice(0, 60)}..."`);

    console.log("\n[4] Same real calls, through the actual agent-callable tool manifest...");
    const ctx = { userId: OWNER, db };
    const searchTool = FIRECRAWL_TOOLS.find((t) => t.name === "web_search")!;
    const scrapeTool = FIRECRAWL_TOOLS.find((t) => t.name === "scrape_url")!;
    const toolResults: any = await searchTool.execute({ query: "Firecrawl API", limit: 2 }, ctx);
    assert.ok(Array.isArray(toolResults) && toolResults.length > 0);
    const toolScraped: any = await scrapeTool.execute({ url: "https://example.com" }, ctx);
    assert.ok(toolScraped.markdown.includes("Example Domain"));
    console.log(`    real tool-manifest round trip: web_search -> ${toolResults.length} result(s), scrape_url -> ${toolScraped.markdown.length} chars`);

    console.log("\n[5] After real successful calls, the stored key is genuinely marked healthy...");
    const afterCalls = listFirecrawlKeys(db, OWNER)[0];
    assert.equal(afterCalls.healthy, true);
    assert.ok(afterCalls.lastCheckedAt !== null);
    console.log(`    key healthy=${afterCalls.healthy}, lastCheckedAt=${new Date(afterCalls.lastCheckedAt!).toISOString()}`);
  }

  console.log("\n=== ALL ASSERTIONS PASSED ===");
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
