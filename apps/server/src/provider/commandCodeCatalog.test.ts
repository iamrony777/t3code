import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as TestClock from "effect/testing/TestClock";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import type { CommandCodeModel } from "./commandCodeCli.ts";
import {
  buildCommandCodeCatalog,
  COMMAND_CODE_API_FETCH_TIMEOUT,
  COMMAND_CODE_API_MODELS_URL,
  COMMAND_CODE_EFFORT_PROBE_OUTPUT_BYTES,
  COMMAND_CODE_EFFORT_PROBE_TIMEOUT,
  commandCodeCatalogCachePath,
  createCommandCodeCatalogController,
  parseCommandCodeApiDocument,
  parseCommandCodeEffortOutput,
  type CommandCodeCatalogDependencies,
  type CommandCodeCatalogIdentity,
} from "./commandCodeCatalog.ts";

const cliModel = (slug: string, overrides: Partial<CommandCodeModel> = {}): CommandCodeModel => ({
  slug,
  name: slug,
  subProvider: "Anthropic",
  ...overrides,
});

const apiDocument = (records: ReadonlyArray<Record<string, unknown>>) =>
  JSON.stringify({ object: "list", data: records });

describe("parseCommandCodeApiDocument", () => {
  it("decodes bounded model records with Effect Schema", () => {
    expect(
      parseCommandCodeApiDocument(
        apiDocument([
          { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", context_length: 200_000 },
        ]),
      ),
    ).toEqual([{ id: "claude-haiku-4-5", name: "Claude Haiku 4.5", contextLength: 200_000 }]);
  });

  it("rejects bodies over one MiB by UTF-8 byte length", () => {
    const oversized = apiDocument([{ id: "model", name: "é".repeat(600_000), context_length: 1 }]);
    expect(parseCommandCodeApiDocument(oversized)).toBeUndefined();
  });

  it("rejects more than 500 records", () => {
    const records = Array.from({ length: 501 }, (_, index) => ({
      id: `model-${index}`,
      name: `Model ${index}`,
      context_length: 1,
    }));
    expect(parseCommandCodeApiDocument(apiDocument(records))).toBeUndefined();
  });

  it("rejects empty names and invalid context windows", () => {
    for (const record of [
      { id: "", name: "Model", context_length: 1 },
      { id: "model", name: "", context_length: 1 },
      { id: "model", name: "Model", context_length: 0 },
      { id: "model", name: "Model", context_length: 1.5 },
      { id: "model", name: "Model", context_length: 10_000_001 },
    ]) {
      expect(parseCommandCodeApiDocument(apiDocument([record]))).toBeUndefined();
    }
  });
});

describe("buildCommandCodeCatalog", () => {
  it("does not read inherited prototype keys as effort capabilities", () => {
    expect(
      buildCommandCodeCatalog(
        [cliModel("constructor"), cliModel("toString"), cliModel("__proto__")],
        [],
        {},
      ).map((model) => model.effort),
    ).toEqual([{ kind: "unknown" }, { kind: "unknown" }, { kind: "unknown" }]);
  });

  it("joins in CLI order and prefers a case-insensitive exact id", () => {
    const models = [cliModel("BETA"), cliModel("alpha")];
    const api = [
      { id: "alpha", name: "Alpha API", contextLength: 10 },
      { id: "beta", name: "Beta API", contextLength: 20 },
    ];

    expect(buildCommandCodeCatalog(models, api, {})).toEqual([
      {
        slug: "BETA",
        name: "Beta API",
        subProvider: "Anthropic",
        contextWindow: 20,
        effort: { kind: "unknown" },
      },
      {
        slug: "alpha",
        name: "Alpha API",
        subProvider: "Anthropic",
        contextWindow: 10,
        effort: { kind: "unknown" },
      },
    ]);
  });

  it("allows one dated-suffix candidate but refuses ambiguous candidates", () => {
    const api = [
      { id: "claude-haiku-4-5-20251001", name: "Dated Haiku", contextLength: 200_000 },
      { id: "claude-sonnet-4-6-20260101", name: "Sonnet A", contextLength: 200_000 },
      { id: "claude-sonnet-4-6-20260201", name: "Sonnet B", contextLength: 250_000 },
    ];

    expect(
      buildCommandCodeCatalog(
        [cliModel("claude-haiku-4-5"), cliModel("claude-sonnet-4-6")],
        api,
        {},
      ),
    ).toEqual([
      {
        slug: "claude-haiku-4-5",
        name: "Dated Haiku",
        subProvider: "Anthropic",
        contextWindow: 200_000,
        effort: { kind: "unknown" },
      },
      {
        slug: "claude-sonnet-4-6",
        name: "claude-sonnet-4-6",
        subProvider: "Anthropic",
        effort: { kind: "unknown" },
      },
    ]);
  });

  it("preserves the exact CLI slug, default, grouping, and unmatched name", () => {
    const model = cliModel("Claude-Haiku-4-5", {
      name: "CLI fallback",
      subProvider: "CLI Group",
      isDefault: true,
    });

    expect(
      buildCommandCodeCatalog(
        [model],
        [{ id: "claude-haiku-4-5", name: "API Name", contextLength: 123 }],
        { "claude-haiku-4-5": { kind: "fixed" } },
      ),
    ).toEqual([
      {
        slug: "Claude-Haiku-4-5",
        name: "API Name",
        subProvider: "CLI Group",
        isDefault: true,
        contextWindow: 123,
        effort: { kind: "fixed" },
      },
    ]);
  });
});

describe("parseCommandCodeEffortOutput", () => {
  it("parses both adjustable stderr variants", () => {
    expect(
      parseCommandCodeEffortOutput(
        'Unknown effort "__t3_invalid_effort_probe__". Supported: high, max.',
      ),
    ).toEqual({ kind: "adjustable", values: ["high", "max"] });
    expect(
      parseCommandCodeEffortOutput(
        'Unknown effort "__t3_invalid_effort_probe__". Supported: low, medium, high, xhigh, max.',
      ),
    ).toEqual({
      kind: "adjustable",
      values: ["low", "medium", "high", "xhigh", "max"],
    });
  });

  it("parses fixed effort and degrades unexpected output to unknown", () => {
    expect(parseCommandCodeEffortOutput("Kimi K3 has no adjustable reasoning effort.")).toEqual({
      kind: "fixed",
    });
    expect(parseCommandCodeEffortOutput("GPT-5.6 Sol has no adjustable reasoning effort.")).toEqual(
      { kind: "fixed" },
    );
    expect(parseCommandCodeEffortOutput("network exploded")).toEqual({ kind: "unknown" });
  });

  it("rejects malformed fixed-effort lines and trailing prose", () => {
    expect(parseCommandCodeEffortOutput("has no adjustable reasoning effort.")).toEqual({
      kind: "unknown",
    });
    expect(
      parseCommandCodeEffortOutput("Kimi K3 has no adjustable reasoning effort. trailing"),
    ).toEqual({ kind: "unknown" });
    expect(
      parseCommandCodeEffortOutput(`${"x".repeat(201)} has no adjustable reasoning effort.`),
    ).toEqual({ kind: "unknown" });
  });

  it("deduplicates safe lowercase values without inventing choices", () => {
    expect(
      parseCommandCodeEffortOutput(
        'Unknown effort "__t3_invalid_effort_probe__". Supported: high, high, medium, medium.',
      ),
    ).toEqual({ kind: "adjustable", values: ["high", "medium"] });
  });

  it("requires the exact sentinel line and safe effort tokens", () => {
    for (const output of [
      'Unknown effort "probe". Supported: high, max.',
      'Unknown effort "__t3_invalid_effort_probe__". Supported: high, max',
      'Unknown effort "__t3_invalid_effort_probe__". Supported: high, max. trailing',
      'Unknown effort "__t3_invalid_effort_probe__". Supported: HIGH, max.',
      'Unknown effort "__t3_invalid_effort_probe__". Supported: high/unsafe, max.',
    ]) {
      expect(parseCommandCodeEffortOutput(output)).toEqual({ kind: "unknown" });
    }
  });

  it("rejects oversized or excessive effort choices", () => {
    const tooLong = "x".repeat(33);
    expect(
      parseCommandCodeEffortOutput(
        `Unknown effort "__t3_invalid_effort_probe__". Supported: high, ${tooLong}.`,
      ),
    ).toEqual({ kind: "unknown" });
    expect(
      parseCommandCodeEffortOutput(
        `Unknown effort "__t3_invalid_effort_probe__". Supported: ${Array.from({ length: 11 }, (_, i) => `v${i}`).join(", ")}.`,
      ),
    ).toEqual({ kind: "unknown" });
  });
});

const identity: CommandCodeCatalogIdentity = {
  instanceId: "command-code-main",
  resolvedBinaryPath: "/opt/bin/command-code",
  cliVersion: "1.15.1",
};

const apiBody = (name = "API Model", id = "model") =>
  apiDocument([{ id, name, context_length: 200_000 }]);

const prototypeKeyCacheDocument = JSON.stringify({
  schemaVersion: 1,
  ...identity,
  apiFetchedAt: "1970-01-01T00:00:00.000Z",
  apiModels: [],
  efforts: [
    { modelKey: "constructor", capability: { kind: "fixed" } },
    { modelKey: "toString", capability: { kind: "unknown" } },
    { modelKey: "__proto__", capability: { kind: "fixed" } },
  ],
});

const atomicWriteWith =
  (fs: FileSystem.FileSystem, path: Path.Path) => (filePath: string, contents: string) =>
    writeFileStringAtomically({ filePath, contents }).pipe(
      Effect.provide(
        Layer.merge(Layer.succeed(FileSystem.FileSystem, fs), Layer.succeed(Path.Path, path)),
      ),
    );

const fsDependencies = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  cacheDir: string,
  overrides: Partial<CommandCodeCatalogDependencies<PlatformError.PlatformError | string>> = {},
): CommandCodeCatalogDependencies<PlatformError.PlatformError | string> => ({
  providerStatusCacheDir: cacheDir,
  joinPath: path.join,
  readFile: fs.readFileString,
  writeFileAtomically: atomicWriteWith(fs, path),
  fetchApiDocument: () => Effect.succeed(apiBody()),
  probeEffort: () =>
    Effect.succeed({
      exitCode: 1,
      stdout: "",
      stderr: 'Unknown effort "__t3_invalid_effort_probe__". Supported: high, max.',
    }),
  ...overrides,
});

describe("Command Code catalog cache", () => {
  it("resolves the instance-scoped provider status cache path", () => {
    expect(
      commandCodeCatalogCachePath("/cache/providers", "instance-1", (...parts) => parts.join("/")),
    ).toBe("/cache/providers/instance-1.commandcode-catalog.json");
  });

  it.effect("returns fresh cached enrichment without fetching again", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cacheDir = yield* fs.makeTempDirectoryScoped();
      let fetches = 0;
      const first = yield* createCommandCodeCatalogController(
        fsDependencies(fs, path, cacheDir, {
          fetchApiDocument: () => {
            fetches += 1;
            return Effect.succeed(apiBody("Fresh API"));
          },
        }),
      );
      yield* first.refresh(identity, [cliModel("model")]);

      const second = yield* createCommandCodeCatalogController(
        fsDependencies(fs, path, cacheDir, {
          fetchApiDocument: () => {
            fetches += 1;
            return Effect.fail("must not fetch");
          },
        }),
      );
      const catalog = yield* second.refresh(identity, [cliModel("model")]);

      expect(fetches).toBe(1);
      expect(catalog[0]?.name).toBe("Fresh API");
      expect(catalog[0]?.contextWindow).toBe(200_000);
      const current = yield* second.getCatalog();
      expect(current).toEqual(catalog);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("uses a valid stale cache indefinitely when refresh fails", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cacheDir = yield* fs.makeTempDirectoryScoped();
      const first = yield* createCommandCodeCatalogController(
        fsDependencies(fs, path, cacheDir, {
          fetchApiDocument: () => Effect.succeed(apiBody("Stale API")),
        }),
      );
      yield* first.refresh(identity, [cliModel("model")]);
      yield* TestClock.adjust(Duration.hours(25));

      const second = yield* createCommandCodeCatalogController(
        fsDependencies(fs, path, cacheDir, {
          fetchApiDocument: () => Effect.fail("offline"),
        }),
      );
      const catalog = yield* second.refresh(identity, [cliModel("model")]);

      expect(catalog[0]?.name).toBe("Stale API");
      expect(catalog[0]?.contextWindow).toBe(200_000);
    }).pipe(Effect.provide(Layer.merge(NodeServices.layer, TestClock.layer())), Effect.scoped),
  );

  it.effect("hydrates shared state from cache", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cacheDir = yield* fs.makeTempDirectoryScoped();
      const writer = yield* createCommandCodeCatalogController(
        fsDependencies(fs, path, cacheDir, {
          fetchApiDocument: () => Effect.succeed(apiBody("Hydrated API")),
        }),
      );
      yield* writer.refresh(identity, [cliModel("model")]);
      const reader = yield* createCommandCodeCatalogController(
        fsDependencies(fs, path, cacheDir, {
          fetchApiDocument: () => Effect.fail("must not fetch"),
        }),
      );

      const hydrated = yield* reader.catalogFromCache(identity, [cliModel("model")]);

      const current = yield* reader.getCatalog();
      const capability = yield* reader.getModelCapability("MODEL");
      const contextWindow = yield* reader.getModelContextWindow("MODEL");
      expect(current).toEqual(hydrated);
      expect(capability).toEqual({
        kind: "adjustable",
        values: ["high", "max"],
      });
      expect(contextWindow).toBe(200_000);
      expect(yield* reader.getModelContextWindow("missing")).toBeUndefined();
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("returns stale enrichment when an API refresh times out", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cacheDir = yield* fs.makeTempDirectoryScoped();
      const writer = yield* createCommandCodeCatalogController(
        fsDependencies(fs, path, cacheDir, {
          fetchApiDocument: () => Effect.succeed(apiBody("Stale after timeout")),
        }),
      );
      yield* writer.refresh(identity, [cliModel("model")]);
      yield* TestClock.adjust(Duration.hours(25));
      const fetchStarted = yield* Deferred.make<void>();
      const reader = yield* createCommandCodeCatalogController(
        fsDependencies(fs, path, cacheDir, {
          fetchApiDocument: () =>
            Deferred.succeed(fetchStarted, undefined).pipe(Effect.andThen(Effect.never)),
        }),
      );
      const fiber = yield* reader.refresh(identity, [cliModel("model")]).pipe(Effect.forkScoped);
      yield* Deferred.await(fetchStarted);
      yield* TestClock.adjust(COMMAND_CODE_API_FETCH_TIMEOUT);

      const catalog = yield* Fiber.join(fiber);

      expect(catalog[0]?.name).toBe("Stale after timeout");
    }).pipe(Effect.provide(Layer.merge(NodeServices.layer, TestClock.layer())), Effect.scoped),
  );

  it.effect("ignores corrupt and identity-mismatched cache documents", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cacheDir = yield* fs.makeTempDirectoryScoped();
      const target = commandCodeCatalogCachePath(cacheDir, identity.instanceId, path.join);
      yield* fs.writeFileString(target, "not-json");

      let probes = 0;
      const controller = yield* createCommandCodeCatalogController(
        fsDependencies(fs, path, cacheDir, {
          fetchApiDocument: () => Effect.succeed(apiBody("Recovered")),
          probeEffort: () => {
            probes += 1;
            return Effect.succeed({ exitCode: 1, stdout: "", stderr: "unexpected" });
          },
        }),
      );
      expect((yield* controller.refresh(identity, [cliModel("model")]))[0]?.name).toBe("Recovered");

      const changedIdentity = { ...identity, resolvedBinaryPath: "/new/command-code" };
      const invalidated = yield* controller.readCache(changedIdentity);
      expect(invalidated).toBeUndefined();
      yield* controller.refresh(changedIdentity, [cliModel("model")]);
      expect(probes).toBe(2);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("parses prototype-key effort entries as owned cache data", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cacheDir = yield* fs.makeTempDirectoryScoped();
      const target = commandCodeCatalogCachePath(cacheDir, identity.instanceId, path.join);
      yield* fs.writeFileString(target, prototypeKeyCacheDocument);
      const controller = yield* createCommandCodeCatalogController(
        fsDependencies(fs, path, cacheDir),
      );

      const cache = yield* controller.readCache(identity);

      expect(Object.hasOwn(cache?.efforts ?? {}, "constructor")).toBe(true);
      expect(Object.hasOwn(cache?.efforts ?? {}, "tostring")).toBe(true);
      expect(Object.hasOwn(cache?.efforts ?? {}, "__proto__")).toBe(true);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("skips unchanged cache writes and writes updated content", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cacheDir = yield* fs.makeTempDirectoryScoped();
      const writes: Array<{ path: string; contents: string }> = [];
      const controller = yield* createCommandCodeCatalogController(
        fsDependencies(fs, path, cacheDir, {
          fetchApiDocument: () => Effect.succeed(apiDocument([])),
          writeFileAtomically: (file, contents) => {
            writes.push({ path: file, contents });
            return atomicWriteWith(fs, path)(file, contents);
          },
        }),
      );

      yield* controller.refresh(identity, [cliModel("model-a")]);
      yield* controller.refresh(identity, [cliModel("model-a")]);
      yield* controller.refresh(identity, [cliModel("model-a"), cliModel("model-b")]);

      expect(writes).toHaveLength(2);
      expect(writes[1]?.path).toBe(controller.cachePath(identity));
      expect(writes[1]?.contents).toContain('"model-b"');
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("atomically replaces successful cache updates", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cacheDir = yield* fs.makeTempDirectoryScoped();
      let apiName = "First API";
      const controller = yield* createCommandCodeCatalogController(
        fsDependencies(fs, path, cacheDir, {
          fetchApiDocument: () => Effect.succeed(apiBody(apiName)),
        }),
      );
      yield* controller.refresh(identity, [cliModel("model")]);
      const target = controller.cachePath(identity);
      const first = yield* fs.readFileString(target);
      yield* TestClock.adjust(Duration.hours(25));
      apiName = "Replacement API";

      yield* controller.refresh(identity, [cliModel("model")]);
      const replacement = yield* fs.readFileString(target);

      expect(first).toContain("First API");
      expect(replacement).toContain("Replacement API");
      expect(replacement).not.toContain("First API");
    }).pipe(Effect.provide(Layer.merge(NodeServices.layer, TestClock.layer())), Effect.scoped),
  );

  it.effect("prunes obsolete effort entries to current CLI model keys", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cacheDir = yield* fs.makeTempDirectoryScoped();
      const controller = yield* createCommandCodeCatalogController(
        fsDependencies(fs, path, cacheDir, {
          fetchApiDocument: () => Effect.succeed(apiDocument([])),
        }),
      );
      yield* controller.refresh(identity, [cliModel("obsolete-model")]);

      yield* controller.refresh(identity, [cliModel("current-model")]);
      const contents = yield* fs.readFileString(controller.cachePath(identity));

      expect(contents).toContain("current-model");
      expect(contents).not.toContain("obsolete-model");
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("does not replace a good cache with oversized serialized content", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cacheDir = yield* fs.makeTempDirectoryScoped();
      const controller = yield* createCommandCodeCatalogController(
        fsDependencies(fs, path, cacheDir),
      );
      yield* controller.refresh(identity, [cliModel("model")]);
      const target = controller.cachePath(identity);
      const good = yield* fs.readFileString(target);
      const oversizedModels = Array.from({ length: 500 }, (_, index) =>
        cliModel(`${index}-${"x".repeat(4_300)}`),
      );

      yield* controller.refresh(identity, oversizedModels);

      const preserved = yield* fs.readFileString(target);
      expect(preserved).toBe(good);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("retains refreshed in-memory state when the atomic cache write fails", () =>
    Effect.gen(function* () {
      const controller = yield* createCommandCodeCatalogController({
        providerStatusCacheDir: "/cache",
        joinPath: (...parts) => parts.join("/"),
        readFile: () => Effect.fail("missing"),
        writeFileAtomically: () => Effect.fail("disk full"),
        fetchApiDocument: () => Effect.succeed(apiBody("In memory")),
        probeEffort: () =>
          Effect.succeed({
            exitCode: 1,
            stdout: "",
            stderr: 'Unknown effort "__t3_invalid_effort_probe__". Supported: high, max.',
          }),
      });

      const refreshed = yield* controller.refresh(identity, [cliModel("model")]);
      const current = yield* controller.getCatalog();
      const capability = yield* controller.getModelCapability("model");

      expect(refreshed[0]?.name).toBe("In memory");
      expect(current).toEqual(refreshed);
      expect(capability).toEqual({
        kind: "adjustable",
        values: ["high", "max"],
      });
    }),
  );

  it.effect("falls back to same-identity memory after a cache write failure", () =>
    Effect.gen(function* () {
      let reads = 0;
      let fetches = 0;
      let probes = 0;
      const controller = yield* createCommandCodeCatalogController({
        providerStatusCacheDir: "/cache",
        joinPath: (...parts) => parts.join("/"),
        readFile: () => {
          reads += 1;
          return reads === 1 ? Effect.fail("missing") : Effect.succeed("{corrupt");
        },
        writeFileAtomically: () => Effect.fail("disk full"),
        fetchApiDocument: () => {
          fetches += 1;
          return fetches === 1 ? Effect.succeed(apiBody("Remembered API")) : Effect.fail("offline");
        },
        probeEffort: () => {
          probes += 1;
          return probes === 1
            ? Effect.succeed({
                exitCode: 1,
                stdout: "",
                stderr: 'Unknown effort "__t3_invalid_effort_probe__". Supported: high, max.',
              })
            : Effect.fail("probe unavailable");
        },
      });
      yield* controller.refresh(identity, [cliModel("model")]);
      yield* TestClock.adjust(Duration.hours(25));

      const catalog = yield* controller.refresh(identity, [
        cliModel("model"),
        cliModel("new-model"),
      ]);

      expect(fetches).toBe(2);
      expect(probes).toBe(2);
      expect(catalog[0]?.name).toBe("Remembered API");
      expect(catalog[0]?.effort.kind).toBe("adjustable");
      expect(catalog[1]?.effort).toEqual({ kind: "unknown" });
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("prefers newer same-identity memory over an older valid disk cache", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cacheDir = yield* fs.makeTempDirectoryScoped();
      let fetches = 0;
      let writesFail = false;
      const controller = yield* createCommandCodeCatalogController(
        fsDependencies(fs, path, cacheDir, {
          writeFileAtomically: (file, contents) =>
            writesFail ? Effect.fail("disk full") : atomicWriteWith(fs, path)(file, contents),
          fetchApiDocument: () => {
            fetches += 1;
            if (fetches === 1) return Effect.succeed(apiBody("Disk API A"));
            if (fetches === 2) return Effect.succeed(apiBody("Memory API B"));
            return Effect.fail("offline");
          },
        }),
      );
      yield* controller.refresh(identity, [cliModel("model")]);
      const target = controller.cachePath(identity);
      yield* TestClock.adjust(Duration.hours(25));
      writesFail = true;

      const updated = yield* controller.refresh(identity, [cliModel("model")]);
      const hydrated = yield* controller.catalogFromCache(identity, [cliModel("model")]);
      yield* TestClock.adjust(Duration.hours(25));
      const offline = yield* controller.refresh(identity, [cliModel("model")]);
      const disk = yield* fs.readFileString(target);

      expect(fetches).toBe(3);
      expect(updated[0]?.name).toBe("Memory API B");
      expect(hydrated[0]?.name).toBe("Memory API B");
      expect(offline[0]?.name).toBe("Memory API B");
      expect(disk).toContain("Disk API A");
      expect(disk).not.toContain("Memory API B");
    }).pipe(Effect.provide(Layer.merge(NodeServices.layer, TestClock.layer())), Effect.scoped),
  );

  it.effect("does not reuse in-memory cache across identities", () =>
    Effect.gen(function* () {
      let firstFetch = true;
      const controller = yield* createCommandCodeCatalogController({
        providerStatusCacheDir: "/cache",
        joinPath: (...parts) => parts.join("/"),
        readFile: () => Effect.fail("missing"),
        writeFileAtomically: () => Effect.fail("disk full"),
        fetchApiDocument: () => {
          if (firstFetch) {
            firstFetch = false;
            return Effect.succeed(apiBody("Identity A API"));
          }
          return Effect.fail("offline");
        },
        probeEffort: () => Effect.fail("probe unavailable"),
      });
      yield* controller.refresh(identity, [cliModel("model")]);

      const catalog = yield* controller.refresh(
        { ...identity, resolvedBinaryPath: "/different/command-code" },
        [cliModel("model")],
      );

      expect(catalog[0]?.name).toBe("model");
      expect(catalog[0]?.contextWindow).toBeUndefined();
    }),
  );
});

describe("Command Code catalog refresh", () => {
  it.effect("retries a model after a non-1 probe exit", () =>
    Effect.gen(function* () {
      let probes = 0;
      const controller = yield* createCommandCodeCatalogController({
        providerStatusCacheDir: "/cache",
        joinPath: (...parts) => parts.join("/"),
        readFile: () => Effect.fail("missing"),
        writeFileAtomically: () => Effect.void,
        fetchApiDocument: () => Effect.succeed(apiDocument([])),
        probeEffort: () => {
          probes += 1;
          return Effect.succeed({
            exitCode: probes === 1 ? 0 : 1,
            stdout: "",
            stderr: 'Unknown effort "__t3_invalid_effort_probe__". Supported: low, high.',
          });
        },
      });

      const first = yield* controller.refresh(identity, [cliModel("model")]);
      const second = yield* controller.refresh(identity, [cliModel("model")]);

      expect(probes).toBe(2);
      expect(first[0]?.effort).toEqual({ kind: "unknown" });
      expect(second[0]?.effort).toEqual({
        kind: "adjustable",
        values: ["low", "high"],
      });
    }),
  );

  it.effect("probes and caches prototype-key model slugs as owned entries", () =>
    Effect.gen(function* () {
      const probed: string[] = [];
      const controller = yield* createCommandCodeCatalogController({
        providerStatusCacheDir: "/cache",
        joinPath: (...parts) => parts.join("/"),
        readFile: () => Effect.fail("missing"),
        writeFileAtomically: () => Effect.void,
        fetchApiDocument: () => Effect.succeed(apiDocument([])),
        probeEffort: (input) => {
          probed.push(input.args[1]!);
          return Effect.succeed({
            exitCode: 1,
            stdout: "",
            stderr: 'Unknown effort "__t3_invalid_effort_probe__". Supported: low, high.',
          });
        },
      });
      const slugs = ["constructor", "toString", "__proto__"];

      const catalog = yield* controller.refresh(
        identity,
        slugs.map((slug) => cliModel(slug)),
      );

      expect(probed).toEqual(slugs);
      expect(catalog.map((model) => model.effort)).toEqual(
        slugs.map(() => ({ kind: "adjustable", values: ["low", "high"] })),
      );
    }),
  );

  it.effect("never discovers effort capability from stdout", () =>
    Effect.gen(function* () {
      const controller = yield* createCommandCodeCatalogController({
        providerStatusCacheDir: "/cache",
        joinPath: (...parts) => parts.join("/"),
        readFile: () => Effect.fail("missing"),
        writeFileAtomically: () => Effect.void,
        fetchApiDocument: () => Effect.succeed(apiDocument([])),
        probeEffort: () =>
          Effect.succeed({
            exitCode: 1,
            stdout: 'Unknown effort "probe". Supported: low, high.',
            stderr: "unrecognized stderr",
          }),
      });

      const catalog = yield* controller.refresh(identity, [cliModel("model")]);

      expect(catalog[0]?.effort).toEqual({ kind: "unknown" });
    }),
  );

  it.effect("probes only missing normalized model keys with the no-request argv", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cacheDir = yield* fs.makeTempDirectoryScoped();
      const inputs: Parameters<CommandCodeCatalogDependencies<never>["probeEffort"]>[0][] = [];
      const fetchInputs: Parameters<
        CommandCodeCatalogDependencies<never>["fetchApiDocument"]
      >[0][] = [];
      const controller = yield* createCommandCodeCatalogController(
        fsDependencies(fs, path, cacheDir, {
          fetchApiDocument: (input) => {
            fetchInputs.push(input);
            return Effect.succeed(apiDocument([]));
          },
          probeEffort: (input) => {
            inputs.push(input);
            return Effect.succeed({
              exitCode: 1,
              stdout: "",
              stderr: 'Unknown effort "probe". Supported: low, high.',
            });
          },
        }),
      );

      yield* controller.refresh(identity, [cliModel("MODEL-A"), cliModel("model-b")]);
      yield* controller.refresh(identity, [
        cliModel("model-a"),
        cliModel("MODEL-B"),
        cliModel("model-c"),
      ]);

      expect(inputs).toHaveLength(3);
      expect(fetchInputs).toEqual([
        { url: COMMAND_CODE_API_MODELS_URL, maxBodyBytes: 1024 * 1024 },
      ]);
      expect(inputs[2]).toEqual({
        executable: identity.resolvedBinaryPath,
        args: ["--model", "model-c", "--effort", "__t3_invalid_effort_probe__", "--no-auto-update"],
        stdin: "closed",
        maxStdoutBytes: COMMAND_CODE_EFFORT_PROBE_OUTPUT_BYTES,
        maxStderrBytes: COMMAND_CODE_EFFORT_PROBE_OUTPUT_BYTES,
      });
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("caps effort probe concurrency at four without sleeps", () =>
    Effect.gen(function* () {
      const fourStarted = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let active = 0;
      let maximum = 0;
      const controller = yield* createCommandCodeCatalogController({
        providerStatusCacheDir: "/cache",
        joinPath: (...parts) => parts.join("/"),
        readFile: () => Effect.fail("missing"),
        writeFileAtomically: () => Effect.void,
        fetchApiDocument: () => Effect.succeed(apiDocument([])),
        probeEffort: () =>
          Effect.acquireUseRelease(
            Effect.gen(function* () {
              active += 1;
              maximum = Math.max(maximum, active);
              if (active === 4) yield* Deferred.succeed(fourStarted, undefined);
            }),
            () =>
              Deferred.await(release).pipe(
                Effect.as({ exitCode: 1, stdout: "", stderr: "unexpected" }),
              ),
            () => Effect.sync(() => void (active -= 1)),
          ),
      });
      const models = Array.from({ length: 7 }, (_, index) => cliModel(`model-${index}`));
      const fiber = yield* controller.refresh(identity, models).pipe(Effect.forkScoped);

      yield* Deferred.await(fourStarted);
      expect(active).toBe(4);
      expect(maximum).toBe(4);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(fiber);
      expect(maximum).toBe(4);
    }),
  );

  it.effect("bounds unique effort probes to 500 per refresh", () =>
    Effect.gen(function* () {
      let probes = 0;
      const controller = yield* createCommandCodeCatalogController({
        providerStatusCacheDir: "/cache",
        joinPath: (...parts) => parts.join("/"),
        readFile: () => Effect.fail("missing"),
        writeFileAtomically: () => Effect.void,
        fetchApiDocument: () => Effect.succeed(apiDocument([])),
        probeEffort: () => {
          probes += 1;
          return Effect.succeed({
            exitCode: 1,
            stdout: "",
            stderr: 'Unknown effort "__t3_invalid_effort_probe__". Supported: high, max.',
          });
        },
      });
      const models = Array.from({ length: 503 }, (_, index) => cliModel(`model-${index}`));

      const catalog = yield* controller.refresh(identity, models);

      expect(probes).toBe(500);
      expect(catalog).toHaveLength(503);
      expect(catalog[499]?.effort.kind).toBe("adjustable");
      expect(catalog[500]?.effort).toEqual({ kind: "unknown" });
    }),
  );

  it.effect("times out probes after five seconds through TestClock", () =>
    Effect.gen(function* () {
      const controller = yield* createCommandCodeCatalogController({
        providerStatusCacheDir: "/cache",
        joinPath: (...parts) => parts.join("/"),
        readFile: () => Effect.fail("missing"),
        writeFileAtomically: () => Effect.void,
        fetchApiDocument: () => Effect.succeed(apiDocument([])),
        probeEffort: () => Effect.never,
      });
      const fiber = yield* controller
        .refresh(identity, [cliModel("model")])
        .pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* TestClock.adjust(COMMAND_CODE_EFFORT_PROBE_TIMEOUT);
      const catalog = yield* Fiber.join(fiber);
      const capability = yield* controller.getModelCapability("MODEL");
      const missing = yield* controller.getModelCapability("missing");

      expect(catalog[0]?.effort).toEqual({ kind: "unknown" });
      expect(capability).toEqual({ kind: "unknown" });
      expect(missing).toBeUndefined();
    }).pipe(Effect.provide(TestClock.layer())),
  );
});
