# Federated memory

> For maintainers.

Each provider harness (Codex, Claude, Grok, OpenCode, Command Code) persists memory
in its own files. T3 Code does not replace those stores — it indexes their paths and
tells every agent where the others are. The agent reads what it needs under its own
permission model.

Memory is **per project**. A source is a file _or folder_ another harness keeps
memory in for one specific project, anchored to that project by its absolute
workspace root. There is no machine-wide or "global" tier: each harness already
handles its own user-level memory, so T3 only federates the per-project memory
that harnesses would otherwise lose track of.

## Components

- `ServerSettings.memorySources` (`packages/contracts/src/settings.ts`) —
  per-environment list of
  `{ label, path, projectRoot, harness?, enabled }`. `path` is absolute and
  `projectRoot` is the absolute workspace root the source is anchored to.
  Whole-list replacement patches; the settings UI sends the full list on every
  edit. Legacy v1 entries (no anchor) decode with `projectRoot: ""` and stay
  inert — they never match a real project root.
- `ServerSettings.memoryAutoDetect` (`packages/contracts/src/settings.ts`) —
  per-environment record keyed by absolute `projectRoot`, each value
  `{ enabled, excluded }`: the master detection switch for that project
  (`enabled` defaults true) plus the resolved detected folder paths the user
  excluded.
- `apps/server/src/memory/claudeMemoryFolders.ts` — pure helpers for Claude
  Code auto-memory folders: `encodeClaudeProjectFolder` (every character
  outside `[a-zA-Z0-9]` in the absolute root becomes `-`),
  `claudeMemoryFolderPath(configDir, projectRoot)` → the
  `<configDir>/projects/<encoded root>/memory` folder, and
  `claudeConfigDirLabel` for detected-folder labels. Claude keeps one `.md` per
  memory plus a `MEMORY.md` index in that folder; T3 only stats it.
- `apps/server/src/memory/MemorySourceIndexer.ts` — resolves everything for one
  exact `projectRoot` on demand, per call. `injectionFor({ projectRoot })`
  returns the current `<memory>` block for the thread (or undefined when no
  source survives): enabled manual sources anchored at that root plus Claude
  auto-memory folders detected under that root, minus anything the root's
  `memoryAutoDetect` switch/exclusions filter. `detectedFoldersFor({ projectRoot })`
  is the read-only preview backing the Project settings UI — it lists existing
  detected folders regardless of exclusions and the master switch. An empty
  root short-circuits first (no settings read). The rev-1 60s background sweep
  of global sources is **removed** — there is no global tier left to precompute,
  so the service has no `start` reactor and is simply provided where
  `ProviderService` reads it via `serviceOption`. Never fails.
- `apps/server/src/memory/memoryManifest.ts` — pure assembly of the injected
  `<memory>` block: sort (harness, then recency), cap (10 entries), truncate labels
  (80 chars) and paths (200 chars), format freshness. No I/O.
- `ProviderService` attaches the block as `memoryContext` on `ProviderSessionStartInput`
  and `ProviderSendTurnInput`, calling `injectionFor({ projectRoot })` per thread.

### Claude auto-memory detection

Detection is derived per call — never persisted in settings. For a project root,
the indexer:

1. Enumerates Claude config dirs from the settings snapshot: every **enabled**
   Claude Code instance (the legacy `providers.claudeAgent` slot plus explicit
   `providerInstances` envelopes, merged the way `ProviderInstanceRegistryHydration`
   merges them), deduplicated by resolved config dir. Each instance's dir comes
   from `resolveClaudeConfigDirPath` (`apps/server/src/provider/Drivers/ClaudeSkills.ts`):
   the instance `homePath` when set, else an ambient `CLAUDE_CONFIG_DIR` verbatim
   (no `~` expansion, matching what the spawned CLI sees), else `~/.claude`.
2. For each config dir, the candidate is the
   `<configDir>/projects/<encoded root>/memory` folder; it is detected when it
   exists as a directory (a `stat`, never a read).

Detected-folder labels prefer the instance's display name and fall back to the
config-dir basename, so multiple Claude profiles stay distinguishable.

### Freshness and stat-only invariant

`MemorySourceIndexer` only ever `stat()`s paths — it never reads content or
directory listings:

- a **file** source: file mtime;
- a **folder** source: the mtime of the `MEMORY.md` index inside it when present
  (a `stat`, not a read), else the folder mtime.

Everything is resolved and stat'd on demand per thread inside `injectionFor`
(a handful of stats per turn, bounded by instance count and the block cap).

## Read-only preview RPC

The client cannot compute detected folders (config dirs and folder existence are
server-side), so the Project settings UI reads them through a read-only preview
RPC: `server.getDetectedMemoryFolders` (`packages/contracts/src/memory.ts`),
consumed on the web client via the `serverEnvironment.detectedMemoryFolders`
query family. `{ projectRoot } → Array<{ path, label }>` of existing detected
folders, or `[]` when none exist; the answer is advisory — exclusion state still
lives in `memoryAutoDetect`, and injection never depends on the preview.

## Web Project-settings Memory section

Per-project memory config is edited where the project lives, not in General
settings. The web **Project settings → Memory** section
(`ProjectMemorySourcesSection`, on the per-checkout `ProjectSettingsPanel`)
shows the auto-detected Claude folders for the selected checkout's root — each
with an include/exclude switch plus a master "share Claude memory automatically"
toggle — and the manual sources anchored at that root, edited with the shared
list-edit helpers in `apps/web/src/components/settings/memorySources.logic.ts`.
The General-settings "Memory sources" section and its mobile counterpart are
gone; **mobile management UI is deferred** (mobile threads still receive the
injected block because injection is server-side).

## Per-adapter consumption

| Provider                | Slot                                                              |
| ----------------------- | ----------------------------------------------------------------- |
| Codex                   | per-turn developer instructions (`CodexDeveloperInstructions.ts`) |
| Claude                  | session-start system prompt (`buildClaudeSystemPrompt`)           |
| Grok                    | first prompt prefix (`grokPromptPartsWithMemory`)                 |
| OpenCode                | first prompt prefix (`withMemoryContext`)                         |
| Command Code (headless) | every turn prompt prefix (`resolveTurnRequest`)                   |

## Properties

- Injection never fails a turn: any indexer, stat, or settings failure yields no block.
- T3 never reads memory content: secrets never enter prompts or caches.
- Block size is bounded by the entry cap and label/path truncation.
