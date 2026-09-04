/**
 * MemorySourceIndexer — per-project memory injection with Claude auto-memory
 * detection, stat-only.
 *
 * Per call (`injectionFor({ projectRoot })` / `detectedFoldersFor`), the
 * indexer reads the current settings and resolves everything for that exact
 * project root:
 *   - manual `ServerSettings.memorySources` entries whose `projectRoot`
 *     equals the root (enabled only; legacy v1 entries decoded with
 *     `projectRoot: ""` never match and stay inert), and
 *   - Claude Code auto-memory folders under the config dir of every *enabled*
 *     Claude Code instance — the legacy `providers.claudeAgent` slot plus
 *     explicit `providerInstances` envelopes, merged the same way
 *     `ProviderInstanceRegistryHydration` merges them, then deduplicated by
 *     resolved config dir. Detection honors the per-root
 *     `memoryAutoDetect[projectRoot]` master switch and exclusion list.
 *
 * Everything is resolved and stat'd on demand — the rev-1 60s background
 * sweep of global sources is gone (there is no global tier left to
 * precompute), so this service has no `start` reactor and is simply provided
 * where `ProviderService` reads it via `serviceOption`. File content is never
 * read: only `stat()`s drive existence and freshness.
 *
 * @module MemorySourceIndexer
 */
import { NodeServices } from "@effect/platform-node";
import {
  ProviderDriverKind,
  type ServerSettings as ContractServerSettings,
  resolveProviderInstanceEnabled,
} from "@t3tools/contracts";
import { type DeepPartial } from "@t3tools/shared/Struct";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { resolveClaudeConfigDirPath } from "../provider/Drivers/ClaudeSkills.ts";
import { deriveProviderInstanceConfigMap } from "../provider/Layers/ProviderInstanceRegistryHydration.ts";
import * as ServerSettings from "../serverSettings.ts";
import { claudeConfigDirLabel, claudeMemoryFolderPath } from "./claudeMemoryFolders.ts";
import { assembleMemoryBlock, type ResolvedMemoryEntry } from "./memoryManifest.ts";

const CLAUDE_AGENT_DRIVER = ProviderDriverKind.make("claudeAgent");

/** A detected Claude auto-memory folder that exists on disk right now. */
export interface DetectedMemoryFolder {
  readonly path: string;
  readonly label: string;
}

export class MemorySourceIndexer extends Context.Service<
  MemorySourceIndexer,
  {
    /**
     * The current `<memory>` block for the thread's project root, or
     * undefined when no source survives. Never fails: settings or stat
     * failures yield no block rather than an error.
     */
    injectionFor: (input: {
      readonly projectRoot: string;
    }) => Effect.Effect<string | undefined, never>;

    /**
     * Existing detected Claude auto-memory folders for the project root —
     * the read-only preview used by the Project settings UI. Unaffected by
     * per-root exclusions and the master switch; empty when nothing exists.
     * Never fails.
     */
    detectedFoldersFor: (input: {
      readonly projectRoot: string;
    }) => Effect.Effect<ReadonlyArray<DetectedMemoryFolder>, never>;
  }
>()("t3/memory/MemorySourceIndexer") {}

const make = Effect.gen(function* () {
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;

  /**
   * Freshness in epoch milliseconds: the mtime for a file; for a directory
   * the mtime of its `MEMORY.md` index when present, else the directory
   * mtime. `null` for other path types, missing paths, and stat failures.
   * Never reads content.
   */
  const statFreshness = (path: string): Effect.Effect<number | null> =>
    fs.stat(path).pipe(
      Effect.flatMap((info) => {
        const mtimeMs = Option.getOrNull(Option.map(info.mtime, (mtime) => mtime.getTime()));
        if (info.type === "File") return Effect.succeed(mtimeMs);
        if (info.type === "Directory") {
          const memoryIndexPath = paths.join(path, "MEMORY.md");
          return fs.stat(memoryIndexPath).pipe(
            Effect.map((memoryInfo) =>
              memoryInfo.type === "File"
                ? Option.getOrNull(Option.map(memoryInfo.mtime, (mtime) => mtime.getTime()))
                : mtimeMs,
            ),
            Effect.orElseSucceed(() => mtimeMs),
          );
        }
        return Effect.succeed(null);
      }),
      Effect.orElseSucceed(() => null),
    );

  /** True when `path` stats as a directory (false for missing paths/files). */
  const isDirectory = (path: string): Effect.Effect<boolean> =>
    fs.stat(path).pipe(
      Effect.map((info) => info.type === "Directory"),
      Effect.orElseSucceed(() => false),
    );

  /**
   * Resolved Claude config dirs that apply to one settings snapshot: one per
   * enabled claudeAgent instance (the synthesized legacy `providers.claudeAgent`
   * slot plus explicit `providerInstances` envelopes, merged the way the
   * registry hydration merges them), deduplicated by resolved dir. Each entry
   * keeps its instance displayName so detected folders can prefer it over the
   * config-dir basename label. A malformed instance config (explicit envelopes
   * carry `config` as unknown) is skipped — never a failure.
   */
  const enumerateClaudeConfigDirs = (
    settings: ContractServerSettings,
  ): Effect.Effect<
    ReadonlyArray<{ readonly dir: string; readonly displayName: string | undefined }>,
    never
  > =>
    Effect.gen(function* () {
      const instanceMap = deriveProviderInstanceConfigMap(settings);
      const dirs: Array<{ dir: string; displayName: string | undefined }> = [];
      const seen = new Set<string>();
      for (const instance of Object.values(instanceMap)) {
        if (instance.driver !== CLAUDE_AGENT_DRIVER) continue;
        if (!resolveProviderInstanceEnabled(instance)) continue;
        const homePath = readClaudeHomePath(instance.config);
        if (homePath === undefined) continue;
        const dir = yield* resolveClaudeConfigDirPath({ homePath }, process.env);
        if (seen.has(dir)) continue;
        seen.add(dir);
        dirs.push({ dir, displayName: instance.displayName });
      }
      return dirs;
    });

  const detectedFoldersFor = ({ projectRoot }: { readonly projectRoot: string }) =>
    Effect.gen(function* () {
      if (projectRoot.trim().length === 0) return [];
      const settings = yield* settingsService.getSettings.pipe(
        Effect.orElseSucceed(() => undefined),
      );
      if (settings === undefined) return [];
      const configDirs = yield* enumerateClaudeConfigDirs(settings);
      const folders: Array<DetectedMemoryFolder> = [];
      for (const { dir, displayName } of configDirs) {
        const folderPath = claudeMemoryFolderPath(dir, projectRoot);
        if (yield* isDirectory(folderPath)) {
          folders.push({ path: folderPath, label: displayName ?? claudeConfigDirLabel(dir) });
        }
      }
      return folders;
    });

  const injectionFor = ({ projectRoot }: { readonly projectRoot: string }) =>
    Effect.gen(function* () {
      const settings = yield* settingsService.getSettings.pipe(
        Effect.orElseSucceed(() => undefined),
      );
      if (settings === undefined) return undefined;
      if (projectRoot.trim().length === 0) return undefined;

      const manualEntries = yield* Effect.forEach(settings.memorySources, (entry) =>
        Effect.gen(function* () {
          // Per-project anchors: only the exact root matches. Legacy v1
          // entries decoded with `projectRoot: ""` never equal a real thread
          // root (and an empty-root call returned above), so they stay inert.
          if (!entry.enabled) return [];
          if (entry.projectRoot !== projectRoot) return [];
          const updatedAtMs = yield* statFreshness(entry.path);
          if (updatedAtMs === null) return [];
          return [
            {
              label: entry.label,
              path: entry.path,
              harness: entry.harness,
              updatedAtMs,
            } satisfies ResolvedMemoryEntry,
          ];
        }),
      ).pipe(Effect.map((groups) => groups.flat()));

      const autoDetect = settings.memoryAutoDetect[projectRoot];
      const autoDetectEnabled = autoDetect?.enabled !== false;
      const excluded = autoDetect?.excluded ?? [];

      let detectedEntries: ReadonlyArray<ResolvedMemoryEntry> = [];
      if (autoDetectEnabled) {
        const configDirs = yield* enumerateClaudeConfigDirs(settings);
        detectedEntries = yield* Effect.forEach(configDirs, ({ dir, displayName }) =>
          Effect.gen(function* () {
            const folderPath = claudeMemoryFolderPath(dir, projectRoot);
            if (!(yield* isDirectory(folderPath))) return [];
            if (excluded.includes(folderPath)) return [];
            const updatedAtMs = yield* statFreshness(folderPath);
            if (updatedAtMs === null) return [];
            return [
              {
                label: displayName ?? claudeConfigDirLabel(dir),
                path: folderPath,
                harness: CLAUDE_AGENT_DRIVER,
                updatedAtMs,
              } satisfies ResolvedMemoryEntry,
            ];
          }),
        ).pipe(Effect.map((groups) => groups.flat()));
      }

      const block = assembleMemoryBlock({
        entries: [...manualEntries, ...detectedEntries],
        nowMs: yield* Clock.currentTimeMillis,
      });
      if (block === null) return undefined;
      return block;
    });

  return { injectionFor, detectedFoldersFor } satisfies MemorySourceIndexer["Service"];
});

/**
 * Guarded read of the Claude `homePath` inside a provider instance's config
 * blob. `providers.claudeAgent` decodes as a full ClaudeSettings object, but
 * explicit `providerInstances` envelopes carry `config` as unknown, so a
 * malformed shape must skip that instance rather than fail the whole call.
 * Returns `undefined` to skip, or the (possibly empty) homePath string —
 * empty resolves to the ambient default config dir, matching the CLI.
 */
function readClaudeHomePath(config: unknown): string | undefined {
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    return undefined;
  }
  const homePath = (config as { readonly homePath?: unknown }).homePath;
  if (homePath === undefined) return "";
  return typeof homePath === "string" ? homePath : undefined;
}

export const layer = Layer.effect(MemorySourceIndexer, make);

/** Test layer: in-memory ServerSettings built from `overrides` plus NodeServices. */
export const layerTest = (overrides: DeepPartial<ContractServerSettings> = {}) =>
  layer.pipe(
    Layer.provide(ServerSettings.layerTest(overrides)),
    Layer.provideMerge(NodeServices.layer),
  );
