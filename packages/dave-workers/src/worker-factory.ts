import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

/**
 * Step 12.1/12.2: workers named like people, created by Dave on the fly
 * -- not a fixed roster. Dave decides whether an assignment is fixed
 * (ongoing) or temporary (one-off).
 */

export type WorkerAssignment = "fixed" | "temporary";
export type WorkerRole = "generic" | "journal" | "trading";

export interface Worker {
  id: string;
  name: string;
  ownerUserId: string;
  assignment: WorkerAssignment;
  role: WorkerRole;
  task: string;
  createdAt: number;
  active: boolean;
}

/**
 * A pool of real first names Dave can draw from when creating a worker
 * without the calling context naming one explicitly -- "named like
 * people," not "Worker-1"/"Worker-2". Not exhaustive, just enough to
 * avoid obviously running out for a realistic number of concurrent
 * workers.
 */
const NAME_POOL = [
  "Martins", "Priya", "Kenji", "Elena", "Tomás", "Aisha", "Lucas", "Noor",
  "Sofia", "Kwame", "Yuki", "Ingrid", "Diego", "Amara", "Felix", "Mei",
  "Oliver", "Zara", "Rowan", "Leila",
];

function registryPath(ownerUserId: string): string {
  return join(process.cwd(), "data", "workers", ownerUserId, "registry.json");
}

function readRegistry(ownerUserId: string): Worker[] {
  const path = registryPath(ownerUserId);
  if (!existsSync(path)) return [];
  return JSON.parse(readFileSync(path, "utf8"));
}

function saveRegistry(ownerUserId: string, workers: Worker[]): void {
  const path = registryPath(ownerUserId);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(workers, null, 2), "utf8");
}

function pickAvailableName(existingNames: Set<string>): string {
  const free = NAME_POOL.filter((n) => !existingNames.has(n));
  if (free.length > 0) return free[Math.floor(Math.random() * free.length)];
  // Pool exhausted (a lot of concurrent workers) -- still a real person-shaped
  // name, just disambiguated, rather than falling back to "Worker-N".
  let candidate: string;
  do {
    candidate = `${NAME_POOL[Math.floor(Math.random() * NAME_POOL.length)]}-${randomBytes(1).toString("hex")}`;
  } while (existingNames.has(candidate));
  return candidate;
}

export interface CreateWorkerOptions {
  name?: string; // Dave can name it explicitly; otherwise one is drawn from the pool
  assignment: WorkerAssignment;
  role?: WorkerRole; // defaults to "generic"
  task: string;
}

export function createWorker(ownerUserId: string, options: CreateWorkerOptions): Worker {
  const workers = readRegistry(ownerUserId);
  const existingNames = new Set(workers.filter((w) => w.active).map((w) => w.name));
  const name = options.name ?? pickAvailableName(existingNames);
  if (existingNames.has(name)) {
    throw new Error(`A worker named "${name}" is already active for this user -- pick a different name.`);
  }

  const worker: Worker = {
    id: randomBytes(6).toString("hex"),
    name,
    ownerUserId,
    assignment: options.assignment,
    role: options.role ?? "generic",
    task: options.task,
    createdAt: Date.now(),
    active: true,
  };
  workers.push(worker);
  saveRegistry(ownerUserId, workers);
  return worker;
}

export function listWorkers(ownerUserId: string, activeOnly = true): Worker[] {
  const workers = readRegistry(ownerUserId);
  return activeOnly ? workers.filter((w) => w.active) : workers;
}

export function getWorker(ownerUserId: string, workerId: string): Worker | undefined {
  return readRegistry(ownerUserId).find((w) => w.id === workerId);
}

/** A temporary worker's task loop closes itself out; a fixed worker stays active until explicitly retired. */
export function retireWorker(ownerUserId: string, workerId: string): void {
  const workers = readRegistry(ownerUserId);
  const worker = workers.find((w) => w.id === workerId);
  if (!worker) throw new Error(`No worker ${workerId} for ${ownerUserId}`);
  worker.active = false;
  saveRegistry(ownerUserId, workers);
}
