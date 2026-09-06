// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off - SQLite fixtures store OpenCode's native JSON message payload.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { DatabaseSync } from "node:sqlite";

import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  parseOpenCodeDatabaseRow,
  readOpenCodeDatabaseRecords,
  resolveOpenCodeStorePaths,
} from "./openCodeUsage.ts";

describe("resolveOpenCodeStorePaths", () => {
  it("uses effective XDG data and resolves relative OPENCODE_DB inside OpenCode data", () => {
    assert.deepStrictEqual(
      resolveOpenCodeStorePaths({
        HOME: "/home/profile",
        XDG_DATA_HOME: "/profiles/data",
        OPENCODE_DB: "accounts/main.db",
      }),
      {
        dataDir: "/profiles/data/opencode",
        databasePath: "/profiles/data/opencode/accounts/main.db",
        legacyMessagesDir: "/profiles/data/opencode/storage/message",
      },
    );
  });

  it("uses the Linux HOME fallback and preserves an absolute OPENCODE_DB", () => {
    const paths = resolveOpenCodeStorePaths(
      { HOME: "/home/profile", OPENCODE_DB: "/var/lib/opencode/history.db" },
      "linux",
    );
    assert.strictEqual(paths?.dataDir, "/home/profile/.local/share/opencode");
    assert.strictEqual(paths?.databasePath, "/var/lib/opencode/history.db");
  });
});

describe("parseOpenCodeDatabaseRow", () => {
  it("hydrates persisted columns and retains underlying provider/model usage", () => {
    const record = parseOpenCodeDatabaseRow({
      id: "msg_db",
      session_id: "ses_db",
      time_created: 1_786_010_400_000,
      data: JSON.stringify({
        role: "assistant",
        providerID: "deepseek",
        modelID: "deepseek-chat",
        cost: 0,
        tokens: { input: 10, output: 2, reasoning: 1, cache: { read: 8, write: 3 } },
      }),
    });
    assert.strictEqual(record?.model, "deepseek/deepseek-chat");
    assert.strictEqual(record?.sessionId, "ses_db");
    assert.strictEqual(record?.reportedCostUsd, 0);
    assert.strictEqual(record?.totals.outputTokens, 2);
  });

  it("ignores malformed rows", () => {
    assert.isNull(
      parseOpenCodeDatabaseRow({ id: "bad", session_id: "ses", time_created: 0, data: "{" }),
    );
  });
});

describe("readOpenCodeDatabaseRecords", () => {
  it.live("reads current OpenCode SQLite messages without opening the store for writes", () =>
    Effect.gen(function* () {
      const dir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "opencode-usage-db-test-")),
      );
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => NodeFSP.rm(dir, { recursive: true, force: true })),
      );
      const databasePath = NodePath.join(dir, "opencode.db");
      yield* Effect.sync(() => {
        const database = new DatabaseSync(databasePath);
        database.exec(
          "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)",
        );
        database
          .prepare(
            "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
          )
          .run(
            "msg_sqlite",
            "ses_sqlite",
            1_786_010_400_000,
            1_786_010_400_000,
            JSON.stringify({
              role: "assistant",
              providerID: "openrouter",
              modelID: "deepseek/deepseek-chat",
              cost: 0.03,
              tokens: { input: 10, output: 4, reasoning: 2, cache: { read: 3, write: 1 } },
            }),
          );
        database.close();
      });

      const records = yield* readOpenCodeDatabaseRecords(databasePath, 0);
      assert.strictEqual(records.length, 1);
      assert.strictEqual(records[0]?.model, "openrouter/deepseek/deepseek-chat");
      assert.strictEqual(records[0]?.totals.outputTokens, 4);
    }).pipe(Effect.scoped),
  );
});
