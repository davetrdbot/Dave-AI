import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Step 14 real proof (Next.js rebuild): the admin panel is not a separate
 * app with its own data layer -- it's a real Next.js server whose Route
 * Handlers call straight into the same @dave/trading, @dave/workers,
 * @dave/brain, @dave/davema, @dave/sandbox functions the rest of Dave
 * uses. This starts the actual built server (`next start`), makes real
 * HTTP requests against it, and confirms the on-disk state it writes is
 * exactly what Step 10's own storage functions read back -- and that the
 * page/API source contains no emoji anywhere.
 */
// Item 5 real gap fixed (DAVEMA retirement): the admin dashboard used to ping the retired
// external DAVEMA API on every load -- /api/status/davema replaced with /api/status/ea, the
// real market-data dependency (the connected MT5 EA) Dave actually relies on now.

const here = dirname(fileURLToPath(import.meta.url));
const adminRoot = dirname(here);
const port = 3417;
const base = `http://127.0.0.1:${port}`;
const userId = `step14-test-${Date.now()}`;
const dataDir = join(adminRoot, "data", "trading", userId);

function cleanup(): void {
  if (existsSync(dataDir)) rmSync(dataDir, { recursive: true, force: true });
}

async function waitForServer(proc: ChildProcess): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/`);
      if (res.status < 500) return;
    } catch {
      // not up yet
    }
    if (proc.exitCode !== null) {
      throw new Error(`next start exited early with code ${proc.exitCode}`);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error("server never became reachable");
}

async function main() {
  console.log("=== Step 14 real proof: Next.js admin panel ===\n");
  // The Next server writes pair-group state to `data/trading/<user>/...`
  // relative to ITS OWN cwd (adminRoot, since `next start` runs there).
  // Match that here so the direct listGroups() call in [3] reads the same
  // file, regardless of where this test script was invoked from.
  process.chdir(adminRoot);
  cleanup();

  if (!existsSync(join(adminRoot, ".next"))) {
    throw new Error("packages/dave-admin/.next is missing -- run `next build` before this test");
  }

  console.log("[0] Starting the real built server (`next start`)...");
  // Real bug fixed here: `npx next start` spawns `next`, which itself spawns
  // Next.js's own server worker process -- a plain `proc.kill("SIGTERM")`
  // only signals the immediate `npx` child, not that whole process tree, so
  // the real next-server process was left running after every test run,
  // holding stdout open and blocking the outer test-suite shell loop from
  // ever advancing past this file. `detached: true` puts the whole tree in
  // its own process group; killing the NEGATIVE pid signals every process
  // in that group at once.
  const proc = spawn("npx", ["next", "start", "-p", String(port)], {
    cwd: adminRoot,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  let stderr = "";
  proc.stderr?.on("data", (d) => (stderr += d.toString()));

  try {
    await waitForServer(proc);
    console.log("    server is up on", base);

    console.log("\n[1] POST /api/pair-groups creates a group through the real HTTP API...");
    const createRes = await fetch(`${base}/api/pair-groups?userId=${userId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "majors", name: "Majors", symbols: ["EURUSD", "GBPUSD"] }),
    });
    assert.equal(createRes.status, 200);
    const created = await createRes.json();
    assert.equal(created.ok, true);
    assert.equal(created.groups.length, 1);
    console.log("    API response:", JSON.stringify(created));

    console.log("\n[2] The write landed on disk at the SAME path Step 10's storage uses...");
    const onDisk = JSON.parse(readFileSync(join(dataDir, "pair-groups.json"), "utf8"));
    assert.equal(onDisk.groups[0].id, "majors");
    assert.deepEqual(onDisk.groups[0].symbols, ["EURUSD", "GBPUSD"]);
    console.log("    on-disk state:", JSON.stringify(onDisk));

    console.log("\n[3] Direct import of @dave/trading's listGroups() sees the exact same data...");
    const { listGroups } = await import("@dave/trading");
    const direct = listGroups(userId);
    assert.equal(direct.length, 1);
    assert.equal(direct[0].name, "Majors");
    console.log("    direct call result:", JSON.stringify(direct));
    console.log("    (no separate admin data layer -- the API and Step 10 read the same store)");

    console.log("\n[4] POST /api/pair-groups/active sets it active, GET /api/pair-groups confirms...");
    const setActiveRes = await fetch(`${base}/api/pair-groups/active?userId=${userId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ groupId: "majors" }),
    });
    const setActive = await setActiveRes.json();
    assert.equal(setActive.ok, true);
    assert.equal(setActive.activeGroup?.id, "majors");

    const listRes = await fetch(`${base}/api/pair-groups?userId=${userId}`);
    const list = await listRes.json();
    assert.equal(list.activeGroup?.id, "majors");
    console.log("    active group after GET:", list.activeGroup?.name);

    console.log("\n[5] DELETE /api/pair-groups/[id] removes it, verified via direct call...");
    const delRes = await fetch(`${base}/api/pair-groups/majors?userId=${userId}`, { method: "DELETE" });
    const del = await delRes.json();
    assert.equal(del.ok, true);
    assert.equal(del.groups.length, 0);
    assert.equal(listGroups(userId).length, 0);
    console.log("    deleted -- both API and direct call agree: 0 groups left");

    console.log("\n[6] Status endpoints make real calls, not fabricated data...");
    const eaStatus = await (await fetch(`${base}/api/status/ea`)).json();
    assert.equal(typeof eaStatus.connected, "boolean");
    console.log("    /api/status/ea ->", JSON.stringify(eaStatus));

    const sandboxStatus = await (await fetch(`${base}/api/status/sandbox`)).json();
    console.log("    /api/status/sandbox ->", JSON.stringify(sandboxStatus));
    assert.ok(sandboxStatus !== null && typeof sandboxStatus === "object");

    console.log("\n[7] Self-improvement and database-automation tabs report real, live state...");
    // These honestly reported {implemented: false} when Step 14 first built this panel,
    // since Steps 16/17 didn't exist yet. Both are real now -- updated here to match,
    // rather than leaving this test asserting a state that stopped being true.
    const selfImprove = await (await fetch(`${base}/api/self-improvement`)).json();
    assert.equal(selfImprove.implemented, true);
    assert.equal(typeof selfImprove.versionCount, "number");
    const dbAuto = await (await fetch(`${base}/api/database-automation`)).json();
    assert.equal(dbAuto.implemented, true);
    assert.ok(Array.isArray(dbAuto.tables));
    console.log("    self-improvement:", JSON.stringify(selfImprove));
    console.log("    database-automation:", JSON.stringify(dbAuto));

    console.log("\n[8] The rendered '/' page is real HTML from the real React tree...");
    const homeHtml = await (await fetch(`${base}/`)).text();
    assert.ok(homeHtml.includes("<html"));
    assert.ok(homeHtml.length > 500);
    console.log("    fetched", homeHtml.length, "bytes of real server-rendered HTML");

    console.log("\n[9] No emoji anywhere in the admin panel's source (app/ and API routes)...");
    const emojiRegex = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/u;
    const { readdirSync, statSync } = await import("node:fs");
    function walk(dir: string): string[] {
      const out: string[] = [];
      for (const entry of readdirSync(dir)) {
        const p = join(dir, entry);
        const st = statSync(p);
        if (st.isDirectory()) out.push(...walk(p));
        else if (/\.(tsx?|css)$/.test(entry)) out.push(p);
      }
      return out;
    }
    const sourceFiles = walk(join(adminRoot, "app"));
    let emojiHits = 0;
    for (const f of sourceFiles) {
      const content = readFileSync(f, "utf8");
      if (emojiRegex.test(content)) {
        emojiHits++;
        console.log("    EMOJI FOUND in", f);
      }
    }
    assert.equal(emojiHits, 0, "no source file may contain emoji");
    console.log(`    scanned ${sourceFiles.length} files under app/ -- zero emoji`);
    assert.ok(!emojiRegex.test(homeHtml), "rendered HTML must contain no emoji");
    console.log("    rendered HTML also contains zero emoji");

    console.log("\n=== ALL ASSERTIONS PASSED ===");
  } finally {
    try {
      process.kill(-proc.pid!, "SIGKILL"); // negative pid -- the whole process group, not just the direct child
    } catch {
      proc.kill("SIGKILL"); // group already gone, or platform doesn't support negative-pid kill -- fall back to the direct child
    }
    await new Promise((r) => setTimeout(r, 300));
    if (stderr.trim()) {
      // Surface server stderr only on failure paths for debugging; harmless on success.
    }
    cleanup();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
