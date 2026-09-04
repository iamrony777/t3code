import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as NodeOS from "node:os";
import * as Path from "effect/Path";

import * as MemorySourceIndexer from "./MemorySourceIndexer.ts";

const MEMORY_FILE = `${NodeOS.tmpdir()}/t3-memory-source-test-${process.pid}-${Date.now()}.md`;
const MISSING_FILE = `${NodeOS.tmpdir()}/t3-memory-missing-${process.pid}-${Date.now()}.md`;

const sources = [
  { label: "Claude memory", path: MEMORY_FILE, scope: "global" as const, enabled: true },
  { label: "Lost memory", path: MISSING_FILE, scope: "global" as const, enabled: true },
  { label: "Disabled memory", path: MEMORY_FILE, scope: "global" as const, enabled: false },
];

describe("MemorySourceIndexer", () => {
  it.effect("sweepNow stats existing sources and reports missing ones as null", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(MEMORY_FILE, "prod db access");
      const indexer = yield* MemorySourceIndexer.MemorySourceIndexer;
      const manifest = yield* indexer.sweepNow;
      expect(manifest.get(MEMORY_FILE)).not.toBeNull();
      expect(manifest.get(MISSING_FILE)).toBeNull();
    }).pipe(Effect.provide(MemorySourceIndexer.layerTest(sources))),
  );

  it.effect("injectionFor excludes missing and disabled sources and always yields the block", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(MEMORY_FILE, "prod db access");
      const indexer = yield* MemorySourceIndexer.MemorySourceIndexer;
      yield* indexer.sweepNow;

      const first = yield* indexer.injectionFor({ projectRoot: "/unused" });
      expect(first).toContain("1. Claude memory");
      expect(first).toContain(MEMORY_FILE);
      expect(first).not.toContain("Lost memory"); // missing paths are excluded
      expect(first).not.toContain("Disabled memory");

      // Every injection yields the same current block.
      const turn = yield* indexer.injectionFor({ projectRoot: "/unused" });
      expect(turn).toBe(first);
      const again = yield* indexer.injectionFor({ projectRoot: "/unused" });
      expect(again).toBe(first);
    }).pipe(Effect.provide(MemorySourceIndexer.layerTest(sources))),
  );

  it.effect("the block stays stable across repeated injections and sweeps", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(MEMORY_FILE, "prod db access");
      const indexer = yield* MemorySourceIndexer.MemorySourceIndexer;
      yield* indexer.sweepNow;

      const first = yield* indexer.injectionFor({ projectRoot: "/unused" });
      expect(first).toContain("1. Claude memory");

      // Repeated injections, with and without an intervening sweep, always
      // yield the same block.
      const turn = yield* indexer.injectionFor({ projectRoot: "/unused" });
      expect(turn).toBe(first);
      yield* indexer.sweepNow;
      const afterSweep = yield* indexer.injectionFor({ projectRoot: "/unused" });
      expect(afterSweep).toBe(first);
    }).pipe(Effect.provide(MemorySourceIndexer.layerTest(sources))),
  );

  it.effect("project-scoped sources resolve against the project root", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({
        directory: NodeOS.tmpdir(),
        prefix: "t3-memory-project-",
      });
      yield* fs.writeFileString(paths.join(root, "taste.md"), "commandcode taste");
      const indexer = yield* MemorySourceIndexer.MemorySourceIndexer;
      const block = yield* indexer.injectionFor({
        projectRoot: root,
      });
      expect(block).toContain("CommandCode taste");
      expect(block).toContain(paths.join(root, "taste.md"));
    }).pipe(
      Effect.scoped,
      Effect.provide(
        MemorySourceIndexer.layerTest([
          { label: "CommandCode taste", path: "taste.md", scope: "project", enabled: true },
        ]),
      ),
    ),
  );
});
