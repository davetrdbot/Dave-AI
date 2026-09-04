import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { EventEmitter } from "node:events";

/**
 * Step 16.1: full database capability. Dave creates its OWN tables at
 * runtime (not limited to a fixed pre-built schema) -- real SQLite via
 * better-sqlite3, chosen after research confirmed: v13+ ships prebuilt
 * N-API binaries for linux-x64 with NO install/postinstall script at
 * all (pnpm's "Ignored build scripts" warning is a false alarm here --
 * verified it actually loads and runs with zero build-approval needed),
 * synchronous by design (a real durability property, not a limitation:
 * a completed `.run()` has already gone through SQLite's normal
 * write/journal protocol before returning), and real transactions.
 *
 * Every record auto-gets id/created_at/updated_at (16.1). Row-level
 * security is real enforcement in this layer, not a documented
 * convention: every table gets an `owner_user_id` column, and every
 * read/write here requires an ownerUserId and ANDs it into the query --
 * there is no code path in this module that can read another user's
 * row, so this doesn't need retrofitting the day Dave is shared with a
 * second user.
 */

export type ColumnType = "TEXT" | "INTEGER" | "REAL" | "BLOB";

export interface ColumnDef {
  name: string;
  type: ColumnType;
}

export type AggregateFn = "SUM" | "COUNT" | "AVG" | "MIN" | "MAX";

export interface EntityEvent {
  table: string;
  op: "created" | "updated" | "deleted";
  id: string;
  ownerUserId: string;
  row?: Record<string, unknown>;
}

const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

function assertValidIdentifier(name: string, kind: string): string {
  if (!IDENTIFIER_PATTERN.test(name)) {
    throw new Error(`invalid ${kind} name "${name}" -- must match ${IDENTIFIER_PATTERN}`);
  }
  return name;
}

function quote(identifier: string): string {
  return `"${identifier}"`;
}

const RESERVED_COLUMNS = new Set(["id", "owner_user_id", "created_at", "updated_at"]);

export class DaveDatabase {
  private readonly db: Database.Database;
  private readonly events = new EventEmitter();
  private readonly knownTables = new Set<string>();

  constructor(path: string) {
    if (path !== ":memory:") {
      const dir = dirname(path);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
  }

  close(): void {
    this.db.close();
  }

  /** Real dynamic DDL -- Dave is not limited to a fixed set of pre-built tables. */
  createTable(table: string, columns: ColumnDef[]): void {
    assertValidIdentifier(table, "table");
    for (const col of columns) {
      assertValidIdentifier(col.name, "column");
      if (RESERVED_COLUMNS.has(col.name)) {
        throw new Error(`column name "${col.name}" is reserved (auto-managed by this layer)`);
      }
    }
    const extraCols = columns.map((c) => `${quote(c.name)} ${c.type}`).join(", ");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${quote(table)} (
        id TEXT PRIMARY KEY,
        owner_user_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL${extraCols ? `, ${extraCols}` : ""}
      )
    `);
    this.knownTables.add(table);
  }

  listTables(): string[] {
    const rows = this.db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`).all() as { name: string }[];
    return rows.map((r) => r.name);
  }

  /** Real insert -- id/created_at/updated_at are always auto-assigned, never caller-supplied. */
  insert(table: string, ownerUserId: string, data: Record<string, unknown>): string {
    assertValidIdentifier(table, "table");
    const id = randomBytes(12).toString("hex");
    const now = Date.now();
    const keys = Object.keys(data).map((k) => assertValidIdentifier(k, "column"));
    const columns = ["id", "owner_user_id", "created_at", "updated_at", ...keys];
    const placeholders = columns.map(() => "?").join(", ");
    const stmt = this.db.prepare(`INSERT INTO ${quote(table)} (${columns.map(quote).join(", ")}) VALUES (${placeholders})`);
    stmt.run(id, ownerUserId, now, now, ...keys.map((k) => data[k]));

    const row = { id, owner_user_id: ownerUserId, created_at: now, updated_at: now, ...data };
    this.events.emit("entity", { table, op: "created", id, ownerUserId, row } satisfies EntityEvent);
    return id;
  }

  /** Row-level security enforced here: the WHERE clause always includes owner_user_id, no bypass path. */
  update(table: string, ownerUserId: string, id: string, data: Record<string, unknown>): boolean {
    assertValidIdentifier(table, "table");
    const keys = Object.keys(data).map((k) => assertValidIdentifier(k, "column"));
    if (keys.length === 0) return false;
    const now = Date.now();
    const setClause = [...keys.map((k) => `${quote(k)} = ?`), `updated_at = ?`].join(", ");
    const stmt = this.db.prepare(`UPDATE ${quote(table)} SET ${setClause} WHERE id = ? AND owner_user_id = ?`);
    const result = stmt.run(...keys.map((k) => data[k]), now, id, ownerUserId);
    if (result.changes > 0) {
      const row = this.getById(table, ownerUserId, id);
      this.events.emit("entity", { table, op: "updated", id, ownerUserId, row } satisfies EntityEvent);
    }
    return result.changes > 0;
  }

  deleteRow(table: string, ownerUserId: string, id: string): boolean {
    assertValidIdentifier(table, "table");
    const stmt = this.db.prepare(`DELETE FROM ${quote(table)} WHERE id = ? AND owner_user_id = ?`);
    const result = stmt.run(id, ownerUserId);
    if (result.changes > 0) {
      this.events.emit("entity", { table, op: "deleted", id, ownerUserId } satisfies EntityEvent);
    }
    return result.changes > 0;
  }

  getById(table: string, ownerUserId: string, id: string): Record<string, unknown> | undefined {
    assertValidIdentifier(table, "table");
    return this.db.prepare(`SELECT * FROM ${quote(table)} WHERE id = ? AND owner_user_id = ?`).get(id, ownerUserId) as Record<string, unknown> | undefined;
  }

  /** Real filter -- equality-only WHERE clause built from parameterized values, never string-interpolated data. */
  query(table: string, ownerUserId: string, where: Record<string, unknown> = {}): Record<string, unknown>[] {
    assertValidIdentifier(table, "table");
    const keys = Object.keys(where).map((k) => assertValidIdentifier(k, "column"));
    const clauses = ["owner_user_id = ?", ...keys.map((k) => `${quote(k)} = ?`)];
    const stmt = this.db.prepare(`SELECT * FROM ${quote(table)} WHERE ${clauses.join(" AND ")}`);
    return stmt.all(ownerUserId, ...keys.map((k) => where[k])) as Record<string, unknown>[];
  }

  /** Real SQL aggregate -- SUM/COUNT/AVG/MIN/MAX, always scoped to the caller's own rows. */
  aggregate(table: string, ownerUserId: string, fn: AggregateFn, column?: string, where: Record<string, unknown> = {}): number {
    assertValidIdentifier(table, "table");
    const target = fn === "COUNT" ? "*" : quote(assertValidIdentifier(column ?? "", "column"));
    const keys = Object.keys(where).map((k) => assertValidIdentifier(k, "column"));
    const clauses = ["owner_user_id = ?", ...keys.map((k) => `${quote(k)} = ?`)];
    const stmt = this.db.prepare(`SELECT ${fn}(${target}) as result FROM ${quote(table)} WHERE ${clauses.join(" AND ")}`);
    const row = stmt.get(ownerUserId, ...keys.map((k) => where[k])) as { result: number | null };
    return row.result ?? 0;
  }

  /** Atomic multi-statement operations -- real better-sqlite3 transaction wrapping, BEGIN/COMMIT with automatic ROLLBACK on throw. */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  /** Step 16.2(b): entity triggers -- fires synchronously the instant a row is created/updated/deleted, real event data, no polling. */
  onEntityEvent(handler: (event: EntityEvent) => void | Promise<void>): () => void {
    this.events.on("entity", handler);
    return () => this.events.off("entity", handler);
  }
}
