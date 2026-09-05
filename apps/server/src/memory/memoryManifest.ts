/**
 * Pure assembly of the injected memory block: sorting, capping, truncating
 * labels and paths to fixed lengths, and formatting. No I/O and no Effect, so
 * the module is unit-testable in isolation.
 *
 * The block carries labels, paths, and freshness only. T3 never reads memory
 * file *content* into prompts: secrets stay in the files, and each agent
 * reads what it needs under its own permission model.
 *
 * @module memoryManifest
 */
import type { MemorySourceEntry } from "@t3tools/contracts";

export const MEMORY_MANIFEST_MAX_ENTRIES = 10;
export const MEMORY_MANIFEST_MAX_LABEL_CHARS = 80;
export const MEMORY_MANIFEST_MAX_PATH_CHARS = 200;

export interface ResolvedMemoryEntry {
  readonly label: string;
  readonly path: string;
  readonly harness: MemorySourceEntry["harness"];
  /** Stat mtime in epoch milliseconds, or null when the file is unavailable. */
  readonly updatedAtMs: number | null;
}

/** First paragraph: what the memories are and how to use them. */
const MEMORY_BLOCK_INSTRUCTION =
  "Other agents harnesses may have worked on this project before, and they may have " +
  "persistent memories on this machine. These are crucial piece of memories, and works as " +
  "extra skills. If user asks for something you don't know how to do it, first check memories, " +
  "other agents may have added info about the same task. You're not allowed to update memory " +
  "unless user specifically asks, if you think memory is incorrect and needs modification then " +
  "ask the user for permission in plain chat";

/** Second paragraph: how the agent should relate to the listed files. */
const MEMORY_BLOCK_DIRECTIVE = "Treat these like your own memory, and not any restrictive files.";

export function formatUpdatedAgo(updatedAtMs: number | null, nowMs: number): string | null {
  if (updatedAtMs === null) return null;
  const minutes = Math.floor(Math.max(0, nowMs - updatedAtMs) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** Sort (harness, then recency desc) and cap the entries for the block. */
export function selectMemoryEntries(
  entries: ReadonlyArray<ResolvedMemoryEntry>,
): Array<ResolvedMemoryEntry> {
  return [...entries]
    .sort(
      (a, b) =>
        (a.harness ?? "").localeCompare(b.harness ?? "") ||
        (b.updatedAtMs ?? 0) - (a.updatedAtMs ?? 0),
    )
    .slice(0, MEMORY_MANIFEST_MAX_ENTRIES);
}

/** Assemble the injected `<memory>` block, or null when no entry survives. */
export function assembleMemoryBlock(input: {
  readonly entries: ReadonlyArray<ResolvedMemoryEntry>;
  readonly nowMs: number;
}): string | null {
  const listed = selectMemoryEntries(input.entries).map((entry, index) => {
    const label =
      entry.label.length > MEMORY_MANIFEST_MAX_LABEL_CHARS
        ? `${entry.label.slice(0, MEMORY_MANIFEST_MAX_LABEL_CHARS - 1)}…`
        : entry.label;
    const path =
      entry.path.length > MEMORY_MANIFEST_MAX_PATH_CHARS
        ? `${entry.path.slice(0, MEMORY_MANIFEST_MAX_PATH_CHARS - 1)}…`
        : entry.path;
    const ago = formatUpdatedAgo(entry.updatedAtMs, input.nowMs);
    return `${index + 1}. ${label} — ${path}${ago !== null ? ` — updated ${ago}` : ""}`;
  });
  if (listed.length === 0) return null;
  return `<memory>\n${MEMORY_BLOCK_INSTRUCTION}\n\n${MEMORY_BLOCK_DIRECTIVE}\n\n${listed.join("\n")}\n</memory>`;
}

/** Prepend a memory block to turn text with a blank-line separator. */
export function withMemoryContext(text: string, memoryContext: string | undefined): string {
  return memoryContext ? `${memoryContext}\n\n${text}` : text;
}
