// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest";

import { listTranscriptFiles } from "./usageTranscriptReader.ts";

const SESSION_ID = "b8856a1f-b60d-402a-8a80-265911205206";

let root: string;

beforeAll(async () => {
  root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "usage-transcripts-"));
  const project = NodePath.join(root, "home-user-project");
  await NodeFSP.mkdir(project, { recursive: true });
  // The three files a real Command Code project directory holds side by side.
  await NodeFSP.writeFile(NodePath.join(project, `${SESSION_ID}.jsonl`), "{}\n");
  await NodeFSP.writeFile(NodePath.join(project, `${SESSION_ID}.checkpoints.jsonl`), "{}\n");
  await NodeFSP.writeFile(NodePath.join(project, `${SESSION_ID}.meta.json`), "{}\n");
});

afterAll(async () => {
  await NodeFSP.rm(root, { recursive: true, force: true });
});

const names = (files: readonly { readonly path: string }[]) =>
  files.map((file) => NodePath.basename(file.path)).sort();

describe("listTranscriptFiles", () => {
  it("skips Command Code checkpoint files", async () => {
    // The reader takes the session id from the file name, so a checkpoints file
    // would register as a `<uuid>.checkpoints` session of its own.
    expect(names(await listTranscriptFiles(root, 0, "commandcode"))).toEqual([
      `${SESSION_ID}.jsonl`,
    ]);
  });

  it("leaves other providers' listings alone", async () => {
    expect(names(await listTranscriptFiles(root, 0, "claude"))).toEqual([
      `${SESSION_ID}.checkpoints.jsonl`,
      `${SESSION_ID}.jsonl`,
    ]);
  });
});
