import { describe, expect, it } from "@effect/vitest";
import { ProviderDriverKind } from "@t3tools/contracts";

import {
  assembleMemoryBlock,
  formatUpdatedAgo,
  MEMORY_MANIFEST_MAX_ENTRIES,
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
        "Other agent harnesses keep persistent memory files on this machine. Read any that are relevant before acting. Do not modify files owned by other harnesses.",
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
    expect(listLines.every((line) => line.length < 140)).toBe(true);
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
