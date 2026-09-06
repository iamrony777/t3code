// @effect-diagnostics nodeBuiltinImport:off - resume coverage writes, appends
// to, and truncates real transcript files byte-exactly, mirroring the reader's
// own deliberate node:fs usage.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, assert, beforeEach, describe, it } from "@effect/vitest";

import {
  formatDirectoryVolumeId,
  listTranscriptFiles,
  readTranscriptRecords,
} from "./usageTranscriptReader.ts";

let dir: string;

beforeEach(async () => {
  dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "usage-reader-test-"));
});

afterEach(async () => {
  await NodeFSP.rm(dir, { recursive: true, force: true });
});

function claudeLine(id: number, outputTokens: number): string {
  return `${JSON.stringify({
    type: "assistant",
    timestamp: "2026-08-01T10:00:00Z",
    requestId: `req_${id}`,
    sessionId: "session-1",
    message: {
      id: `msg_${id}`,
      model: "claude-fable-5",
      usage: { input_tokens: 10, output_tokens: outputTokens },
    },
  })}\n`;
}

function codexMetaLine(): string {
  return `${JSON.stringify({
    type: "session_meta",
    timestamp: "2026-08-01T10:00:00Z",
    payload: { type: "session_meta", id: "codex-session-1" },
  })}\n`;
}

function codexModelLine(model: string): string {
  return `${JSON.stringify({
    type: "turn_context",
    timestamp: "2026-08-01T10:00:01Z",
    payload: { type: "turn_context", model },
  })}\n`;
}

function codexUsageLine(outputTokens: number, secondsOffset: number): string {
  return `${JSON.stringify({
    type: "event_msg",
    timestamp: `2026-08-01T10:00:${String(secondsOffset).padStart(2, "0")}Z`,
    payload: {
      type: "token_count",
      info: { last_token_usage: { input_tokens: 100, output_tokens: outputTokens } },
    },
  })}\n`;
}

describe("formatDirectoryVolumeId", () => {
  it("rejects a zero inode so callers fall back to the canonical path", () => {
    assert.strictEqual(formatDirectoryVolumeId({ dev: 0, ino: 0 }), "");
    assert.strictEqual(formatDirectoryVolumeId({ dev: 12, ino: -1 }), "");
    assert.strictEqual(formatDirectoryVolumeId({ dev: 12, ino: Number.MAX_SAFE_INTEGER + 1 }), "");
    assert.strictEqual(formatDirectoryVolumeId({ dev: 12, ino: 34 }), "12:34");
  });
});

describe("readTranscriptRecords resume", () => {
  it("parses one pretty-printed OpenCode message file", async () => {
    const path = NodePath.join(dir, "msg_123.json");
    await NodeFSP.writeFile(
      path,
      JSON.stringify(
        {
          id: "msg_123",
          sessionID: "ses_456",
          role: "assistant",
          time: { created: 1_786_010_400_000 },
          providerID: "openrouter",
          modelID: "deepseek/deepseek-v4",
          cost: 0.1,
          tokens: { input: 10, output: 2, reasoning: 1, cache: { read: 8, write: 0 } },
        },
        null,
        2,
      ),
    );

    const parsed = await readTranscriptRecords(path, "opencode");
    assert.isNotNull(parsed);
    assert.strictEqual(parsed.records.length, 1);
    assert.strictEqual(parsed.records[0]?.model, "openrouter/deepseek/deepseek-v4");
    assert.strictEqual(parsed.tailRecords.length, 0);
    assert.isFalse(parsed.resumed);
  });

  it("parses only appended lines when resuming a grown file", async () => {
    const path = NodePath.join(dir, "claude.jsonl");
    await NodeFSP.writeFile(path, claudeLine(1, 5) + claudeLine(2, 7));
    const first = await readTranscriptRecords(path, "claude");
    assert.isNotNull(first);
    assert.strictEqual(first.records.length, 2);
    assert.isFalse(first.resumed);

    await NodeFSP.appendFile(path, claudeLine(3, 11));
    const second = await readTranscriptRecords(path, "claude", first.position);
    assert.isNotNull(second);
    assert.isTrue(second.resumed);
    assert.strictEqual(second.records.length, 1);
    assert.strictEqual(second.records[0]?.totals.outputTokens, 11);

    // The stitched result matches a from-scratch parse of the whole file.
    const full = await readTranscriptRecords(path, "claude");
    assert.isNotNull(full);
    assert.deepStrictEqual([...first.records, ...second.records], [...full.records]);
  });

  it("carries the Codex reducer state across the resume boundary", async () => {
    const path = NodePath.join(dir, "rollout.jsonl");
    await NodeFSP.writeFile(path, codexMetaLine() + codexModelLine("gpt-5.2-codex"));
    const first = await readTranscriptRecords(path, "codex");
    assert.isNotNull(first);
    assert.strictEqual(first.records.length, 0);

    // The appended usage event has no turn_context or session_meta of its own;
    // model and session must come from the state captured before the boundary.
    await NodeFSP.appendFile(path, codexUsageLine(9, 5));
    const second = await readTranscriptRecords(path, "codex", first.position);
    assert.isNotNull(second);
    assert.isTrue(second.resumed);
    assert.strictEqual(second.records.length, 1);
    assert.strictEqual(second.records[0]?.model, "gpt-5.2-codex");
    assert.strictEqual(second.records[0]?.sessionId, "codex-session-1");
  });

  it("suppresses a Codex duplicate usage event that straddles the boundary", async () => {
    const path = NodePath.join(dir, "rollout.jsonl");
    await NodeFSP.writeFile(
      path,
      codexMetaLine() + codexModelLine("gpt-5.2-codex") + codexUsageLine(9, 5),
    );
    const first = await readTranscriptRecords(path, "codex");
    assert.isNotNull(first);
    assert.strictEqual(first.records.length, 1);

    // Codex re-emits an unchanged token_count on stream boundaries; the copy
    // lands after the resume point and must still be dropped.
    await NodeFSP.appendFile(path, codexUsageLine(9, 5) + codexUsageLine(21, 8));
    const second = await readTranscriptRecords(path, "codex", first.position);
    assert.isNotNull(second);
    assert.isTrue(second.resumed);
    assert.deepStrictEqual(
      second.records.map((record) => record.totals.outputTokens),
      [21],
    );
  });

  it("defers an unterminated trailing line to tailRecords, then consumes it once terminated", async () => {
    const path = NodePath.join(dir, "claude.jsonl");
    const unterminated = claudeLine(2, 7).trimEnd();
    await NodeFSP.writeFile(path, claudeLine(1, 5) + unterminated);
    const first = await readTranscriptRecords(path, "claude");
    assert.isNotNull(first);
    assert.strictEqual(first.records.length, 1);
    assert.strictEqual(first.tailRecords.length, 1);
    assert.strictEqual(first.tailRecords[0]?.totals.outputTokens, 7);

    // Completing the line and appending another re-reads from the resume
    // point, so the once-tail record arrives exactly once as a line record.
    await NodeFSP.appendFile(path, `\n${claudeLine(3, 11)}`);
    const second = await readTranscriptRecords(path, "claude", first.position);
    assert.isNotNull(second);
    assert.isTrue(second.resumed);
    assert.deepStrictEqual(
      second.records.map((record) => record.totals.outputTokens),
      [7, 11],
    );
    assert.strictEqual(second.tailRecords.length, 0);
  });

  it("re-parses from the start when the guard bytes no longer match", async () => {
    const path = NodePath.join(dir, "claude.jsonl");
    await NodeFSP.writeFile(path, claudeLine(1, 5));
    const first = await readTranscriptRecords(path, "claude");
    assert.isNotNull(first);

    // Same path, larger size, different content: a replaced file, not growth.
    await NodeFSP.writeFile(path, claudeLine(4, 13) + claudeLine(5, 17));
    const second = await readTranscriptRecords(path, "claude", first.position);
    assert.isNotNull(second);
    assert.isFalse(second.resumed);
    assert.deepStrictEqual(
      second.records.map((record) => record.totals.outputTokens),
      [13, 17],
    );
  });

  it("re-parses from the start when the file shrank below the resume point", async () => {
    const path = NodePath.join(dir, "claude.jsonl");
    await NodeFSP.writeFile(path, claudeLine(1, 5) + claudeLine(2, 7));
    const first = await readTranscriptRecords(path, "claude");
    assert.isNotNull(first);

    await NodeFSP.writeFile(path, claudeLine(3, 11));
    const second = await readTranscriptRecords(path, "claude", first.position);
    assert.isNotNull(second);
    assert.isFalse(second.resumed);
    assert.deepStrictEqual(
      second.records.map((record) => record.totals.outputTokens),
      [11],
    );
  });

  it("parses a line larger than one stream chunk", async () => {
    // Tool-heavy transcripts carry multi-megabyte single lines; they arrive
    // split across many chunks and must reassemble into one record.
    const path = NodePath.join(dir, "claude.jsonl");
    const bigLine = `${JSON.stringify({
      type: "assistant",
      timestamp: "2026-08-01T10:00:00Z",
      requestId: "req_big",
      sessionId: "session-1",
      padding: "x".repeat(512 * 1024),
      message: {
        id: "msg_big",
        model: "claude-fable-5",
        usage: { input_tokens: 10, output_tokens: 42 },
      },
    })}\n`;
    await NodeFSP.writeFile(path, bigLine + claudeLine(2, 7));

    const parsed = await readTranscriptRecords(path, "claude");
    assert.isNotNull(parsed);
    assert.deepStrictEqual(
      parsed.records.map((record) => record.totals.outputTokens),
      [42, 7],
    );
  });

  it("returns null for an unreadable file", async () => {
    assert.isNull(await readTranscriptRecords(NodePath.join(dir, "missing.jsonl"), "claude"));
  });
});

describe("listTranscriptFiles", () => {
  const sessionId = "b8856a1f-b60d-402a-8a80-265911205206";
  const names = (files: readonly { readonly path: string }[]) =>
    files.map((file) => NodePath.basename(file.path)).sort();

  beforeEach(async () => {
    const project = NodePath.join(dir, "home-user-project");
    await NodeFSP.mkdir(project, { recursive: true });
    // The three files a real Command Code project directory holds side by side.
    await NodeFSP.writeFile(NodePath.join(project, `${sessionId}.jsonl`), "{}\n");
    await NodeFSP.writeFile(NodePath.join(project, `${sessionId}.checkpoints.jsonl`), "{}\n");
    await NodeFSP.writeFile(NodePath.join(project, `${sessionId}.meta.json`), "{}\n");
  });

  it("skips Command Code checkpoint files", async () => {
    // The reader takes the session id from the file name, so a checkpoints file
    // would register as a `<uuid>.checkpoints` session of its own.
    assert.deepStrictEqual(names(await listTranscriptFiles(dir, 0, "commandcode")), [
      `${sessionId}.jsonl`,
    ]);
  });

  it("leaves other providers' listings alone", async () => {
    assert.deepStrictEqual(names(await listTranscriptFiles(dir, 0, "claude")), [
      `${sessionId}.checkpoints.jsonl`,
      `${sessionId}.jsonl`,
    ]);
  });

  it("lists JSON files for OpenCode", async () => {
    assert.deepStrictEqual(names(await listTranscriptFiles(dir, 0, "opencode")), [
      `${sessionId}.meta.json`,
    ]);
  });
});
