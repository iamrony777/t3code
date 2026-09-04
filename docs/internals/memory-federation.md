# Federated memory

> For maintainers.

Each provider harness (Codex, Claude, Grok, OpenCode, Command Code) persists memory
in its own files. T3 Code does not replace those stores — it indexes their paths and
tells every agent where the others are. The agent reads what it needs under its own
permission model.

## Components

- `ServerSettings.memorySources` (`packages/contracts/src/settings.ts`) — per-environment
  list of `{label, path, scope, harness?, enabled}`. Whole-list replacement patches;
  the settings UI sends the full list on every edit.
- `apps/server/src/memory/memoryManifest.ts` — pure assembly of the injected
  `<memory>` block: sort (harness, then recency), cap (10 entries), truncate labels
  (80 chars) and paths (200 chars), format freshness. No I/O.
- `apps/server/src/memory/MemorySourceIndexer.ts` — background service. Sweeps every
  60s and `stat()`s global sources (stat only, never content). Project sources are
  stat'd on demand per thread. `injectionFor({ projectRoot })` returns the current
  block or undefined when no source survives; the block is attached at session start
  and on every turn where the caller requests it. Missing or disabled sources are
  excluded. Never fails.
- `ProviderService` attaches the block as `memoryContext` on `ProviderSessionStartInput`
  and `ProviderSendTurnInput`.

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
