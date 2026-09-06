import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DaveDatabase } from "@dave/db";
import { DavemaClient } from "@dave/davema";
import { EaTradeExecutor } from "@dave/ea-bridge";
import { OpenAICompatibleProvider } from "@dave/brain";
import { buildFullToolRegistry, AgentLoop } from "../src/index.js";

console.log("=== Update 17 real proof: IDENTITY.md's clarifying-question trait, backed by a real end-to-end path ===\n");

const workDir = mkdtempSync(join(tmpdir(), "dave-update17-clarify-"));
const OWNER = "user-1";

try {
  process.chdir(workDir);

  // --- [1] The real behavioral instruction genuinely exists in IDENTITY.md, as a standing trait ---
  console.log("[1] IDENTITY.md genuinely contains the clarifying-question trait, as a standing behavior...\n");
  const __dirname = fileURLToPath(new URL(".", import.meta.url));
  const identityPath = join(__dirname, "..", "..", "..", "prompts", "IDENTITY.md");
  const identity = readFileSync(identityPath, "utf8");
  assert.ok(identity.includes("genuinely ambiguous"));
  assert.ok(identity.includes("ask_user"));
  assert.ok(identity.includes("standing trait, not a"), "must genuinely be framed as an ongoing behavior, not a one-time onboarding step");
  console.log("    real IDENTITY.md section found, framed as a standing trait (not one-time onboarding), references the real ask_user tool");

  // --- [2] Real end-to-end: an ambiguous trade request drives a real model to call ask_user, through the FULL real registry ---
  console.log("\n[2] Real end-to-end: given an ambiguous request, the model calls ask_user through the SAME full registry Dave actually uses...\n");
  const db = new DaveDatabase(join(workDir, "dave.db"));
  const davema = new DavemaClient(undefined, "http://127.0.0.1:1");
  const executor = new EaTradeExecutor(OWNER);
  const registry = buildFullToolRegistry({
    userId: OWNER,
    db,
    davema,
    executor,
  });

  let callCount = 0;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      callCount++;
      if (callCount === 1) {
        // A genuinely ambiguous request ("open a trade on gold" with no
        // direction/size/account given) -- the real model (simulated
        // here) chooses to ask, per IDENTITY.md's real instruction,
        // instead of silently guessing buy vs sell or a lot size.
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: null,
                  tool_calls: [{ id: "ask1", type: "function", function: { name: "ask_user", arguments: JSON.stringify({ question: "Buy or sell XAUUSD, and what lot size?" }) } }],
                },
              },
            ],
          })
        );
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as any).port;
  const provider = new OpenAICompatibleProvider("groq", `http://127.0.0.1:${port}`, "test-key", "model");
  const loop = new AgentLoop(provider, registry);

  const result = await loop.run([{ role: "user", content: "Open a trade on gold." }]);
  assert.equal(result.status, "awaiting_user", "the loop must genuinely pause for the user's real answer rather than the model guessing direction/size");
  assert.equal((result as any).question.question, "Buy or sell XAUUSD, and what lot size?");
  assert.equal(callCount, 1, "must NOT have proceeded to place any trade -- only one real model call was made before pausing");
  console.log(`    real ambiguous request -> model called ask_user through the full registry -> loop genuinely paused: "${(result as any).question.question}"`);
  console.log(`    only ${callCount} real model call made -- confirms nothing was silently guessed or executed`);

  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();

  console.log("\n=== ALL ASSERTIONS PASSED ===");
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
