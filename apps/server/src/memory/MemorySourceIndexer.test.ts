/**
 * MemorySourceIndexer tests — per-project manual sources plus Claude
 * auto-memory detection. Real temp dirs are created through effect/FileSystem
 * and the indexer only stats paths (never reads content), so freshness is
 * observed through the formatted `<memory>` block and `detectedFoldersFor`.
 */
import { describe, expect, it } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { claudeConfigDirLabel, claudeMemoryFolderPath } from "./claudeMemoryFolders.ts";
import * as MemorySourceIndexer from "./MemorySourceIndexer.ts";

const CLAUDE_AGENT_DRIVER = ProviderDriverKind.make("claudeAgent");

type IndexerOverrides = Parameters<typeof MemorySourceIndexer.layerTest>[0];

/** Acquire the indexer under a test settings layer and run `body` against it. */
const withIndexer = <A, E, R>(
  overrides: IndexerOverrides,
  body: (indexer: MemorySourceIndexer.MemorySourceIndexer["Service"]) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  MemorySourceIndexer.MemorySourceIndexer.pipe(
    Effect.flatMap((indexer) => body(indexer)),
    Effect.provide(MemorySourceIndexer.layerTest(overrides)),
  );

const withTempDirs = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  effect.pipe(Effect.scoped, Effect.provide(NodeServices.layer));

/** Create `<configDir>/projects/<encoded root>/memory` and return its path. */
const createClaudeMemoryFolder = (
  fs: FileSystem.FileSystem,
  configDir: string,
  projectRoot: string,
): Effect.Effect<string> => {
  const folder = claudeMemoryFolderPath(configDir, projectRoot);
  return fs.makeDirectory(folder, { recursive: true }).pipe(Effect.as(folder));
};

describe("MemorySourceIndexer", () => {
  it.live("includes enabled manual sources anchored at the root, excluding the rest", () =>
    withTempDirs(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const paths = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-mem-root-" });
        const otherRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-mem-other-" });
        const now = Date.now();

        const file = yield* fs.makeTempFileScoped({ prefix: "t3-mem-file-" });
        yield* fs.utimes(file, new Date(now), new Date(now - 65_000));
        const missing = paths.join(root, "missing.md");

        const block = yield* withIndexer(
          {
            // Manual-source test: detection off keeps it hermetic so no
            // ambient ~/.claude config dir is ever enumerated or stat'd.
            providers: { claudeAgent: { enabled: false } },
            memorySources: [
              { label: "Anchored", path: file, projectRoot: root, enabled: true },
              { label: "Elsewhere", path: file, projectRoot: otherRoot, enabled: true },
              { label: "Disabled", path: file, projectRoot: root, enabled: false },
              { label: "Legacy", path: file, projectRoot: "", enabled: true },
              { label: "Missing", path: missing, projectRoot: root, enabled: true },
            ],
          },
          (indexer) => indexer.injectionFor({ projectRoot: root }),
        );

        expect(block).toBeDefined();
        expect(block).toContain("1. Anchored");
        expect(block).toContain(file);
        expect(block).toContain("updated 1m ago");
        expect(block).not.toContain("Elsewhere");
        expect(block).not.toContain("Disabled");
        expect(block).not.toContain("Legacy");
        expect(block).not.toContain("Missing");
      }),
    ),
  );

  it.live("a directory source reports MEMORY.md freshness when present", () =>
    withTempDirs(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const paths = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-mem-root-" });
        const memoryDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-mem-dir-" });
        yield* fs.writeFileString(paths.join(memoryDir, "MEMORY.md"), "index line");
        const now = Date.now();
        yield* fs.utimes(paths.join(memoryDir, "MEMORY.md"), new Date(now), new Date(now - 65_000));
        yield* fs.utimes(memoryDir, new Date(now), new Date(now - 6 * 3_600_000));

        const block = yield* withIndexer(
          {
            providers: { claudeAgent: { enabled: false } },
            memorySources: [{ label: "Folder mem", path: memoryDir, projectRoot: root }],
          },
          (indexer) => indexer.injectionFor({ projectRoot: root }),
        );

        expect(block).toContain("Folder mem");
        expect(block).toContain("updated 1m ago");
        expect(block).not.toContain("updated 6h ago");
      }),
    ),
  );

  it.live("a directory source falls back to the directory mtime without MEMORY.md", () =>
    withTempDirs(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-mem-root-" });
        const memoryDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-mem-dir-" });
        const now = Date.now();
        yield* fs.utimes(memoryDir, new Date(now), new Date(now - 65_000));

        const block = yield* withIndexer(
          {
            providers: { claudeAgent: { enabled: false } },
            memorySources: [{ label: "Folder mem", path: memoryDir, projectRoot: root }],
          },
          (indexer) => indexer.injectionFor({ projectRoot: root }),
        );

        expect(block).toContain("Folder mem");
        expect(block).toContain("updated 1m ago");
      }),
    ),
  );

  it.effect("detects an existing claude auto-memory folder under a legacy homePath", () =>
    withTempDirs(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const paths = yield* Path.Path;
        const configDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-mem-config-" });
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-mem-root-" });
        const memoryFolder = yield* createClaudeMemoryFolder(fs, configDir, root);
        yield* fs.writeFileString(paths.join(memoryFolder, "MEMORY.md"), "index");

        const block = yield* withIndexer(
          { providers: { claudeAgent: { enabled: true, homePath: configDir } } },
          (indexer) => indexer.injectionFor({ projectRoot: root }),
        );

        expect(block).toBeDefined();
        expect(block).toContain("1. " + claudeConfigDirLabel(configDir));
        expect(block).toContain(memoryFolder);
      }),
    ),
  );

  it.effect("yields no detected entry for a claude config dir with no matching folder", () =>
    withTempDirs(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const configDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-mem-config-" });
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-mem-root-" });

        const folders = yield* withIndexer(
          { providers: { claudeAgent: { enabled: true, homePath: configDir } } },
          (indexer) => indexer.detectedFoldersFor({ projectRoot: root }),
        );

        expect(folders).toEqual([]);
      }),
    ),
  );

  it.effect(
    "detectedFoldersFor lists existing folders regardless of exclusions or the master switch",
    () =>
      withTempDirs(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const configDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-mem-config-" });
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-mem-root-" });
          const memoryFolder = yield* createClaudeMemoryFolder(fs, configDir, root);

          const folders = yield* withIndexer(
            {
              providers: { claudeAgent: { enabled: true, homePath: configDir } },
              memoryAutoDetect: {
                [root]: { enabled: false, excluded: [memoryFolder] },
              },
            },
            (indexer) => indexer.detectedFoldersFor({ projectRoot: root }),
          );

          expect(folders).toEqual([{ path: memoryFolder, label: claudeConfigDirLabel(configDir) }]);
        }),
      ),
  );

  it.effect("honors memoryAutoDetect disabled and per-folder exclusions in injectionFor", () =>
    withTempDirs(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const configDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-mem-config-" });
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-mem-root-" });
        const memoryFolder = yield* createClaudeMemoryFolder(fs, configDir, root);

        // Master switch off: no detected folder is injected.
        const switchedOff = yield* withIndexer(
          {
            providers: { claudeAgent: { enabled: true, homePath: configDir } },
            memoryAutoDetect: { [root]: { enabled: false } },
          },
          (indexer) => indexer.injectionFor({ projectRoot: root }),
        );
        expect(switchedOff).toBeUndefined();

        // Excluded: the detected folder is dropped while manual sources stay.
        const manualFile = yield* fs.makeTempFileScoped({ prefix: "t3-mem-manual-" });
        const excluded = yield* withIndexer(
          {
            providers: { claudeAgent: { enabled: true, homePath: configDir } },
            memoryAutoDetect: { [root]: { excluded: [memoryFolder] } },
            memorySources: [{ label: "Manual", path: manualFile, projectRoot: root }],
          },
          (indexer) => indexer.injectionFor({ projectRoot: root }),
        );
        expect(excluded).toContain("Manual");
        expect(excluded).not.toContain(memoryFolder);
      }),
    ),
  );

  it.effect("detects folders from an explicit providerInstances envelope with a displayName", () =>
    withTempDirs(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const configDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-mem-config-" });
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-mem-root-" });
        const memoryFolder = yield* createClaudeMemoryFolder(fs, configDir, root);

        const block = yield* withIndexer(
          {
            providerInstances: {
              [ProviderInstanceId.make("personal-claude")]: {
                driver: CLAUDE_AGENT_DRIVER,
                displayName: "Personal Claude",
                config: { homePath: configDir },
              },
            },
          },
          (indexer) => indexer.injectionFor({ projectRoot: root }),
        );

        expect(block).toBeDefined();
        expect(block).toContain("Personal Claude");
        expect(block).toContain(memoryFolder);
      }),
    ),
  );

  it.effect("dedupes config dirs shared by a legacy and an explicit instance", () =>
    withTempDirs(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const configDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-mem-config-" });
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-mem-root-" });
        const memoryFolder = yield* createClaudeMemoryFolder(fs, configDir, root);

        const block = yield* withIndexer(
          {
            providers: { claudeAgent: { enabled: true, homePath: configDir } },
            providerInstances: {
              [ProviderInstanceId.make("work-claude")]: {
                driver: CLAUDE_AGENT_DRIVER,
                displayName: "Work Claude",
                config: { homePath: configDir },
              },
            },
          },
          (indexer) => indexer.injectionFor({ projectRoot: root }),
        );

        expect(block).toBeDefined();
        expect(block).toContain("Work Claude");
        expect(
          block!.match(new RegExp(memoryFolder.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")),
        ).toHaveLength(1);
      }),
    ),
  );

  it.effect("yields no block for an empty project root", () =>
    withTempDirs(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        // A legacy v1 manual source (`projectRoot: ""`) would match an
        // empty-root call, so the empty-root short-circuit must return before
        // any settings read or stat of this file.
        const file = yield* fs.makeTempFileScoped({ prefix: "t3-mem-manual-" });

        const block = yield* withIndexer(
          {
            memorySources: [{ label: "Legacy", path: file, projectRoot: "", enabled: true }],
          },
          (indexer) => indexer.injectionFor({ projectRoot: "" }),
        );

        expect(block).toBeUndefined();
      }),
    ),
  );

  it.effect("skips missing paths and never fails when nothing resolves", () =>
    withTempDirs(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const paths = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-mem-root-" });
        const configDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-mem-config-" });

        const block = yield* withIndexer(
          {
            providers: { claudeAgent: { enabled: true, homePath: configDir } },
            memorySources: [
              { label: "Missing file", path: paths.join(root, "missing.md"), projectRoot: root },
            ],
          },
          (indexer) => indexer.injectionFor({ projectRoot: root }),
        );
        expect(block).toBeUndefined();

        const folders = yield* withIndexer(
          { providers: { claudeAgent: { enabled: true, homePath: configDir } } },
          (indexer) => indexer.detectedFoldersFor({ projectRoot: root }),
        );
        expect(folders).toEqual([]);
      }),
    ),
  );

  // The read-only preview RPC (`server.getDetectedMemoryFolders`) is backed by
  // `detectedFoldersPreview`, the same detection path the service method runs,
  // with the indexer resolved optionally so an absent composition answers []
  // instead of rejecting. These exercise that RPC-facing effect.
  it.effect("preview lists an existing claude auto-memory folder for a temp homePath", () =>
    withTempDirs(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const configDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-mem-config-" });
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-mem-root-" });
        const memoryFolder = yield* createClaudeMemoryFolder(fs, configDir, root);

        const folders = yield* MemorySourceIndexer.detectedFoldersPreview({
          projectRoot: root,
        }).pipe(
          Effect.provide(
            MemorySourceIndexer.layerTest({
              providers: { claudeAgent: { enabled: true, homePath: configDir } },
            }),
          ),
        );

        expect(folders).toEqual([{ path: memoryFolder, label: claudeConfigDirLabel(configDir) }]);
      }),
    ),
  );

  it.effect("preview answers [] when no matching memory folder exists", () =>
    withTempDirs(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const configDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-mem-config-" });
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-mem-root-" });

        const folders = yield* MemorySourceIndexer.detectedFoldersPreview({
          projectRoot: root,
        }).pipe(
          Effect.provide(
            MemorySourceIndexer.layerTest({
              providers: { claudeAgent: { enabled: true, homePath: configDir } },
            }),
          ),
        );

        expect(folders).toEqual([]);
      }),
    ),
  );

  it.effect("preview never rejects when the indexer is not provided", () =>
    Effect.gen(function* () {
      const folders = yield* MemorySourceIndexer.detectedFoldersPreview({
        projectRoot: "/no/matter/which/root",
      });
      expect(folders).toEqual([]);
    }),
  );

  it.effect("preview never rejects when settings carry no claude config dir", () =>
    withTempDirs(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-mem-root-" });

        const folders = yield* MemorySourceIndexer.detectedFoldersPreview({
          projectRoot: root,
        }).pipe(Effect.provide(MemorySourceIndexer.layerTest({})));

        expect(folders).toEqual([]);
      }),
    ),
  );
});
