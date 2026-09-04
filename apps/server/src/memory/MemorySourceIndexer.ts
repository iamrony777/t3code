/**
 * MemorySourceIndexer - background service that keeps a freshness manifest of
 * the user's configured memory sources.
 *
 * The sweep runs every 60s (same pattern as ThreadSettlementReactor) and
 * `stat()`s global sources only — file content is never read. Project-scoped
 * sources are resolved per thread and stat'd on demand by `injectionFor`.
 * Injection is hash-deduped per thread, so a turn only carries a new block
 * when the manifest changed since the thread's last injection.
 *
 * @module MemorySourceIndexer
 */
import { NodeServices } from "@effect/platform-node";
import type { MemorySourceEntry } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as NodeCrypto from "node:crypto";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import { assembleMemoryBlock, type ResolvedMemoryEntry } from "./memoryManifest.ts";

const SWEEP_INTERVAL = "60 seconds" as const;

interface InjectionState {
  readonly globalStats: ReadonlyMap<string, number | null>;
}

interface InjectionInput {
  readonly threadId: string;
  readonly projectRoot: string;
  readonly sessionStart: boolean;
}

export class MemorySourceIndexer extends Context.Service<
  MemorySourceIndexer,
  {
    start: Effect.Effect<void, never, Scope.Scope>;
    sweepNow: Effect.Effect<ReadonlyMap<string, number | null>>;
    /**
     * The block to inject, or undefined when it is unchanged since the
     * thread's last injection. `sessionStart` always yields the current block
     * and never records the hash, so adapters that consume the block on the
     * first turn still see it. Never fails: stat or settings failures yield
     * no block rather than an error.
     */
    injectionFor: (input: InjectionInput) => Effect.Effect<string | undefined, never>;
  }
>()("t3/memory/MemorySourceIndexer") {}

const make = Effect.gen(function* () {
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  const stateRef = yield* Ref.make<InjectionState>({ globalStats: new Map() });
  const threadHashes = yield* Ref.make<Map<string, string>>(new Map());

  /** Stat mtime in epoch milliseconds, or null when the path is not a file. */
  const statPath = (path: string): Effect.Effect<number | null> =>
    fs.stat(path).pipe(
      Effect.map((info) =>
        info.type === "File"
          ? Option.getOrNull(Option.map(info.mtime, (mtime) => mtime.getTime()))
          : null,
      ),
      Effect.orElseSucceed(() => null),
    );

  const sweepNow = Effect.gen(function* () {
    const settings = yield* settingsService.getSettings;
    const stats = new Map<string, number | null>();
    yield* Effect.forEach(
      settings.memorySources,
      (entry) =>
        Effect.gen(function* () {
          if (!entry.enabled || entry.scope !== "global") return;
          stats.set(entry.path, yield* statPath(entry.path));
        }),
      { discard: true },
    );
    yield* Ref.set(stateRef, { globalStats: stats });
    return stats;
  }).pipe(Effect.orElseSucceed(() => new Map<string, number | null>()));

  const injectionFor = ({ threadId, projectRoot, sessionStart }: InjectionInput) =>
    Effect.gen(function* () {
      const settings = yield* settingsService.getSettings.pipe(
        Effect.orElseSucceed(() => undefined),
      );
      if (settings === undefined) return undefined;
      const { globalStats } = yield* Ref.get(stateRef);
      const projectRootProvided = projectRoot.trim().length > 0;
      const entries = yield* Effect.forEach(settings.memorySources, (entry) =>
        Effect.gen(function* () {
          if (!entry.enabled) return [];
          if (entry.scope === "global") {
            const updatedAtMs = globalStats.has(entry.path)
              ? (globalStats.get(entry.path) ?? null)
              : yield* statPath(entry.path);
            if (updatedAtMs === null) return [];
            return [
              {
                label: entry.label,
                path: entry.path,
                harness: entry.harness,
                updatedAtMs,
              } satisfies ResolvedMemoryEntry,
            ];
          }
          if (!projectRootProvided) return [];
          const path = paths.join(projectRoot, entry.path);
          const updatedAtMs = yield* statPath(path);
          if (updatedAtMs === null) return [];
          return [
            {
              label: entry.label,
              path,
              harness: entry.harness,
              updatedAtMs,
            } satisfies ResolvedMemoryEntry,
          ];
        }),
      ).pipe(Effect.map((groups) => groups.flat()));
      const block = assembleMemoryBlock({ entries, nowMs: yield* Clock.currentTimeMillis });
      if (block === null) return undefined;
      if (!sessionStart) {
        const hash = NodeCrypto.createHash("sha256").update(block).digest("hex");
        const recorded = yield* Ref.get(threadHashes);
        if (recorded.get(threadId) === hash) return undefined;
        yield* Ref.set(threadHashes, new Map(recorded).set(threadId, hash));
      }
      return block;
    });

  const start = forkParked(
    sweepNow.pipe(Effect.repeat(Schedule.spaced(SWEEP_INTERVAL)), Effect.asVoid),
  );

  return { start, sweepNow, injectionFor } satisfies MemorySourceIndexer["Service"];
});

export const layer = Layer.effect(MemorySourceIndexer, make);

/** Test layer with a fixed source list. */
export const layerTest = (sources: ReadonlyArray<MemorySourceEntry>) =>
  layer.pipe(
    Layer.provide(ServerSettings.layerTest({ memorySources: sources })),
    Layer.provideMerge(NodeServices.layer),
  );
