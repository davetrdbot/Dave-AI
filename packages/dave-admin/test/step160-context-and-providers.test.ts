import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const workDir = mkdtempSync(join(tmpdir(), "dave-context-providers-"));
process.env.DAVE_DATA_ROOT = workDir;
process.env.DATA_DIR = join(workDir, "db");
delete process.env.OWNER_USER_ID;

const { NextRequest } = await import("next/server");
const { createPairingCode, redeemPairingCode } = await import("../server/device-auth.js");
const brain = await import("@dave/brain");
const { DaveDatabase } = await import("@dave/db");
const { dbPathFor } = await import("../server/db-path.js");
const usage = await import("../../dave-agent-loop/src/context-usage.js");
const { withLiveContext } = await import("../../dave-agent-loop/src/live-context.js");
const contextRoute = await import("../app/api/app/context/route.js");
const providerRoute = await import("../app/api/app/provider/route.js");
const providersRoute = await import("../app/api/app/providers/route.js");

/**
 * The trader: "add this [context window panel] to the app ... how it was used for the full day,
 * and add all the providers to the settings". The bot writes, the admin reads -- this drives the
 * bot's real recorder and the phone's real routes against the same files.
 */

console.log("=== Step 160: context window + daily usage, and every AI provider in the app ===\n");

const USER = "default";
const { code } = createPairingCode(USER);
const { token } = redeemPairingCode(USER, code, "test phone");

type Handler = (req: InstanceType<typeof NextRequest>) => Promise<Response>;
async function call(handler: Handler, method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const req = new NextRequest(`http://localhost${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const res = await handler(req);
  return { status: res.status, json: await res.json() };
}

console.log("[1] A request is split into its real parts\n");
const turn = withLiveContext(USER, "what's VOL_80 doing?") as string;
const tools = [{ name: "get_all_analysis", description: "x".repeat(4000), parameters: { type: "object", properties: {} } }];
const req = {
  messages: [
    { role: "system" as const, content: "S".repeat(2000) },
    { role: "user" as const, content: "earlier question" },
    { role: "assistant" as const, content: "earlier answer" },
    { role: "user" as const, content: turn },
  ],
  tools,
};
const chars = usage.measureRequest(req);
assert.equal(chars.systemPrompt, 2000);
assert.ok(chars.tools >= 4000, "tool definitions counted");
assert.ok(chars.liveContext > 0, "the live-context block is its own part");
assert.equal(chars.messages, "earlier question".length + "earlier answer".length + "what's VOL_80 doing?".length + 2, "conversation is the real words only");
const scaled = usage.scaleParts(chars, 1234);
assert.equal(Object.values(scaled).reduce((s, v) => s + v, 0), 1234, "parts add up exactly to the provider's total");
console.log("   ✓ tools / system prompt / messages / live context measured, scaled to the real total\n");

console.log("[2] Every call is recorded: the provider's real count when reported, an honest estimate when not\n");
const t0 = new Date("2026-09-23T09:10:00Z").getTime();
let snap = usage.recordModelCall({ userId: USER, source: "chat", provider: "baseten", model: "deepseek-ai/DeepSeek-V3.2", contextWindow: 163840, req, result: { tokenUsage: { promptTokens: 9000, completionTokens: 300, totalTokens: 9300 }, cacheUsage: { cacheCreationInputTokens: 0, cacheReadInputTokens: 4000 } }, now: t0 });
assert.equal(snap!.promptTokens, 9000);
assert.equal(snap!.estimated, false);
snap = usage.recordModelCall({ userId: USER, source: "autonomous", provider: "baseten", model: "zai-org/GLM-4.7", req, result: {}, now: t0 + 60_000 });
assert.equal(snap!.estimated, true, "no usage reported -> flagged as an estimate");
assert.ok(snap!.promptTokens > 0);
usage.recordModelCall({ userId: USER, source: "background", provider: "baseten", req, result: { tokenUsage: { promptTokens: 500, completionTokens: 50, totalTokens: 550 } }, now: t0 + 2 * 3600_000 });
console.log("   ✓ chat, autonomous (estimated) and a background check recorded\n");

console.log("[3] The phone reads the same records\n");
let r = await call(contextRoute.GET as Handler, "GET", "/api/app/context?days=45");
assert.equal(r.status, 200);
assert.equal(r.json.chat.promptTokens, 9000);
assert.equal(r.json.chat.cachedTokens, 4000);
assert.equal(r.json.chat.contextWindow, 163840);
assert.equal(r.json.autonomous.estimated, true);
assert.equal(r.json.autonomous.contextWindow, 200_000, "window filled in from the published table when the call didn't carry one");
assert.equal(r.json.hours.length, 2, "two hours with calls");
const h9 = r.json.hours[0];
assert.equal(h9.calls, 2);
assert.equal(h9.bySource.chat.tokens, 9300);
assert.equal(h9.cachedTokens, 4000);
assert.equal(r.json.hours[1].bySource.background.calls, 1, "a background check counts toward the day but not the panel");
const primary = brain.getModelConfig(USER).primary;
assert.equal(r.json.current.provider, primary, "the main AI Dave is set to use");
assert.equal(r.json.current.model, brain.PROVIDER_CATALOG[brain.resolveProviderAlias(primary)].defaultModel);
const unauth = await (contextRoute.GET as Handler)(new NextRequest("http://localhost/api/app/context"));
assert.equal(unauth.status, 401, "device token required");
console.log("   ✓ last requests + hourly buckets reach the phone; no token, no data\n");

console.log("[4] Context windows: the provider's listing first, then the published table\n");
assert.equal(brain.contextWindowFromModelListing({ id: "x", context_length: 262144 }), 262144);
assert.equal(brain.contextWindowFromModelListing({ id: "x", metadata: { context_window: "1048000" } }), 1048000);
assert.equal(brain.contextWindowFromModelListing({ id: "x" }), undefined);
assert.equal(brain.knownContextWindow("zai-org/GLM-4.7"), 200_000);
assert.equal(brain.knownContextWindow("moonshotai/Kimi-K2.6"), 262_144);
assert.equal(brain.knownContextWindow("openai/gpt-oss-120b"), 128_000);
assert.equal(brain.knownContextWindow("some/unknown-model"), undefined, "unknown stays unknown");
console.log("   ✓\n");

console.log("[5] Every provider is listed, in Dave's order\n");
r = await call(providersRoute.GET as Handler, "GET", "/api/app/providers");
assert.equal(r.status, 200);
const catalog = Object.values(brain.PROVIDER_CATALOG).filter((e) => !e.aliasOf);
assert.equal(r.json.providers.length, catalog.length, "the whole catalogue, aliases excluded");
assert.ok(r.json.providers[0].isPrimary, "main AI first");
console.log(`   ✓ ${catalog.length} providers\n`);

console.log("[6] Any provider: add a key, make it a backup, reorder, make it main -- in the file the bot reads\n");
const RAW = "gsk_live_abcdefghijklmnop1234";
r = await call(providerRoute.GET as Handler, "GET", "/api/app/provider?provider=groq");
assert.equal(r.json.name, brain.PROVIDER_CATALOG.groq.displayName);
assert.equal(r.json.keys.length, 0);
r = await call(providerRoute.POST as Handler, "POST", "/api/app/provider", { provider: "groq", action: "add-backup" });
assert.equal(r.status, 400, "no key, no backup");
r = await call(providerRoute.POST as Handler, "POST", "/api/app/provider", { provider: "groq", action: "add-key", apiKey: RAW });
assert.equal(r.status, 200);
assert.ok(!JSON.stringify(r.json).includes(RAW), "the real key never goes back to the phone");
const db = new DaveDatabase(dbPathFor(USER));
assert.equal(brain.listProviderKeys(db, USER, "groq")[0].config.apiKey, RAW, "stored for the bot's failover pool");
db.close();
await call(providerRoute.POST as Handler, "POST", "/api/app/provider", { provider: "deepseek", action: "add-key", apiKey: "sk-deepseek-1234567890" });
await call(providerRoute.POST as Handler, "POST", "/api/app/provider", { provider: "groq", action: "add-backup" });
await call(providerRoute.POST as Handler, "POST", "/api/app/provider", { provider: "deepseek", action: "add-backup" });
let cfg = brain.getModelConfig(USER);
const backupsOf = (c: typeof cfg) => c.fallback.filter((p) => p !== c.primary);
assert.deepEqual(backupsOf(cfg).slice(-2), ["groq", "deepseek"]);
r = await call(providersRoute.POST as Handler, "POST", "/api/app/providers", { action: "move-backup", provider: "deepseek", direction: "up" });
assert.equal(r.status, 200);
cfg = brain.getModelConfig(USER);
assert.ok(backupsOf(cfg).indexOf("deepseek") < backupsOf(cfg).indexOf("groq"), "reordered");
const oldMain = cfg.primary;
r = await call(providerRoute.POST as Handler, "POST", "/api/app/provider", { provider: "groq", action: "make-main" });
assert.equal(r.json.isPrimary, true);
cfg = brain.getModelConfig(USER);
assert.equal(cfg.primary, "groq");
assert.equal(backupsOf(cfg)[0], oldMain, "the old main becomes the first backup");
await call(providerRoute.POST as Handler, "POST", "/api/app/provider", { provider: "deepseek", action: "remove-backup" });
assert.ok(!brain.getModelConfig(USER).fallback.includes("deepseek"));
console.log("   ✓\n");

console.log("[7] Providers that need more than a key ask for it; unknown providers are refused\n");
const cf = Object.values(brain.PROVIDER_CATALOG).find((e) => e.requiresExtraConfig?.includes("accountId") && !e.aliasOf)!;
r = await call(providerRoute.POST as Handler, "POST", "/api/app/provider", { provider: cf.id, action: "add-key", apiKey: "cf-key-1234567890" });
assert.equal(r.status, 400);
assert.match(r.json.error, /accountId/);
r = await call(providerRoute.POST as Handler, "POST", "/api/app/provider", { provider: cf.id, action: "add-key", apiKey: "cf-key-1234567890", accountId: "acc123" });
assert.equal(r.status, 200);
r = await call(providerRoute.GET as Handler, "GET", "/api/app/provider?provider=not-a-provider");
assert.equal(r.status, 404);
const alias = Object.values(brain.PROVIDER_CATALOG).find((e) => e.aliasOf);
if (alias) assert.equal((await call(providerRoute.GET as Handler, "GET", `/api/app/provider?provider=${alias.id}`)).status, 404, "aliases are not managed separately");
r = await call(providerRoute.GET as Handler, "GET", "/api/app/provider");
assert.equal(r.json.provider, "baseten", "no provider -> Baseten, so older app builds keep working");
console.log("   ✓\n");

console.log("=== ALL ASSERTIONS PASSED ===");
process.exit(0);
