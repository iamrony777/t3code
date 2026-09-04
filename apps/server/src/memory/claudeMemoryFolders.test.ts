import { describe, expect, it } from "@effect/vitest";

import {
  claudeConfigDirLabel,
  claudeMemoryFolderPath,
  encodeClaudeProjectFolder,
} from "./claudeMemoryFolders.ts";

describe("encodeClaudeProjectFolder", () => {
  it("matches Claude Code's per-project auto-memory folder encoding", () => {
    expect(encodeClaudeProjectFolder("/home/rony/Work/javinfo/core")).toBe(
      "-home-rony-Work-javinfo-core",
    );
    expect(encodeClaudeProjectFolder("/home/rony/.claude-mem/observer-sessions")).toBe(
      "-home-rony--claude-mem-observer-sessions",
    );
    expect(encodeClaudeProjectFolder("/home/rony/Work/iamrony777.github.io")).toBe(
      "-home-rony-Work-iamrony777-github-io",
    );
  });

  it("handles Windows drive-letter paths and separators", () => {
    expect(encodeClaudeProjectFolder("C:\\Users\\you\\my-app")).toBe("C--Users-you-my-app");
  });
});

describe("claudeMemoryFolderPath", () => {
  it("joins the config dir with projects, the encoded root, and memory", () => {
    expect(
      claudeMemoryFolderPath(
        "/home/rony/.local/share/claude-profiles/work_seo1",
        "/home/rony/Work/javinfo/core",
      ),
    ).toBe(
      "/home/rony/.local/share/claude-profiles/work_seo1/projects/-home-rony-Work-javinfo-core/memory",
    );
  });
});

describe("claudeConfigDirLabel", () => {
  it("uses the basename with leading dots stripped", () => {
    expect(claudeConfigDirLabel("/home/rony/.claude")).toBe("claude");
    expect(claudeConfigDirLabel("/home/rony/.local/share/claude-profiles/work_seo1")).toBe(
      "work_seo1",
    );
  });

  it("falls back to claude when the basename leaves nothing usable", () => {
    expect(claudeConfigDirLabel("/")).toBe("claude");
  });
});
