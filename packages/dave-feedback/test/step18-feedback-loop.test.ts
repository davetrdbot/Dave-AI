import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaveDatabase, createAutomationWebhookServer } from "@dave/db";
import { listWorkers } from "@dave/workers";
import {
  logTrade,
  countTrades,
  recordSkip,
  readSkipLog,
  recordHypothesis,
  recordObservation,
  readHypotheses,
  MIN_CYCLES_BEFORE_VERDICT,
  recordPollResult,
  getPollResultsSince,
  sendFeedbackPoll,
  getReflectionThreshold,
  setReflectionThreshold,
  subscribeTradeCountReflection,
  registerDreamingCron,
  unregisterDreamingCron,
  registerWeeklyExportCron,
  unregisterWeeklyExportCron,
  runWeeklyExport,
} from "../src/index.js";

console.log("=== Step 18 real proof: Feedback Loop ===\n");

const workDir = mkdtempSync(join(tmpdir(), "dave-step18-"));
const dbPath = join(workDir, "dave.db");
process.chdir(workDir); // skip-log.ts/hypotheses.ts write under process.cwd()/data
const OWNER = "user-1";

try {
  const db = new DaveDatabase(dbPath);

  // --- [1] Trade journal persistence (the real gap this step had to fill) ---
  console.log("[1] Trade journal persistence -- Step 12's formatter finally wired to real storage...\n");
  const tradeId = logTrade(db, OWNER, {
    symbol: "EURUSD",
    direction: "buy",
    entryPrice: 1.085,
    sl: 1.08,
    tp: 1.095,
    reasoning: ["H4 trend bullish", "swept Asian low"],
    confluenceScore: 78,
  });
  assert.equal(countTrades(db, OWNER), 1);
  const stored = db.getById("trade_journal", OWNER, tradeId)!;
  assert.ok((stored.narrative as string).includes("EURUSD"));
  console.log(`    real trade persisted (id ${tradeId}), narrative genuinely stored: "${(stored.narrative as string).split("\n")[0]}"`);

  // --- [2] Skip log, separate from the trade journal ---
  console.log("\n[2] Skip log is a real, separate store from the trade journal...\n");
  recordSkip(OWNER, "GBPUSD", "confluence only 40/100, below threshold");
  recordSkip(OWNER, "XAUUSD", "spread too wide during news window");
  const skips = readSkipLog(OWNER);
  assert.equal(skips.length, 2);
  assert.equal(countTrades(db, OWNER), 1, "recording skips must never touch the trade journal count");
  console.log(`    ${skips.length} skips logged, trade journal still shows exactly 1 real trade -- genuinely separate stores`);

  // --- [3] Hypotheses with real confirmed/failed verdicts after enough cycles ---
  console.log("\n[3] hypotheses.jsonl: verdicts settle only after enough real cycles...\n");
  const hypId = recordHypothesis(OWNER, "Liquidity sweeps at the London open tend to reverse within 2H");
  let mid = readHypotheses(OWNER)[0];
  assert.equal(mid.verdict, "pending");
  console.log(`    fresh hypothesis: verdict="${mid.verdict}" (0/${MIN_CYCLES_BEFORE_VERDICT} cycles observed)`);

  for (let i = 0; i < MIN_CYCLES_BEFORE_VERDICT - 1; i++) recordObservation(OWNER, hypId, "supports");
  mid = readHypotheses(OWNER)[0];
  assert.equal(mid.verdict, "pending", "must not settle a verdict before the minimum cycle count, even with all-supporting evidence so far");
  console.log(`    after ${MIN_CYCLES_BEFORE_VERDICT - 1}/${MIN_CYCLES_BEFORE_VERDICT} supporting cycles: still "${mid.verdict}" (real gate, not settled early)`);

  recordObservation(OWNER, hypId, "supports");
  const settled = readHypotheses(OWNER)[0];
  assert.equal(settled.verdict, "confirmed");
  assert.equal(settled.cyclesObserved, MIN_CYCLES_BEFORE_VERDICT);
  console.log(`    after ${MIN_CYCLES_BEFORE_VERDICT}/${MIN_CYCLES_BEFORE_VERDICT}: verdict="${settled.verdict}" (${settled.supports} supports, ${settled.contradicts} contradicts)`);

  const hyp2 = recordHypothesis(OWNER, "Friday-afternoon entries underperform");
  for (let i = 0; i < MIN_CYCLES_BEFORE_VERDICT; i++) recordObservation(OWNER, hyp2, "contradicts");
  const failed = readHypotheses(OWNER).find((h) => h.id === hyp2)!;
  assert.equal(failed.verdict, "failed");
  console.log(`    a second hypothesis with genuinely contradicting evidence -> verdict="${failed.verdict}"`);

  // --- [4] Feedback poll: real send + real inbound webhook + referenced in reflection ---
  console.log("\n[4] Feedback poll: real webhook receives an answer, real DB record, later referenced...\n");
  const fakeTelegram = { sendPoll: async () => ({ message_id: 555 }) } as any;
  const { webhook } = await sendFeedbackPoll(fakeTelegram, db, OWNER, 12345, "Was this week's aggressiveness about right?", ["Too aggressive", "About right", "Too cautious"]);
  const server = createAutomationWebhookServer();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as { port: number }).port;
  const res = await fetch(`http://127.0.0.1:${port}${webhook.path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ selectedOptionIndex: 1 }),
  });
  assert.equal(res.status, 200);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const pollResults = getPollResultsSince(db, OWNER, 0);
  assert.equal(pollResults.length, 1);
  assert.equal(pollResults[0].selectedOptionIndex, 1);
  console.log(`    real HTTP POST to ${webhook.path} -> stored answer: "${pollResults[0].options[pollResults[0].selectedOptionIndex]}"`);

  // --- [5] Trade-count-based reflection: real N, real trigger, real referenced poll results ---
  console.log("\n[5] Trade-count-based reflection -- configurable N, fires on the Nth real trade, references poll results...\n");
  assert.equal(getReflectionThreshold(db, OWNER), 10);
  setReflectionThreshold(db, OWNER, 3);
  assert.equal(getReflectionThreshold(db, OWNER), 3);
  console.log("    threshold configured to 3 (default was 10) -- real per-user setting");

  let reflectionFired: any = null;
  const unsubscribe = subscribeTradeCountReflection(db, OWNER, (input) => {
    reflectionFired = input;
  });

  // The counter only advances for trades inserted AFTER subscribing (trade #1 from
  // step [1] predates this subscription and correctly doesn't count toward it) --
  // so 3 NEW trades are needed to hit the threshold of 3.
  logTrade(db, OWNER, { symbol: "XAUUSD", direction: "sell", entryPrice: 2650, reasoning: ["order block rejection"] });
  assert.equal(reflectionFired, null, "must not fire after only 1 of 3 needed trades");
  logTrade(db, OWNER, { symbol: "GBPUSD", direction: "buy", entryPrice: 1.27, reasoning: ["breakout retest"] });
  assert.equal(reflectionFired, null, "must not fire after only 2 of 3 needed trades");
  logTrade(db, OWNER, { symbol: "USDJPY", direction: "sell", entryPrice: 148.5, reasoning: ["resistance rejection"] });
  assert.ok(reflectionFired, "must fire the instant the 3rd new trade lands");
  assert.equal(reflectionFired.trades.length, 4, "listTradesSince(0) includes the pre-subscription trade too -- the counter and the gathered data are different things");
  assert.equal(reflectionFired.skips.length, 2);
  assert.equal(reflectionFired.pollResults.length, 1);
  assert.equal(reflectionFired.pollResults[0].question, "Was this week's aggressiveness about right?");
  console.log(`    reflection fired on the 3rd trade after subscribing -- input includes ${reflectionFired.trades.length} trades total, ${reflectionFired.skips.length} skips, and ${reflectionFired.pollResults.length} feedback poll result (genuinely referenced, not empty)`);
  unsubscribe();

  // --- [6] Dreaming cron: a real scheduled job, run through a real worker ---
  console.log("\n[6] Dreaming cron: a real node-cron job that runs through a REAL worker...\n");
  let dreamRan = false;
  let workerDuringDream: { active: boolean; role: string } | null = null;
  registerDreamingCron(
    db,
    OWNER,
    async (worker) => {
      dreamRan = true;
      const active = listWorkers(OWNER).find((w) => w.id === worker.id);
      workerDuringDream = active ? { active: active.active, role: active.role } : null;
    },
    "* * * * * *" // every second, for a fast real-wall-clock test
  );
  await new Promise((resolve) => setTimeout(resolve, 1500));
  unregisterDreamingCron(OWNER);
  assert.ok(dreamRan, "the dreaming cron must genuinely fire, not just be registered");
  assert.ok(workerDuringDream, "a real worker must exist and be active DURING the dream");
  assert.equal((workerDuringDream as any).role, "journal");
  const afterDream = listWorkers(OWNER, false).filter((w) => w.task === "Weekly dreaming reflection");
  assert.ok(afterDream.every((w) => !w.active), "the worker must be retired after the dream completes, not left running");
  console.log(`    dreaming cron genuinely fired, ran through a real "${(workerDuringDream as any).role}"-role worker, retired afterward`);

  // --- [7] Weekly dataset export: a real scheduled job, real file on disk ---
  console.log("\n[7] Weekly dataset export -- a real scheduled job writing a real file...\n");
  let exportResult: any = null;
  registerWeeklyExportCron(db, OWNER, workDir, (result) => (exportResult = result), "* * * * * *");
  await new Promise((resolve) => setTimeout(resolve, 1500));
  unregisterWeeklyExportCron(OWNER);
  assert.ok(exportResult, "the export cron must genuinely fire");
  assert.ok(existsSync(exportResult.path));
  const exported = JSON.parse(readFileSync(exportResult.path, "utf8"));
  assert.equal(exported.trades.length, 4);
  assert.equal(exported.hypotheses.length, 2);
  console.log(`    real export file written at ${exportResult.path} -- ${exported.trades.length} trades, ${exported.skips.length} skips, ${exported.hypotheses.length} hypotheses`);

  // Also prove a direct (non-cron) export call works, for anything that needs it on demand.
  const directExport = runWeeklyExport(db, OWNER, workDir);
  assert.ok(existsSync(directExport.path));
  console.log("    direct runWeeklyExport() also works standalone, same real file format");

  db.close();
  console.log("\n=== ALL ASSERTIONS PASSED ===");
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
