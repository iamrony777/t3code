/**
 * Pure decision logic for the per-project Memory settings section.
 *
 * Two concerns live here:
 *
 * 1. List edits for memory source lists. Memory is per-project, so entries are
 *    identified by `(projectRoot, path)`: two different projects may
 *    legitimately hold the same `path`, and an edit must never touch the other
 *    project's entry. The whole list is sent as a replacement patch on every
 *    edit.
 *
 * 2. Per-project auto-detect preferences (`memoryAutoDetect`). The patch the
 *    UI sends is keyed by workspace root and always carries the fully merged
 *    per-key entry — decode fills `excluded: []` into every present key and
 *    `deepMerge` replaces arrays wholesale, so a partial per-key object would
 *    silently wipe that project's exclusions.
 *
 * A `projectRoot` of `""` marks an inert legacy entry that predates the
 * per-project anchor. These helpers match such an entry only when the key or
 * edited entry explicitly targets `projectRoot: ""`.
 */
import type { MemoryAutoDetectProjectEntry, MemorySourceEntry } from "@t3tools/contracts";

/** Identity of one memory source entry within a list. */
export type MemorySourceKey = { readonly projectRoot: string; readonly path: string };

export type MemorySourceListEdit =
  | { readonly kind: "add"; readonly entry: MemorySourceEntry }
  | { readonly kind: "update"; readonly entry: MemorySourceEntry }
  | { readonly kind: "remove"; readonly key: MemorySourceKey };

/** True when an entry with the same projectRoot and path exists in the list. */
export function hasMemorySource(
  sources: ReadonlyArray<MemorySourceEntry>,
  key: MemorySourceKey,
): boolean {
  return sources.some((entry) => entry.projectRoot === key.projectRoot && entry.path === key.path);
}

export function applyMemorySourceListEdit(
  sources: ReadonlyArray<MemorySourceEntry>,
  edit: MemorySourceListEdit,
): Array<MemorySourceEntry> {
  switch (edit.kind) {
    case "add":
      return [...sources, edit.entry];
    case "update":
      return sources.map((entry) =>
        entry.projectRoot === edit.entry.projectRoot && entry.path === edit.entry.path
          ? edit.entry
          : entry,
      );
    case "remove":
      return sources.filter(
        (entry) => !(entry.projectRoot === edit.key.projectRoot && entry.path === edit.key.path),
      );
  }
}

/**
 * Full per-project auto-detect preferences for one workspace root, with the
 * schema defaults applied: `enabled` reads as true and `excluded` as [] when
 * the root has no stored entry. Callers never see a partial per-key object.
 */
export function memoryAutoDetectEntryFor(
  autoDetect: Readonly<Record<string, MemoryAutoDetectProjectEntry>> | undefined,
  projectRoot: string,
): MemoryAutoDetectProjectEntry {
  const stored = autoDetect?.[projectRoot];
  return {
    enabled: stored?.enabled ?? true,
    excluded: stored?.excluded ?? [],
  };
}

/** True when a detected folder is excluded for this project's auto-detection. */
export function isDetectedFolderExcluded(
  entry: MemoryAutoDetectProjectEntry,
  folderPath: string,
): boolean {
  return entry.excluded.includes(folderPath);
}

/** Next full entry after including/excluding one detected folder. */
export function toggleDetectedFolder(
  entry: MemoryAutoDetectProjectEntry,
  folderPath: string,
): MemoryAutoDetectProjectEntry {
  return {
    ...entry,
    excluded: entry.excluded.includes(folderPath)
      ? entry.excluded.filter((path) => path !== folderPath)
      : [...entry.excluded, folderPath],
  };
}

/**
 * Next whole list after flipping one manual source's `enabled` flag. Keyed by
 * `(projectRoot, path)` so the other project's same-path entry is untouched.
 */
export function toggleMemorySourceEnabled(
  sources: ReadonlyArray<MemorySourceEntry>,
  key: MemorySourceKey,
): Array<MemorySourceEntry> {
  const existing = sources.find(
    (entry) => entry.projectRoot === key.projectRoot && entry.path === key.path,
  );
  if (!existing) return [...sources];
  return applyMemorySourceListEdit(sources, {
    kind: "update",
    entry: { ...existing, enabled: !existing.enabled },
  });
}

/**
 * Next whole list after adding a manual source, or renaming an existing one.
 * Re-adding an existing `(projectRoot, path)` updates only the label — never
 * clobbering `enabled`, `harness`, or the path. Fresh entries default to
 * `enabled: true`.
 */
export function upsertManualMemorySource(
  sources: ReadonlyArray<MemorySourceEntry>,
  input: { readonly label: string; readonly path: string; readonly projectRoot: string },
): Array<MemorySourceEntry> {
  const key: MemorySourceKey = { projectRoot: input.projectRoot, path: input.path };
  const existing = sources.find(
    (entry) => entry.projectRoot === key.projectRoot && entry.path === key.path,
  );
  if (existing !== undefined) {
    return applyMemorySourceListEdit(sources, {
      kind: "update",
      entry: { ...existing, label: input.label },
    });
  }
  return applyMemorySourceListEdit(sources, {
    kind: "add",
    entry: { label: input.label, path: input.path, projectRoot: input.projectRoot, enabled: true },
  });
}
