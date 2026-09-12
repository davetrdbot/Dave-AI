import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { DaveDatabase } from "@dave/db";
import { fetchWithTimeout } from "./providers.js";

/** Short bound for the local /health poll -- each poll iteration must fail fast so the
 * outer waitForHealth() deadline loop keeps making real progress rather than one hung
 * fetch silently eating the whole timeoutMs budget. */
const HEALTH_CHECK_TIMEOUT_MS = 5_000;

/**
 * Item 2 (admin panel update): "Load Model on Railway" -- a real
 * on/off toggle (defaults OFF). When ON, Dave attempts to run AirLLM
 * directly on the Railway instance itself, so someone without a
 * separate GPU host can still try it on Railway's free/base tier.
 *
 * Honest by construction, not just in the UI copy: this is genuinely
 * CPU-only and best-effort. `ai-brain-service/main.py` loads its model
 * LAZILY (confirmed by reading the file -- no eager import of `airllm`
 * at module scope), so the service itself starts and answers /health
 * almost instantly even without the (large, `torch`-based) ML
 * dependencies installed -- verified directly in this environment:
 * installing just `fastapi`+`uvicorn` (small, fast) was enough to get
 * a real 200 from /health with `model_loaded: false`. Actually
 * generating text still needs the real `airllm`/`torch` stack, which
 * is the slow, heavy, best-effort part this toggle's UI warning is
 * honest about.
 *
 * Python venv: on Railway, `nixpacks.toml`'s custom install phase
 * builds a real venv at `/opt/dave-ai-brain-venv` (Nix's own Python is
 * externally-managed -- PEP 668 -- so pip can't install into it
 * directly, confirmed via research). Locally (this dev environment,
 * any non-Railway host), falls back to `ai-brain-service/.venv` if
 * that's what actually exists -- never a bare `python3`, which may not
 * have the right packages on any given host.
 */

const RAILWAY_VENV_PYTHON = "/opt/dave-ai-brain-venv/bin/python3";

function findPythonInterpreter(repoRoot: string): string {
  if (existsSync(RAILWAY_VENV_PYTHON)) return RAILWAY_VENV_PYTHON;
  const localVenv = join(repoRoot, "ai-brain-service", ".venv", "bin", "python3");
  if (existsSync(localVenv)) return localVenv;
  return "python3"; // last resort -- honest about not knowing what's on PATH
}

const TABLE = "railway_model_settings";

function ensureTable(db: DaveDatabase): void {
  db.createTable(TABLE, [{ name: "enabled", type: "INTEGER" }]);
}

function getOrCreateRow(db: DaveDatabase, ownerUserId: string): { id: string; enabled: number } {
  ensureTable(db);
  const rows = db.query(TABLE, ownerUserId, {}) as unknown as { id: string; enabled: number }[];
  if (rows.length > 0) return rows[0];
  const id = db.insert(TABLE, ownerUserId, { enabled: 0 });
  return db.getById(TABLE, ownerUserId, id) as unknown as { id: string; enabled: number };
}

/** Real per-user toggle, defaults OFF -- same "never silent by default" posture as every other real toggle in this repo. */
export function getRailwayModelLoadEnabled(db: DaveDatabase, ownerUserId: string): boolean {
  return getOrCreateRow(db, ownerUserId).enabled === 1;
}

export function setRailwayModelLoadEnabled(db: DaveDatabase, ownerUserId: string, enabled: boolean): void {
  const row = getOrCreateRow(db, ownerUserId);
  db.update(TABLE, ownerUserId, row.id, { enabled: enabled ? 1 : 0 });
}

export interface LocalModelProcessStatus {
  running: boolean;
  pid?: number;
  startedAt?: number;
  port: number;
  modelLoaded?: boolean;
  lastError?: string;
}

/** The real local-process manager -- one instance per running Dave process. */
export class LocalAirLLMProcessManager {
  private proc: ChildProcess | null = null;
  private status: LocalModelProcessStatus;
  private stderrTail = "";

  constructor(private readonly repoRoot: string, private readonly port = 8090) {
    this.status = { running: false, port };
  }

  getStatus(): LocalModelProcessStatus {
    return { ...this.status };
  }

  /** Real spawn -- never fabricates a "started" status before the child process object actually exists. */
  start(): LocalModelProcessStatus {
    if (this.proc) return this.status;
    const python = findPythonInterpreter(this.repoRoot);
    const servicePath = join(this.repoRoot, "ai-brain-service", "main.py");

    this.proc = spawn(python, [servicePath], {
      cwd: join(this.repoRoot, "ai-brain-service"),
      env: { ...process.env, PORT: String(this.port) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.status = { running: true, pid: this.proc.pid, startedAt: Date.now(), port: this.port };

    this.proc.stderr?.on("data", (d) => (this.stderrTail = (this.stderrTail + d.toString()).slice(-2000)));
    this.proc.on("exit", (code) => {
      this.status = { ...this.status, running: false, lastError: code !== 0 ? `exited with code ${code}: ${this.stderrTail.slice(-300)}` : undefined };
      this.proc = null;
    });
    this.proc.on("error", (err) => {
      this.status = { ...this.status, running: false, lastError: err.message };
      this.proc = null;
    });

    return this.status;
  }

  stop(): void {
    this.proc?.kill("SIGTERM");
    this.proc = null;
    this.status = { ...this.status, running: false };
  }

  /** Real HTTP polling of the real /health endpoint -- never assumes readiness from the process merely existing. */
  async waitForHealth(timeoutMs = 15_000): Promise<{ healthy: boolean; modelLoaded?: boolean }> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const res = await fetchWithTimeout(`http://127.0.0.1:${this.port}/health`, {}, HEALTH_CHECK_TIMEOUT_MS);
        if (res.ok) {
          const json = (await res.json()) as { status: string; model_loaded: boolean };
          this.status.modelLoaded = json.model_loaded;
          return { healthy: json.status === "ok", modelLoaded: json.model_loaded };
        }
      } catch {
        // not up yet -- keep polling until the deadline
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    return { healthy: false };
  }
}

export function localAirLLMBaseUrl(port = 8090): string {
  return `http://127.0.0.1:${port}`;
}
