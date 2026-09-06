// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { makeRuntimeSqliteLayer } from "../persistence/Layers/Sqlite.ts";
import { parseOpenCodeLine, type UsageRecord } from "./usageTranscripts.ts";

export interface OpenCodeStorePaths {
  readonly dataDir: string;
  readonly databasePath: string;
  readonly legacyMessagesDir: string;
}

export function resolveOpenCodeStorePaths(
  environment: NodeJS.ProcessEnv,
  platform = NodeOS.platform(),
): OpenCodeStorePaths | null {
  const home = environment[platform === "win32" ? "USERPROFILE" : "HOME"]?.trim();
  const explicitData = environment["XDG_DATA_HOME"]?.trim();
  const localAppData = environment["LOCALAPPDATA"]?.trim();
  const dataBase =
    explicitData && explicitData.length > 0
      ? explicitData
      : platform === "darwin" && home
        ? NodePath.join(home, "Library", "Application Support")
        : platform === "win32" && localAppData
          ? localAppData
          : home
            ? NodePath.join(home, ".local", "share")
            : null;
  if (dataBase === null) return null;

  const dataDir = NodePath.resolve(dataBase, "opencode");
  const configuredDatabase = environment["OPENCODE_DB"]?.trim();
  const databasePath =
    configuredDatabase && configuredDatabase.length > 0
      ? NodePath.isAbsolute(configuredDatabase)
        ? NodePath.resolve(configuredDatabase)
        : NodePath.resolve(dataDir, configuredDatabase)
      : NodePath.join(dataDir, "opencode.db");
  return {
    dataDir,
    databasePath,
    legacyMessagesDir: NodePath.join(dataDir, "storage", "message"),
  };
}

interface OpenCodeMessageRow {
  readonly id: unknown;
  readonly session_id: unknown;
  readonly time_created: unknown;
  readonly data: unknown;
}

export function parseOpenCodeDatabaseRow(row: OpenCodeMessageRow): UsageRecord | null {
  let data: unknown;
  try {
    data = typeof row.data === "string" ? JSON.parse(row.data) : row.data;
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const message = data as Record<string, unknown>;
  return parseOpenCodeLine(
    JSON.stringify({
      ...message,
      id: typeof row.id === "string" ? row.id : message["id"],
      sessionID: typeof row.session_id === "string" ? row.session_id : message["sessionID"],
      time: {
        ...(typeof message["time"] === "object" && message["time"] !== null
          ? (message["time"] as Record<string, unknown>)
          : {}),
        created:
          typeof row.time_created === "number"
            ? row.time_created
            : (message["time"] as Record<string, unknown> | undefined)?.["created"],
      },
    }),
  );
}

export const readOpenCodeDatabaseRecords = Effect.fn("readOpenCodeDatabaseRecords")(function* (
  databasePath: string,
  sinceMs: number,
) {
  const query = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`PRAGMA busy_timeout = 1000`;
    const rows = yield* sql<OpenCodeMessageRow>`
      SELECT id, session_id, time_created, data
      FROM message
      WHERE time_created >= ${sinceMs}
      ORDER BY time_created ASC
    `;
    return rows.map(parseOpenCodeDatabaseRow).filter((record) => record !== null);
  });

  return yield* Effect.scoped(
    query.pipe(Effect.provide(makeRuntimeSqliteLayer({ filename: databasePath, readonly: true }))),
  ).pipe(Effect.timeout("5 seconds"));
});
