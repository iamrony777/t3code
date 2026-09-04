/**
 * List edits for the memory sources settings section. Entries are identified
 * by `path`; the whole list is sent as a replacement patch on every edit.
 */
import type { MemorySourceEntry } from "@t3tools/contracts";

export type MemorySourceListEdit =
  | { readonly kind: "add"; readonly entry: MemorySourceEntry }
  | { readonly kind: "update"; readonly entry: MemorySourceEntry }
  | { readonly kind: "remove"; readonly path: string };

export function applyMemorySourceListEdit(
  sources: ReadonlyArray<MemorySourceEntry>,
  edit: MemorySourceListEdit,
): Array<MemorySourceEntry> {
  switch (edit.kind) {
    case "add":
      return [...sources, edit.entry];
    case "update":
      return sources.map((entry) => (entry.path === edit.entry.path ? edit.entry : entry));
    case "remove":
      return sources.filter((entry) => entry.path !== edit.path);
  }
}
