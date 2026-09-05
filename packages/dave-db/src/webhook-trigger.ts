import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

/**
 * Step 16.2(c): webhook/connector triggers -- fires on a real external
 * HTTP event. Own token namespace, `/hooks/automation/<token>`,
 * distinct from Step 4's `/hooks/user/<token>` (Dave-to-user pushes)
 * and Step 12's `/hooks/worker/<id>/<token>` (worker reports) -- this
 * one is the reverse direction: an external service calling INTO Dave
 * to fire a registered automation.
 */

export interface AutomationWebhook {
  id: string;
  token: string;
  path: string;
}

interface RegisteredHook {
  id: string;
  handler: (payload: unknown) => void | Promise<void>;
}

const registry = new Map<string, RegisteredHook>();

const PREFIX = "/hooks/automation";

/** `existingToken` lets a caller (e.g. automation-runtime, re-wiring on every registry rebuild) keep the SAME real URL stable across restarts instead of generating a new one every time -- otherwise an external service pointed at the old URL would silently stop firing. */
export function registerWebhookTrigger(id: string, handler: (payload: unknown) => void | Promise<void>, existingToken?: string): AutomationWebhook {
  const token = existingToken ?? randomBytes(24).toString("hex");
  registry.set(token, { id, handler });
  return { id, token, path: `${PREFIX}/${token}` };
}

export function unregisterWebhookTrigger(token: string): void {
  registry.delete(token);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

export function createAutomationWebhookServer(): Server {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "";
    if (req.method !== "POST" || !url.startsWith(`${PREFIX}/`)) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }
    const token = url.slice(`${PREFIX}/`.length);
    const hook = registry.get(token);
    if (!hook) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "unknown webhook token" }));
      return;
    }
    const body = await readBody(req);
    let payload: unknown;
    try {
      payload = body ? JSON.parse(body) : {};
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "invalid JSON body" }));
      return;
    }
    await hook.handler(payload);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, id: hook.id }));
  });
}
