// Placeholder Railway entrypoint.
//
// Dave's real boot sequence (Telegram bot, DSH agent loop, webhook
// servers, scheduled jobs) doesn't exist as a single unified process yet
// -- that's Step 22 of the master build prompt ("boot the full
// application, confirm zero runtime crashes"). Every subsystem built so
// far (memory, brain, sandbox, DAVEMA, Telegram, trading) is real,
// tested library code, not yet wired into one running app.
//
// This file exists so a Railway deploy has something real and honest to
// run after a successful build, instead of either crash-looping (no
// start command) or silently doing nothing. It's a plain Node script
// with zero dependencies on the TypeScript packages, so it starts
// reliably regardless of their build state.
import { createServer } from "node:http";

const PORT = process.env.PORT || 3000;

const server = createServer((req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      status: "ok",
      service: "dave-ai",
      note: "Build succeeded. Dave's unified boot sequence (Telegram bot, agent loop) is Step 22 of the build -- not wired up yet. See PROGRESS.md.",
    })
  );
});

server.listen(PORT, () => {
  console.log(`[dave-ai placeholder] listening on port ${PORT}`);
});
