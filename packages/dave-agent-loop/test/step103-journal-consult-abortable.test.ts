import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { DaveDatabase } from "@dave/db";
import { OpenAICompatibleProvider } from "@dave/brain";
import { consultJournal } from "../src/journal-agent.js";
import { abortTurn } from "../src/turn-abort.js";

/**
 * Real gap fixed (independent audit, confirmed live): consultJournal() constructs its own,
 * separate AgentLoop and calls .run() on it, awaited synchronously as part of a single
 * autonomous trading tick -- but it never registered with turn-abort.ts (beginTurn/endTurn), and
 * never passed a `signal` into its own loop.run() call. If Journal's own underlying provider call
 * hung, the ENTIRE autonomous tick was stuck for up to the default overall deadline
 * (agent-loop.ts's DEFAULT_OVERALL_TURN_TIMEOUT_MS, ~4 minutes) with zero way for the user to
 * cancel it early via `/stop`/`/panic` -- unlike the main chat path (turn-abort.ts,
 * telegram-bot-server.ts), which already could be cancelled early.
 *
 * Proves the real fix: a Journal consult whose underlying provider call is genuinely HUNG (a real
 * node:http server that never responds) can be cancelled early via abortTurn(ownerUserId) --
 * well before the default ~4 minute overall deadline would ever fire -- and consultJournal
 * resolves promptly with an honest, clearly-labeled "cancelled" fallback opinion rather than
 * hanging or returning something that looks like a real opinion.
 */

console.log("=== Real proof: a hung Journal consult can genuinely be cancelled early via /stop ===\n");

const workDir = mkdtempSync(join(tmpdir(), "dave-journal-abortable-"));

async function main() {
  process.chdir(workDir);
  const db = new DaveDatabase(join(workDir, "dave.db"));
  const OWNER = "user-journal-abort-1";

  console.log("[1] Journal's own underlying provider call genuinely hangs (a real HTTP server that never responds)...\n");
  let requestWasAborted = false;
  const hangingServer = createServer((req) => {
    req.on("aborted", () => {
      requestWasAborted = true;
    });
    // Deliberately never responds -- simulates Journal's own provider call genuinely hanging.
  });
  await new Promise<void>((resolve) => hangingServer.listen(0, "127.0.0.1", resolve));
  const port = (hangingServer.address() as { port: number }).port;
  const hangingProvider = new OpenAICompatibleProvider("groq", `http://127.0.0.1:${port}`, "test-key", "model");

  console.log("[2] Kicking off consultJournal() against the hung provider, then calling abortTurn(ownerUserId) early -- well before the ~4 minute default deadline...\n");
  const started = Date.now();
  const consultPromise = consultJournal({ userId: OWNER, db, provider: hangingProvider }, "Is this EURUSD setup worth taking?");

  // Give the real HTTP request time to actually reach the server before cancelling it.
  await new Promise((r) => setTimeout(r, 200));
  const wasCancelled = abortTurn(OWNER);
  assert.equal(wasCancelled, true, "abortTurn(ownerUserId) must report it genuinely found and cancelled Journal's own in-flight consult -- proving consultJournal registered it via beginTurn");

  const result = await consultPromise;
  const elapsed = Date.now() - started;

  console.log(`[3] consultJournal() resolved after ${elapsed}ms (default overall deadline is ~240,000ms) with opinion: "${result.opinion}"\n`);
  assert.ok(elapsed < 5_000, `consultJournal must resolve promptly once cancelled, nowhere near the ~4 minute default overall deadline (took ${elapsed}ms)`);
  assert.ok(result.opinion, "a real opinion string must always come back, even when cancelled");
  assert.match(result.opinion, /cancel/i, `an aborted consult must return an HONEST, clearly-labeled fallback opinion, not something that looks like a real Journal opinion (got: "${result.opinion}")`);

  // Give the server a moment to observe the real socket abort.
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(requestWasAborted, true, "the real underlying HTTP request to Journal's provider must genuinely be aborted, not merely abandoned by the caller");
  console.log(`    confirmed: cancelled in ${elapsed}ms, honest fallback opinion returned, underlying HTTP request genuinely aborted=${requestWasAborted}`);

  await new Promise<void>((resolve) => hangingServer.close(() => resolve()));

  console.log("\n[4] A user with no in-flight Journal consult is unaffected -- abortTurn is honest, never throws...\n");
  assert.equal(abortTurn("user-with-no-consult"), false);
  console.log("    confirmed: false, no throw");

  console.log("\n=== ALL ASSERTIONS PASSED ===");
}

main()
  .then(() => {
    rmSync(workDir, { recursive: true, force: true });
    process.exit(0);
  })
  .catch((err) => {
    rmSync(workDir, { recursive: true, force: true });
    console.error(err);
    process.exit(1);
  });
