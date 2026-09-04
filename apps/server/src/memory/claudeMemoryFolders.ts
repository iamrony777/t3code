/**
 * Claude Code per-project auto-memory folder helpers.
 *
 * Claude Code (as of the versions verified for this feature) keeps auto-memory
 * for each project on disk at:
 *
 *   `<config dir>/projects/<encoded cwd>/memory`
 *
 * where `<encoded cwd>` is the absolute project path with every character
 * outside `[a-zA-Z0-9]` replaced by `-`. The folder holds one `.md` per
 * memory plus a `MEMORY.md` index; T3 only stats it (never reads content).
 *
 * Verified real vectors:
 *   `/home/rony/Work/javinfo/core`          → `-home-rony-Work-javinfo-core`
 *   `/home/rony/.claude-mem/observer-sessions` → `-home-rony--claude-mem-observer-sessions`
 *   `/home/rony/Work/iamrony777.github.io`  → `-home-rony-Work-iamrony777-github-io`
 *
 * Documented Windows case: `C:\Users\you\my-app` → `C--Users-you-my-app` — the
 * drive `:` becomes `-` and the `\` separators become `-` (two in a row after
 * the drive letter), matching the same character-class rule.
 *
 * These helpers are intentionally pure string logic: no Effect, no I/O, no
 * path library, so they run identically in tests and on every platform. A
 * mismatch with future Claude Code naming only means a folder is missed or
 * misattributed — T3 never modifies or reads memory content.
 *
 * @module claudeMemoryFolders
 */

/** Replace every character outside `[a-zA-Z0-9]` with `-`, matching Claude
 * Code's per-project folder name encoding (see module doc). */
export function encodeClaudeProjectFolder(projectRoot: string): string {
  return projectRoot.replace(/[^a-zA-Z0-9]/g, "-");
}

/** The `<config dir>/projects/<encoded cwd>/memory` folder Claude Code uses
 * for one project's auto-memory. Both inputs are absolute, so plain `/`
 * joining is deterministic and dependency-free. */
export function claudeMemoryFolderPath(configDir: string, projectRoot: string): string {
  return [configDir, "projects", encodeClaudeProjectFolder(projectRoot), "memory"].join("/");
}

/**
 * A short human label for a Claude config dir: its basename with any leading
 * dots stripped, so `~/.claude` reads `claude` and a profile dir like
 * `…/work_seo1` reads `work_seo1`. Falls back to `"claude"` when the basename
 * is empty (e.g. a filesystem root like `/`) or becomes empty once its leading
 * dots are removed (e.g. `.`/`..`), keeping the label non-empty and stable.
 */
export function claudeConfigDirLabel(configDir: string): string {
  const trimmed = configDir.replace(/[\\/]+$/, "");
  const lastSeparator = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  const basename = lastSeparator === -1 ? trimmed : trimmed.slice(lastSeparator + 1);
  const label = basename.replace(/^\.+/, "");
  return label.length > 0 ? label : "claude";
}
