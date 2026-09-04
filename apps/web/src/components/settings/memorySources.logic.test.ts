import type { MemorySourceEntry } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { applyMemorySourceListEdit } from "./memorySources.logic.ts";

const source = (overrides: Partial<MemorySourceEntry> = {}): MemorySourceEntry => ({
  label: "Claude memory",
  path: "~/.claude/CLAUDE.md",
  scope: "global",
  enabled: true,
  ...overrides,
});

describe("applyMemorySourceListEdit", () => {
  it("adds a source", () => {
    const next = applyMemorySourceListEdit([], { kind: "add", entry: source() });
    expect(next).toEqual([source()]);
  });

  it("updates a source in place", () => {
    const original = source({ label: "Old" });
    const next = applyMemorySourceListEdit([original], {
      kind: "update",
      entry: source({ label: "New", enabled: false }),
    });
    expect(next).toEqual([source({ label: "New", enabled: false })]);
  });

  it("removes a source", () => {
    const original = source({ path: "a.md", label: "A" });
    const other = source({ path: "b.md", label: "B" });
    const next = applyMemorySourceListEdit([original, other], {
      kind: "remove",
      path: "a.md",
    });
    expect(next).toEqual([other]);
  });
});
