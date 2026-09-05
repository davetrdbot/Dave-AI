// Real Railway entrypoint -- Dave's unified boot sequence.
//
// This is a thin wrapper around the real composition root,
// packages/dave-agent-loop/src/main.ts (compiled to lib/main.js): it
// builds a real DaveDatabase, the real EA/R_Feed bridges, the real
// automation + hidden-memory webhook servers, and (when a bot token and
// a public URL are available) the real Telegram bot server backed by
// the full tool registry -- all multiplexed onto the single PORT
// Railway gives this process.
//
// Kept deliberately tiny and dependency-light at this outer layer: if
// anything inside main() throws in a way it doesn't already catch
// itself (main() already degrades gracefully around a missing/invalid
// Telegram token), this still wraps the call so the process falls back
// to a minimal health-check server instead of crash-looping.
import { createServer } from "node:http";

const PORT = Number(process.env.PORT) || 3000;

function log(...args) {
  console.log("[dave-ai boot]", ...args);
}

function startFallbackServer(reason) {
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "degraded", service: "dave-ai", reason }));
  });
  server.listen(PORT, () => log(`degraded mode listening on port ${PORT} -- reason: ${reason}`));
  return server;
}

try {
  const { main } = await import("@dave/agent-loop");
  await main();
} catch (err) {
  console.error("[dave-ai boot] FATAL during startup, falling back to a degraded health-check server:", err);
  startFallbackServer(`unexpected boot error: ${err instanceof Error ? err.message : String(err)}`);
}
