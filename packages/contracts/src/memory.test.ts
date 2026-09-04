import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  DetectedMemoryFolder,
  DetectedMemoryFolders,
  DetectedMemoryFoldersInput,
} from "./memory.ts";

const decodeInput = Schema.decodeUnknownSync(DetectedMemoryFoldersInput);
const decodeFolder = Schema.decodeUnknownSync(DetectedMemoryFolder);
const decodeFolders = Schema.decodeUnknownSync(DetectedMemoryFolders);

describe("DetectedMemoryFoldersInput", () => {
  it("decodes a project root, trimming surrounding whitespace", () => {
    expect(decodeInput({ projectRoot: "  /work/t3  " }).projectRoot).toBe("/work/t3");
  });

  it("rejects empty or whitespace-only project roots", () => {
    expect(() => decodeInput({ projectRoot: "" })).toThrow();
    expect(() => decodeInput({ projectRoot: "   " })).toThrow();
  });
});

describe("DetectedMemoryFolder", () => {
  it("decodes a detected folder with path and label", () => {
    expect(decodeFolder({ path: "/home/u/.claude/projects/t3", label: ".claude" })).toEqual({
      path: "/home/u/.claude/projects/t3",
      label: ".claude",
    });
  });

  it("rejects a folder missing its label or with an empty path", () => {
    expect(() => decodeFolder({ path: "/x/projects/t3" })).toThrow();
    expect(() => decodeFolder({ path: "", label: ".claude" })).toThrow();
    expect(() => decodeFolder({ path: "  ", label: ".claude" })).toThrow();
  });
});

describe("DetectedMemoryFolders", () => {
  it("decodes an array of detected folders", () => {
    const folders = decodeFolders([
      { path: "/home/u/.claude/projects/t3", label: ".claude" },
      { path: "/home/u/.claude-personal/projects/t3", label: "personal" },
    ]);
    expect(folders).toEqual([
      { path: "/home/u/.claude/projects/t3", label: ".claude" },
      { path: "/home/u/.claude-personal/projects/t3", label: "personal" },
    ]);
  });

  it("rejects an array entry that is not a detected folder", () => {
    expect(() => decodeFolders([{ path: "/x/projects/t3", label: "" }])).toThrow();
    expect(() => decodeFolders("not-an-array")).toThrow();
  });
});
