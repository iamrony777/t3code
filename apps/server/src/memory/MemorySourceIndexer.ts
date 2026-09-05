/**
 * MemorySourceIndexer — per-project memory injection with Claude auto-memory
 * detection, stat-only.
 *
 * Per call (`injectionFor({ projectRoot })` / `detectedFoldersFor`), the
 * indexer reads the current settings and resolves everything for that exact
 * project root — an empty root short-circuits first (no settings read, no
 * block, no folders):
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
  type DetectedMemoryFolder,
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

/** One resolved Claude config dir that applies to a settings snapshot: the
 * config dir itself plus the instance displayName to prefer over the
 * config-dir basename label. */
type ClaudeConfigDir = { readonly dir: string; readonly displayName: string | undefined };

/** One detected auto-memory folder resolved for a project root — the shared
 * shape both the read-only preview (`detectedFoldersFor`) and injection
 * (`injectionFor`) consume. */
type DetectedFolderEntry = {
  readonly path: string;
  readonly label: string;
  readonly updatedAtMs: number | null;
};

/**
 * Resolved Claude config dirs that apply to one settings snapshot: one per
 * enabled claudeAgent instance (the synthesized legacy `providers.claudeAgent`
 * slot plus explicit `providerInstances` envelopes, merged the way the
 * registry hydration merges them), deduplicated by resolved dir. Each entry
 * keeps its instance displayName so detected folders can prefer it over the
 * config-dir basename label. A malformed instance config (explicit envelopes
 * carry `config` as unknown) is skipped — never a failure. `environment`
 * supplies the ambient default (`CLAUDE_CONFIG_DIR`, `~/.claude`) only for
 * instances without a homePath.
 */
const enumerateClaudeConfigDirs = (
  settings: ContractServerSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.Effect<ReadonlyArray<ClaudeConfigDir>, never, Path.Path> =>
  Effect.gen(function* () {
    const instanceMap = deriveProviderInstanceConfigMap(settings);
    const dirs: Array<ClaudeConfigDir> = [];
    const seen = new Set<string>();
    for (const instance of Object.values(instanceMap)) {
      if (instance.driver !== CLAUDE_AGENT_DRIVER) continue;
      if (!resolveProviderInstanceEnabled(instance)) continue;
      const homePath = readClaudeHomePath(instance.config);
      if (homePath === undefined) continue;
      const dir = yield* resolveClaudeConfigDirPath({ homePath }, environment);
      if (seen.has(dir)) continue;
      seen.add(dir);
      dirs.push({ dir, displayName: instance.displayName });
    }
    return dirs;
  });

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
   * Freshness of an existing directory: the mtime of its `MEMORY.md` index
   * file when the index is a file, else the directory's own mtime (epoch ms,
   * or null when the filesystem reports no mtime). Shared by `statFreshness`
   * and `detectedEntryFor` so a detected folder is never stat'd twice.
   */
  const statDirectoryFreshness = (
    directoryPath: string,
    directoryMtimeMs: number | null,
  ): Effect.Effect<number | null> =>
    fs.stat(paths.join(directoryPath, "MEMORY.md")).pipe(
      Effect.map((memoryInfo) =>
        memoryInfo.type === "File"
          ? Option.getOrNull(Option.map(memoryInfo.mtime, (mtime) => mtime.getTime()))
          : directoryMtimeMs,
      ),
      Effect.orElseSucceed(() => directoryMtimeMs),
    );

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
        if (info.type === "Directory") return statDirectoryFreshness(path, mtimeMs);
        return Effect.succeed(null);
      }),
      Effect.orElseSucceed(() => null),
    );

  /**
   * Resolve one candidate Claude auto-memory folder from a config-dir entry
   * under `projectRoot`: stats the `<configDir>/projects/<encoded root>/memory`
   * path once and returns its resolved entry (`{ path, label, updatedAtMs }`)
   * when it is a directory, else null. The label prefers the instance
   * displayName over the config-dir basename. `updatedAtMs` (via
   * `statDirectoryFreshness`) is null only when the filesystem reports no
   * mtime — the injection caller drops those while the preview still lists
   * the folder. Never reads content.
   */
  const detectedEntryFor = (
    configDir: ClaudeConfigDir,
    projectRoot: string,
  ): Effect.Effect<DetectedFolderEntry | null, never> =>
    Effect.gen(function* () {
      const folderPath = claudeMemoryFolderPath(configDir.dir, projectRoot);
      const folderStat = yield* Effect.option(fs.stat(folderPath));
      if (Option.isNone(folderStat)) return null;
      const stat = folderStat.value;
      if (stat.type !== "Directory") return null;
      const mtimeMs = Option.getOrNull(Option.map(stat.mtime, (mtime) => mtime.getTime()));
      const updatedAtMs = yield* statDirectoryFreshness(folderPath, mtimeMs);
      return {
        path: folderPath,
        label: configDir.displayName ?? claudeConfigDirLabel(configDir.dir),
        updatedAtMs,
      };
    });

  const detectedFoldersFor = ({ projectRoot }: { readonly projectRoot: string }) =>
    Effect.gen(function* () {
      if (projectRoot.trim().length === 0) return [];
      const settings = yield* settingsService.getSettings.pipe(
        Effect.orElseSucceed(() => undefined),
      );
      if (settings === undefined) return [];
      const configDirs = yield* enumerateClaudeConfigDirs(settings).pipe(
        Effect.provideService(Path.Path, paths),
      );
      const folders: Array<DetectedMemoryFolder> = [];
      for (const configDir of configDirs) {
        const entry = yield* detectedEntryFor(configDir, projectRoot);
        if (entry !== null) folders.push({ path: entry.path, label: entry.label });
      }
      return folders;
    });

  const injectionFor = ({ projectRoot }: { readonly projectRoot: string }) =>
    Effect.gen(function* () {
      // An empty root has nothing to anchor sources to: return before reading
      // settings, matching `detectedFoldersFor`.
      if (projectRoot.trim().length === 0) return undefined;
      const settings = yield* settingsService.getSettings.pipe(
        Effect.orElseSucceed(() => undefined),
      );
      if (settings === undefined) return undefined;

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
        const configDirs = yield* enumerateClaudeConfigDirs(settings).pipe(
          Effect.provideService(Path.Path, paths),
        );
        detectedEntries = yield* Effect.forEach(configDirs, (configDir) =>
          Effect.gen(function* () {
            const entry = yield* detectedEntryFor(configDir, projectRoot);
            if (entry === null) return [];
            // Master-switch/exclusion filtering stays in this caller: the
            // read-only preview (`detectedFoldersFor`) lists regardless.
            if (excluded.includes(entry.path)) return [];
            if (entry.updatedAtMs === null) return [];
            return [
              {
                label: entry.label,
                path: entry.path,
                harness: CLAUDE_AGENT_DRIVER,
                updatedAtMs: entry.updatedAtMs,
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

export const layer = Layer.effect(MemorySourceIndexer, make);

/**
 * Backing effect for the read-only preview RPC
 * (`server.getDetectedMemoryFolders`): the existing detected Claude
 * auto-memory folders for a project root, or `[]` when the indexer has not
 * been provided in the current composition (it is optional — `ProviderService`
 * reads it the same way). Never fails: an absent indexer, unreadable
 * settings, or a missing folder all answer an empty list so the Project
 * settings preview can always render.
 *
 * The declared `MemorySourceIndexer` requirement above is advisory: the body
 * reads the service via `Effect.serviceOption`, so the annotation — not the
 * implementation — is what forces compositions to provide it. Do not drop it
 * or the preview silently answers `[]` everywhere.
 */
export const detectedFoldersPreview = ({
  projectRoot,
}: {
  readonly projectRoot: string;
}): Effect.Effect<ReadonlyArray<DetectedMemoryFolder>, never, MemorySourceIndexer> =>
  Effect.serviceOption(MemorySourceIndexer).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeed([]),
        onSome: (indexer) => indexer.detectedFoldersFor({ projectRoot }),
      }),
    ),
  );

/** Test layer: in-memory ServerSettings built from `overrides` plus NodeServices. */
export const layerTest = (overrides: DeepPartial<ContractServerSettings> = {}) =>
  layer.pipe(
    Layer.provide(ServerSettings.layerTest(overrides)),
    Layer.provideMerge(NodeServices.layer),
  );
