import { describe, expect, it } from "@effect/vitest";
import { ProviderDriverKind } from "@t3tools/contracts";

import {
  assembleMemoryBlock,
  formatUpdatedAgo,
  MEMORY_MANIFEST_MAX_ENTRIES,
  MEMORY_MANIFEST_MAX_LABEL_CHARS,
  MEMORY_MANIFEST_MAX_PATH_CHARS,
  selectMemoryEntries,
  withMemoryContext,
  type ResolvedMemoryEntry,
} from "./memoryManifest.ts";

const NOW = Date.parse("2026-09-04T12:00:00Z");

const entry = (overrides: Partial<ResolvedMemoryEntry>): ResolvedMemoryEntry => ({
  label: "Claude memory",
  path: "~/.claude/CLAUDE.md",
  harness: ProviderDriverKind.make("claudeAgent"),
  updatedAtMs: NOW - 5 * 60_000,
  ...overrides,
});

describe("formatUpdatedAgo", () => {
  it("renders minutes, hours, and days", () => {
    expect(formatUpdatedAgo(NOW, NOW)).toBe("just now");
    expect(formatUpdatedAgo(NOW - 5 * 60_000, NOW)).toBe("5m ago");
    expect(formatUpdatedAgo(NOW - 2 * 3_600_000, NOW)).toBe("2h ago");
    expect(formatUpdatedAgo(NOW - 3 * 24 * 3_600_000, NOW)).toBe("3d ago");
  });

  it("returns null for an unavailable file", () => {
    expect(formatUpdatedAgo(null, NOW)).toBeNull();
  });
});

describe("selectMemoryEntries", () => {
  it("sorts by harness then recency desc", () => {
    const selected = selectMemoryEntries([
      entry({
        label: "Newer codex",
        harness: ProviderDriverKind.make("codex"),
        updatedAtMs: NOW,
      }),
      entry({
        label: "Claude memory",
        harness: ProviderDriverKind.make("claudeAgent"),
        updatedAtMs: NOW - 2 * 60_000,
      }),
      entry({
        label: "Older codex",
        harness: ProviderDriverKind.make("codex"),
        updatedAtMs: NOW - 60_000,
      }),
    ]);
    expect(selected.map(({ label }) => label)).toEqual([
      "Claude memory",
      "Newer codex",
      "Older codex",
    ]);
  });

  it("caps at MEMORY_MANIFEST_MAX_ENTRIES", () => {
    const many = Array.from({ length: MEMORY_MANIFEST_MAX_ENTRIES + 3 }, (_, index) =>
      entry({
        label: `Source ${index}`,
        harness: undefined,
        updatedAtMs: NOW - index * 60_000,
      }),
    );
    expect(selectMemoryEntries(many)).toHaveLength(MEMORY_MANIFEST_MAX_ENTRIES);
  });
});

describe("assembleMemoryBlock", () => {
  it("returns null when no entries survive", () => {
    expect(assembleMemoryBlock({ entries: [], nowMs: NOW })).toBeNull();
  });

  it("formats the block with ownership, guidance, and freshness, hinting the Claude layout when a claudeAgent entry is present", () => {
    const block = assembleMemoryBlock({
      entries: [entry({ updatedAtMs: NOW - 5 * 60_000 })],
      nowMs: NOW,
    });
    expect(block).toBe(
      [
        "<memory>",
        "T3 Code is a harness-for-harnesses. The folders below are persistent project memory recorded by the other harnesses that share this project checkout with you. Treat what is in them as your own project memory — use it to stay consistent with prior work, before you re-derive decisions someone else already made.",
        "Consult these folders before acting when the task references anything in them, needs prior context, or is ambiguous and earlier work may inform it. Skip them for self-contained queries. \u201cUpdated Xd ago\u201d is the last change time; when a fact may be stale (infra, commands, timings), verify it or flag that it may be outdated. Do not edit these files unless the user explicitly asks \u2014 if one looks wrong, say so and ask in chat.",
        "Reading hints (per harness):",
        "- Claude Code memory: a per-project folder under the harness config dir. The folder name encodes the project path with every non-alphanumeric replaced by \u201c-\u201d. Each memory is one topic.md; read the MEMORY.md index first, then open only the relevant topics.",
        "1. Claude memory — ~/.claude/CLAUDE.md — updated 5m ago",
        "</memory>",
      ].join("\n"),
    );
  });

  it("emits the Claude navigation hint once even with multiple claudeAgent entries", () => {
    const block = assembleMemoryBlock({
      entries: [
        entry({ label: "Claude Work", path: "/p1", updatedAtMs: NOW - 60_000 }),
        entry({ label: "Claude LiteLLM", path: "/p2", updatedAtMs: NOW - 2 * 60_000 }),
      ],
      nowMs: NOW,
    });
    const hintCount = (block ?? "").match(/- Claude Code memory:/g)?.length ?? 0;
    expect(hintCount).toBe(1);
  });

  it("omits the Claude navigation hint when no claudeAgent entry is present", () => {
    const block = assembleMemoryBlock({
      entries: [
        entry({
          label: "Codex memory",
          path: "~/.codex/AGENTS.md",
          harness: ProviderDriverKind.make("codex"),
          updatedAtMs: NOW - 60_000,
        }),
      ],
      nowMs: NOW,
    });
    expect(block).not.toContain("Reading hints (per harness):");
    expect(block).not.toContain("Claude Code memory:");
  });

  it("sorts by harness then recency", () => {
    const block = assembleMemoryBlock({
      entries: [
        entry({
          label: "Newer codex",
          path: "c.md",
          harness: ProviderDriverKind.make("codex"),
          updatedAtMs: NOW,
        }),
        entry({
          label: "Older codex",
          path: "c-old.md",
          harness: ProviderDriverKind.make("codex"),
          updatedAtMs: NOW - 60_000,
        }),
      ],
      nowMs: NOW,
    });
    expect(block?.indexOf("1. Newer codex")).toBeGreaterThan(0);
    expect(block?.indexOf("2. Older codex")).toBeGreaterThan(0);
  });

  it("caps the list and truncates long labels", () => {
    const many = Array.from({ length: MEMORY_MANIFEST_MAX_ENTRIES + 2 }, (_, index) =>
      entry({
        label: `Source ${"x".repeat(100)} ${index}`,
        path: `/sources/${index}.md`,
        harness: undefined,
        updatedAtMs: NOW - index * 60_000,
      }),
    );
    const block = assembleMemoryBlock({ entries: many, nowMs: NOW });
    const lines = block?.split("\n") ?? [];
    const listLines = lines.filter((line) => /^\d+\. /.test(line));
    expect(listLines).toHaveLength(MEMORY_MANIFEST_MAX_ENTRIES);
    const truncatedLabel =
      `Source ${"x".repeat(100)} 0`.slice(0, MEMORY_MANIFEST_MAX_LABEL_CHARS - 1) + "…";
    expect(listLines[0]).toBe(`1. ${truncatedLabel} — /sources/0.md — updated just now`);
  });

  it("truncates long paths", () => {
    const truncatedPath = "p".repeat(MEMORY_MANIFEST_MAX_PATH_CHARS - 1) + "…";
    const block = assembleMemoryBlock({
      entries: [entry({ path: "p".repeat(300) })],
      nowMs: NOW,
    });
    expect(block).toBe(
      [
        "<memory>",
        "T3 Code is a harness-for-harnesses. The folders below are persistent project memory recorded by the other harnesses that share this project checkout with you. Treat what is in them as your own project memory — use it to stay consistent with prior work, before you re-derive decisions someone else already made.",
        "Consult these folders before acting when the task references anything in them, needs prior context, or is ambiguous and earlier work may inform it. Skip them for self-contained queries. \u201cUpdated Xd ago\u201d is the last change time; when a fact may be stale (infra, commands, timings), verify it or flag that it may be outdated. Do not edit these files unless the user explicitly asks \u2014 if one looks wrong, say so and ask in chat.",
        "Reading hints (per harness):",
        "- Claude Code memory: a per-project folder under the harness config dir. The folder name encodes the project path with every non-alphanumeric replaced by \u201c-\u201d. Each memory is one topic.md; read the MEMORY.md index first, then open only the relevant topics.",
        `1. Claude memory — ${truncatedPath} — updated 5m ago`,
        "</memory>",
      ].join("\n"),
    );
  });

  it("sorts null-mtime entries last without a freshness suffix", () => {
    const block = assembleMemoryBlock({
      entries: [
        entry({
          label: "Unavailable",
          path: "unavailable.md",
          harness: undefined,
          updatedAtMs: null,
        }),
        entry({
          label: "Dated",
          path: "dated.md",
          harness: undefined,
          updatedAtMs: NOW - 60_000,
        }),
      ],
      nowMs: NOW,
    });
    const lines = block?.split("\n") ?? [];
    const listLines = lines.filter((line) => /^\d+\. /.test(line));
    expect(listLines[0]).toBe("1. Dated — dated.md — updated 1m ago");
    expect(listLines[1]).toBe("2. Unavailable — unavailable.md");
    expect(listLines[1]).not.toContain("updated");
  });
});

describe("withMemoryContext", () => {
  it("prepends the block with a blank line separator", () => {
    expect(withMemoryContext("fix the build", "<memory>x</memory>")).toBe(
      "<memory>x</memory>\n\nfix the build",
    );
  });

  it("returns the text unchanged without a block", () => {
    expect(withMemoryContext("fix the build", undefined)).toBe("fix the build");
  });
});
