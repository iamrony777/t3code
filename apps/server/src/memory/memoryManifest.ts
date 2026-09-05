/**
 * Pure assembly of the injected memory block: sorting, capping, truncating
 * labels and paths to fixed lengths, and formatting. No I/O and no Effect, so
 * the module is unit-testable in isolation.
 *
 * T3 Code is a harness-for-harnesses: the block lists the folders where the
 * *other* harnesses that share this project checkout keep their persistent
 * project memory. The header tells the agent (a) to treat that memory as its
 * own project knowledge, (b) when to consult it and to be honest about
 * staleness and writes, and (c) how to navigate each harness's *foreign*
 * folder layout — hinted only for the harness kinds actually present, so the
 * block stays small.
 *
 * The block carries labels, paths, freshness, and navigation hints only. T3
 * never reads memory file *content* into prompts: secrets stay in the files,
 * and each agent reads what it needs under its own permission model.
 *
 * @module memoryManifest
 */
import type { ProviderDriverKind } from "@t3tools/contracts";
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

/** Shared-ownership preamble: these are the agent's own project memory. */
const MEMORY_OWNERSHIP =
  "T3 Code is a harness-for-harnesses. The folders below are persistent project " +
  "memory recorded by the other harnesses that share this project checkout with you. " +
  "Treat what is in them as your own project memory — use it to stay consistent with " +
  "prior work, before you re-derive decisions someone else already made.";

/** Codex-style consult/skip boundary plus staleness honesty and write-gating. */
const MEMORY_USE_GUIDANCE =
  "Consult these folders before acting when the task references anything in them, needs " +
  "prior context, or is ambiguous and earlier work may inform it. Skip them for " +
  "self-contained queries. \u201cUpdated Xd ago\u201d is the last change time; when a fact may be " +
  "stale (infra, commands, timings), verify it or flag that it may be outdated. Do not " +
  "edit these files unless the user explicitly asks \u2014 if one looks wrong, say so and ask in chat.";

/** One navigation hint per harness kind present in the block. Keyed on the
 * `ProviderDriverKind` slug so only harnesses with a known layout emit a hint. */
const HARNESS_NAVIGATION_HINTS: ReadonlyArray<{
  readonly harness: ProviderDriverKind;
  readonly hint: string;
}> = [
  {
    harness: "claudeAgent" as ProviderDriverKind,
    hint:
      "Claude Code memory: a per-project folder under the harness config dir. The folder " +
      "name encodes the project path with every non-alphanumeric replaced by \u201c-\u201d. Each memory " +
      "is one topic.md; read the MEMORY.md index first, then open only the relevant topics.",
  },
];

/** The harness kinds whose entries are present, in hint order, deduplicated. */
const presentHarnessKinds = (
  entries: ReadonlyArray<ResolvedMemoryEntry>,
): Set<ProviderDriverKind> => {
  const kinds = new Set<ProviderDriverKind>();
  for (const entry of entries) {
    if (entry.harness !== undefined) kinds.add(entry.harness);
  }
  return kinds;
};

/** The navigation-hint lines for the harness kinds present in the entries. */
const navigationHintLines = (entries: ReadonlyArray<ResolvedMemoryEntry>): Array<string> => {
  const present = presentHarnessKinds(entries);
  const lines: Array<string> = [];
  for (const { harness, hint } of HARNESS_NAVIGATION_HINTS) {
    if (present.has(harness)) lines.push(`- ${hint}`);
  }
  return lines;
};

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

  const hints = navigationHintLines(input.entries);
  const body = [MEMORY_OWNERSHIP, MEMORY_USE_GUIDANCE];
  if (hints.length > 0) {
    body.push("Reading hints (per harness):");
    body.push(...hints);
  }
  body.push(...listed);
  return `<memory>\n${body.join("\n")}\n</memory>`;
}

/** Prepend a memory block to turn text with a blank-line separator. */
export function withMemoryContext(text: string, memoryContext: string | undefined): string {
  return memoryContext ? `${memoryContext}\n\n${text}` : text;
}
