/**
 * List edits for memory source lists. Memory is per-project, so entries are
 * identified by `(projectRoot, path)`: two different projects may legitimately
 * hold the same `path`, and an edit must never touch the other project's
 * entry. The whole list is sent as a replacement patch on every edit.
 *
 * A `projectRoot` of `""` marks an inert legacy entry that predates the
 * per-project anchor. These helpers match such an entry only when the key or
 * edited entry explicitly targets `projectRoot: ""`.
 */
import type { MemorySourceEntry } from "@t3tools/contracts";

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
