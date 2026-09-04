import type {
  MemoryAutoDetectProjectEntry,
  MemorySourceEntry,
  ProviderDriverKind,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  applyMemorySourceListEdit,
  hasMemorySource,
  isDetectedFolderExcluded,
  memoryAutoDetectEntryFor,
  toggleDetectedFolder,
  toggleMemorySourceEnabled,
  upsertManualMemorySource,
} from "./memorySources.logic.ts";

const autoDetectEntry = (
  overrides: Partial<MemoryAutoDetectProjectEntry> = {},
): MemoryAutoDetectProjectEntry => ({
  enabled: true,
  excluded: [],
  ...overrides,
});

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
    const added = source({ path: "memory/AGENTS.md", harness: "claude" as ProviderDriverKind });
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

describe("memoryAutoDetectEntryFor", () => {
  it("defaults to enabled with no exclusions when the project has no stored entry", () => {
    expect(memoryAutoDetectEntryFor(undefined, "/home/dev/proj-a")).toEqual({
      enabled: true,
      excluded: [],
    });
    expect(memoryAutoDetectEntryFor({}, "/home/dev/proj-a")).toEqual({
      enabled: true,
      excluded: [],
    });
  });

  it("returns the stored entry for another project untouched", () => {
    const autoDetect = {
      "/home/dev/proj-b": autoDetectEntry({ enabled: false, excluded: ["/mem-b"] }),
    };
    expect(memoryAutoDetectEntryFor(autoDetect, "/home/dev/proj-a")).toEqual({
      enabled: true,
      excluded: [],
    });
  });

  it("reads back the stored entry for the matching project root", () => {
    const autoDetect = {
      "/home/dev/proj-a": autoDetectEntry({ enabled: false, excluded: ["/mem-b"] }),
    };
    expect(memoryAutoDetectEntryFor(autoDetect, "/home/dev/proj-a")).toEqual({
      enabled: false,
      excluded: ["/mem-b"],
    });
  });

  it("fills the excluded default on a partial stored entry", () => {
    const autoDetect = { "/home/dev/proj-a": { enabled: false } as MemoryAutoDetectProjectEntry };
    expect(memoryAutoDetectEntryFor(autoDetect, "/home/dev/proj-a")).toEqual({
      enabled: false,
      excluded: [],
    });
  });
});

describe("isDetectedFolderExcluded", () => {
  it("is true only for paths in the excluded list", () => {
    const entry = autoDetectEntry({ excluded: ["/mem/one"] });
    expect(isDetectedFolderExcluded(entry, "/mem/one")).toBe(true);
    expect(isDetectedFolderExcluded(entry, "/mem/two")).toBe(false);
  });
});

describe("toggleDetectedFolder", () => {
  it("adds an exclusion for a folder that is currently included", () => {
    const entry = autoDetectEntry({ enabled: false, excluded: ["/mem/one"] });
    expect(toggleDetectedFolder(entry, "/mem/two")).toEqual({
      enabled: false,
      excluded: ["/mem/one", "/mem/two"],
    });
  });

  it("removes an existing exclusion, keeping the enabled flag", () => {
    const entry = autoDetectEntry({ enabled: false, excluded: ["/mem/one", "/mem/two"] });
    expect(toggleDetectedFolder(entry, "/mem/one")).toEqual({
      enabled: false,
      excluded: ["/mem/two"],
    });
  });

  it("does not mutate the input entry or its excluded array", () => {
    const entry = autoDetectEntry({ excluded: ["/mem/one"] });
    const next = toggleDetectedFolder(entry, "/mem/one");
    expect(entry.excluded).toEqual(["/mem/one"]);
    expect(next.excluded).not.toBe(entry.excluded);
  });
});

describe("toggleMemorySourceEnabled", () => {
  it("flips only the entry with the matching projectRoot and path", () => {
    const otherRoot = source({
      path: "shared.md",
      projectRoot: "/home/dev/proj-b",
      enabled: false,
    });
    const target = source({ path: "shared.md", enabled: true });
    const next = toggleMemorySourceEnabled([otherRoot, target], {
      projectRoot: "/home/dev/proj-a",
      path: "shared.md",
    });
    expect(next).toEqual([otherRoot, source({ path: "shared.md", enabled: false })]);
    expect(target.enabled).toBe(true);
  });

  it("returns an unchanged new array when no entry matches the key", () => {
    const input = [source()];
    const next = toggleMemorySourceEnabled(input, {
      projectRoot: "/home/dev/proj-a",
      path: "missing.md",
    });
    expect(next).toEqual(input);
    expect(next).not.toBe(input);
  });
});

describe("upsertManualMemorySource", () => {
  it("appends a fresh enabled entry when the (projectRoot, path) is new", () => {
    const existing = source({ path: "memory/AGENTS.md" });
    const next = upsertManualMemorySource([existing], {
      label: "Docs memory",
      path: "memory/docs.md",
      projectRoot: "/home/dev/proj-a",
    });
    expect(next).toEqual([existing, source({ label: "Docs memory", path: "memory/docs.md" })]);
  });

  it("adds the same path for a different projectRoot as its own entry", () => {
    const otherRoot = source({ path: "memory.md", projectRoot: "/home/dev/proj-b" });
    const next = upsertManualMemorySource([otherRoot], {
      label: "Docs memory",
      path: "memory.md",
      projectRoot: "/home/dev/proj-a",
    });
    expect(next).toEqual([otherRoot, source({ label: "Docs memory", path: "memory.md" })]);
  });

  it("re-adding an existing (projectRoot, path) updates only the label", () => {
    const stored = source({
      path: "memory.md",
      label: "Old",
      enabled: false,
      harness: "claude" as ProviderDriverKind,
    });
    const next = upsertManualMemorySource([stored], {
      label: "Renamed",
      path: "memory.md",
      projectRoot: "/home/dev/proj-a",
    });
    // enabled and harness survive; the path and projectRoot are untouched; no duplicate.
    expect(next).toEqual([
      source({
        path: "memory.md",
        label: "Renamed",
        enabled: false,
        harness: "claude" as ProviderDriverKind,
      }),
    ]);
  });
});
