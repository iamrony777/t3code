import type { MemorySourceEntry } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { applyMemorySourceListEdit, hasMemorySource } from "./memorySources.logic.ts";

const source = (overrides: Partial<MemorySourceEntry> = {}): MemorySourceEntry => ({
  label: "Claude memory",
  path: "memory/CLAUDE.md",
  projectRoot: "/home/dev/proj-a",
  enabled: true,
  ...overrides,
});

describe("hasMemorySource", () => {
  it("matches an entry with the same projectRoot and path", () => {
    const sources = [source({ path: "memory.md" })];
    expect(hasMemorySource(sources, { projectRoot: "/home/dev/proj-a", path: "memory.md" })).toBe(
      true,
    );
  });

  it("does not match the same path anchored at a different projectRoot", () => {
    const sources = [source({ path: "memory/CLAUDE.md" })];
    expect(
      hasMemorySource(sources, { projectRoot: "/home/dev/proj-b", path: "memory/CLAUDE.md" }),
    ).toBe(false);
  });

  it("does not match a different path in the same projectRoot", () => {
    const sources = [source({ path: "memory/CLAUDE.md" })];
    expect(hasMemorySource(sources, { projectRoot: "/home/dev/proj-a", path: "other.md" })).toBe(
      false,
    );
  });

  it("is false for an empty list", () => {
    expect(hasMemorySource([], { projectRoot: "/home/dev/proj-a", path: "memory.md" })).toBe(false);
  });

  it("matches a legacy rootless entry only when projectRoot is explicitly ''", () => {
    const legacy = source({ projectRoot: "", path: "~/.claude/CLAUDE.md" });
    expect(hasMemorySource([legacy], { projectRoot: "", path: "~/.claude/CLAUDE.md" })).toBe(true);
    expect(
      hasMemorySource([legacy], { projectRoot: "/home/dev/proj-a", path: "~/.claude/CLAUDE.md" }),
    ).toBe(false);
  });
});

describe("applyMemorySourceListEdit", () => {
  it("adds a full entry including projectRoot and harness", () => {
    const added = source({ path: "memory/AGENTS.md", harness: "claude" });
    const next = applyMemorySourceListEdit([source()], { kind: "add", entry: added });
    expect(next).toEqual([source(), added]);
  });

  it("appends on a duplicate add instead of deduping (callers pre-check)", () => {
    const existing = source();
    const next = applyMemorySourceListEdit([existing], { kind: "add", entry: existing });
    expect(next).toEqual([existing, existing]);
  });

  it("updates only the entry whose projectRoot and path both match", () => {
    const samePathOtherRoot = source({
      path: "shared.md",
      projectRoot: "/home/dev/proj-b",
      label: "Other project",
    });
    const original = source({ path: "shared.md", label: "Old" });
    const next = applyMemorySourceListEdit([samePathOtherRoot, original], {
      kind: "update",
      entry: source({ path: "shared.md", label: "New", enabled: false }),
    });
    expect(next).toEqual([
      samePathOtherRoot,
      source({ path: "shared.md", label: "New", enabled: false }),
    ]);
  });

  it("leaves a same-path entry anchored at another projectRoot untouched on update", () => {
    const otherRoot = source({ path: "memory.md", projectRoot: "/home/dev/proj-b", label: "B" });
    const next = applyMemorySourceListEdit([otherRoot], {
      kind: "update",
      entry: source({ path: "memory.md", label: "A-renamed" }),
    });
    expect(next).toEqual([otherRoot]);
  });

  it("replaces the whole matched entry and returns a new array", () => {
    const input = [source({ label: "Old" })];
    const next = applyMemorySourceListEdit(input, {
      kind: "update",
      entry: source({ label: "New" }),
    });
    expect(next).toEqual([source({ label: "New" })]);
    expect(next).not.toBe(input);
    // The input array and entries are left untouched.
    expect(input).toEqual([source({ label: "Old" })]);
  });

  it("removes only the entry with the matching projectRoot and path", () => {
    const samePathOtherRoot = source({
      path: "shared.md",
      projectRoot: "/home/dev/proj-b",
      label: "Other project",
    });
    const original = source({ path: "shared.md", label: "A" });
    const next = applyMemorySourceListEdit([original, samePathOtherRoot], {
      kind: "remove",
      key: { projectRoot: "/home/dev/proj-a", path: "shared.md" },
    });
    expect(next).toEqual([samePathOtherRoot]);
    // The input entries and array must be left untouched.
    expect([original, samePathOtherRoot]).toEqual([
      source({ path: "shared.md", label: "A" }),
      source({ path: "shared.md", projectRoot: "/home/dev/proj-b", label: "Other project" }),
    ]);
  });

  it("does not remove the same path at a different projectRoot", () => {
    const otherRoot = source({ path: "memory.md", projectRoot: "/home/dev/proj-b", label: "B" });
    const next = applyMemorySourceListEdit([otherRoot], {
      kind: "remove",
      key: { projectRoot: "/home/dev/proj-a", path: "memory.md" },
    });
    expect(next).toEqual([otherRoot]);
  });

  it("removes a legacy rootless entry only when the key targets projectRoot ''", () => {
    const legacy = source({ projectRoot: "", path: "~/.claude/CLAUDE.md" });
    const next = applyMemorySourceListEdit([legacy], {
      kind: "remove",
      key: { projectRoot: "", path: "~/.claude/CLAUDE.md" },
    });
    expect(next).toEqual([]);
  });
});
