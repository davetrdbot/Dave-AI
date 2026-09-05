import { DaveDatabase, type ColumnDef, type AggregateFn } from "./database.js";

/**
 * Update 18 (bulk tool-coverage expansion): `DaveDatabase` (Step 16.1)
 * had real dynamic-DDL capability but no agent-tool surface -- Dave
 * could not create/read/write its own tables through a real tool call.
 */
export interface DbToolContext {
  userId: string;
  db: DaveDatabase;
}

export interface DbToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>, ctx: DbToolContext) => Promise<unknown>;
}

export const DB_TOOLS: DbToolDefinition[] = [
  {
    name: "db_create_table",
    description: "Create a new table you own (real dynamic DDL) -- id/owner/created_at/updated_at are always auto-managed.",
    parameters: {
      type: "object",
      properties: { table: { type: "string" }, columns: { type: "array", items: { type: "object", properties: { name: { type: "string" }, type: { type: "string", enum: ["TEXT", "INTEGER", "REAL", "BLOB"] } } } } },
      required: ["table", "columns"],
    },
    execute: async (args, ctx) => {
      ctx.db.createTable(args.table as string, args.columns as ColumnDef[]);
      return { ok: true };
    },
  },
  {
    name: "db_list_tables",
    description: "List every real table that exists in your database.",
    parameters: { type: "object", properties: {} },
    execute: async (_args, ctx) => ctx.db.listTables(),
  },
  {
    name: "db_create_records",
    description: "Insert a real row into one of your own tables.",
    parameters: { type: "object", properties: { table: { type: "string" }, data: { type: "object" } }, required: ["table", "data"] },
    execute: async (args, ctx) => ({ id: ctx.db.insert(args.table as string, ctx.userId, args.data as Record<string, unknown>) }),
  },
  {
    name: "db_read_records",
    description: "Query rows from one of your own tables by equality filters (empty filter returns everything you own in that table).",
    parameters: { type: "object", properties: { table: { type: "string" }, where: { type: "object" } }, required: ["table"] },
    execute: async (args, ctx) => ctx.db.query(args.table as string, ctx.userId, (args.where as Record<string, unknown>) ?? {}),
  },
  {
    name: "db_update_records",
    description: "Update one real row you own by id.",
    parameters: { type: "object", properties: { table: { type: "string" }, id: { type: "string" }, data: { type: "object" } }, required: ["table", "id", "data"] },
    execute: async (args, ctx) => ({ updated: ctx.db.update(args.table as string, ctx.userId, args.id as string, args.data as Record<string, unknown>) }),
  },
  {
    name: "db_delete_records",
    description: "Delete one real row you own by id.",
    parameters: { type: "object", properties: { table: { type: "string" }, id: { type: "string" } }, required: ["table", "id"] },
    execute: async (args, ctx) => ({ deleted: ctx.db.deleteRow(args.table as string, ctx.userId, args.id as string) }),
  },
  {
    name: "db_aggregate",
    description: "Run a real SQL aggregate (SUM/COUNT/AVG/MIN/MAX) over one of your own tables.",
    parameters: {
      type: "object",
      properties: { table: { type: "string" }, fn: { type: "string", enum: ["SUM", "COUNT", "AVG", "MIN", "MAX"] }, column: { type: "string" }, where: { type: "object" } },
      required: ["table", "fn"],
    },
    execute: async (args, ctx) => ({ result: ctx.db.aggregate(args.table as string, ctx.userId, args.fn as AggregateFn, args.column as string | undefined, (args.where as Record<string, unknown>) ?? {}) }),
  },
];
