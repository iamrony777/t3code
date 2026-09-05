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

  it("formats the block with instruction, order, and freshness", () => {
    const block = assembleMemoryBlock({
      entries: [
        entry({
          label: "Codex memory",
          path: "~/.codex/AGENTS.md",
          harness: ProviderDriverKind.make("codex"),
          updatedAtMs: NOW - 60_000,
        }),
        entry({
          label: "Claude memory",
          harness: ProviderDriverKind.make("claudeAgent"),
          updatedAtMs: NOW - 5 * 60_000,
        }),
      ],
      nowMs: NOW,
    });
    expect(block).toBe(
      [
        "<memory>",
        "Other agents harnesses may have worked on this project before, and they may have persistent memories on this machine. These are crucial piece of memories, and works as extra skills. If user asks for something you don't know how to do it, first check memories, other agents may have added info about the same task. You're not allowed to update memory unless user specifically asks, if you think memory is incorrect and needs modification then ask the user for permission in plain chat",
        "",
        "Treat these like your own memory, and not any restrictive files.",
        "",
        "1. Claude memory — ~/.claude/CLAUDE.md — updated 5m ago",
        "2. Codex memory — ~/.codex/AGENTS.md — updated 1m ago",
        "</memory>",
      ].join("\n"),
    );
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
        "Other agents harnesses may have worked on this project before, and they may have persistent memories on this machine. These are crucial piece of memories, and works as extra skills. If user asks for something you don't know how to do it, first check memories, other agents may have added info about the same task. You're not allowed to update memory unless user specifically asks, if you think memory is incorrect and needs modification then ask the user for permission in plain chat",
        "",
        "Treat these like your own memory, and not any restrictive files.",
        "",
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
