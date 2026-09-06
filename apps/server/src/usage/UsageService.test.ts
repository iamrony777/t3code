// @effect-diagnostics nodeBuiltinImport:off - the suite seeds and grows real
// transcript trees on disk, outside the service's Effect FileSystem.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import {
  ProviderInstanceId,
  UsageDay,
  UsageProviderKind,
  UsageSourceId,
  type UsageSummaryInput,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Scheduler from "effect/Scheduler";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as UsageService from "./UsageService.ts";

function claudeLine(id: number, outputTokens: number, model = "claude-fable-5"): string {
  return `${JSON.stringify({
    type: "assistant",
    timestamp: "2026-08-01T10:00:00Z",
    requestId: `req_${id}`,
    sessionId: "session-1",
    message: {
      id: `msg_${id}`,
      model,
      usage: { input_tokens: 10, output_tokens: outputTokens },
    },
  })}\n`;
}

function commandCodeLine(outputTokens: number): string {
  return `${JSON.stringify({
    type: "message",
    id: "command-message",
    timestamp: "2026-08-01T10:00:00Z",
    message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
    usage: {
      inputTokens: 20,
      outputTokens,
      cacheReadTokens: 5,
      cacheWriteTokens: 0,
      costUsd: 0.01,
    },
    model: "command/model",
  })}\n`;
}

function grokLine(outputTokens: number): string {
  return `${JSON.stringify({
    method: "_x.ai/session/update",
    params: {
      sessionId: "grok-session",
      update: {
        sessionUpdate: "turn_completed",
        prompt_id: "prompt-1",
        usage: { inputTokens: 20, outputTokens, cachedReadTokens: 5 },
      },
      _meta: { agentTimestampMs: Date.parse("2026-08-01T10:00:00Z") },
    },
  })}\n`;
}

const WINDOW: UsageSummaryInput = {
  timeZone: "UTC",
  sinceDay: UsageDay.make("2026-07-31"),
  untilDay: UsageDay.make("2026-08-02"),
};

const setup = Effect.gen(function* () {
  const home = yield* Effect.promise(() =>
    NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "usage-service-test-")),
  );
  yield* Effect.addFinalizer(() =>
    Effect.promise(() => NodeFSP.rm(home, { recursive: true, force: true })),
  );
  const transcriptDir = NodePath.join(home, "claude", "projects", "proj");
  yield* Effect.promise(() => NodeFSP.mkdir(transcriptDir, { recursive: true }));
  return {
    home,
    transcript: NodePath.join(transcriptDir, "session.jsonl"),
    settings: {
      providers: {
        claudeAgent: { homePath: NodePath.join(home, "claude") },
        codex: { homePath: NodePath.join(home, "codex") },
      },
    },
  };
});

const serviceLayers = (input: {
  readonly prefix: string;
  readonly home: string;
  readonly settings: Parameters<typeof ServerSettings.layerTest>[0];
  readonly onRatesFetch?: () => void;
  readonly hostEnvironment?: NodeJS.ProcessEnv;
  /** Defaults to an unparsable document so every scan retries the fetch. */
  readonly ratesDocument?: unknown;
}) =>
  ServerConfig.layerTest(process.cwd(), { prefix: input.prefix }).pipe(
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(ServerSettings.layerTest(input.settings)),
    Layer.provideMerge(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.sync(() => {
            input.onRatesFetch?.();
            // Unparsable rates: every scan retries the fetch, which makes the
            // fetch count a boundary-level observation of how many scans ran.
            return HttpClientResponse.fromWeb(request, Response.json(input.ratesDocument ?? {}));
          }),
        ),
      ),
    ),
    Layer.provideMerge(
      Layer.succeed(HostProcessEnvironment, {
        HOME: NodePath.join(input.home, "host"),
        GROK_HOME: NodePath.join(input.home, "grok"),
        ...input.hostEnvironment,
      }),
    ),
  );

function totalOutputTokens(summary: { buckets: readonly { totals: { outputTokens: number } }[] }) {
  return summary.buckets.reduce((sum, bucket) => sum + bucket.totals.outputTokens, 0);
}

describe("UsageService", () => {
  it.live("scans projects directly under an explicit Claude config directory", () =>
    Effect.gen(function* () {
      const { settings, home } = yield* setup;
      const configDir = settings.providers.claudeAgent.homePath;
      const directTranscript = NodePath.join(configDir, "projects", "direct", "session.jsonl");
      const nestedTranscript = NodePath.join(
        configDir,
        ".claude",
        "projects",
        "nested",
        "session.jsonl",
      );
      yield* Effect.promise(() =>
        NodeFSP.mkdir(NodePath.dirname(directTranscript), { recursive: true }),
      );
      yield* Effect.promise(() =>
        NodeFSP.mkdir(NodePath.dirname(nestedTranscript), { recursive: true }),
      );
      yield* Effect.promise(() => NodeFSP.writeFile(directTranscript, claudeLine(1, 5)));
      yield* Effect.promise(() => NodeFSP.writeFile(nestedTranscript, claudeLine(2, 99)));

      const service = yield* UsageService.make.pipe(
        Effect.provide(
          serviceLayers({ prefix: "usage-service-explicit-claude-home-test", home, settings }),
        ),
      );
      const summary = yield* service.readSummary(WINDOW);
      const claudeSource = summary.sources.find(
        (source) => source.fingerprint.provider === "claude",
      );

      assert.strictEqual(
        claudeSource?.fingerprint.resolvedHomePath,
        NodePath.join(configDir, "projects"),
      );
      assert.strictEqual(totalOutputTokens(summary), 5);
    }).pipe(Effect.scoped),
  );

  it.live("preserves ambient CLAUDE_CONFIG_DIR path semantics", () =>
    Effect.gen(function* () {
      const { settings, home } = yield* setup;
      const ambientConfigDir = `~/usage-service-ambient-${NodePath.basename(home)}`;
      const configured = {
        ...settings,
        providerInstances: {
          claudeAgent: {
            driver: "claudeAgent",
            config: {},
          },
        },
      } as const;
      const service = yield* UsageService.make.pipe(
        Effect.provide(
          serviceLayers({
            prefix: "usage-service-ambient-claude-home-test",
            home,
            settings: configured,
            hostEnvironment: { CLAUDE_CONFIG_DIR: ambientConfigDir },
          }),
        ),
      );
      const summary = yield* service.readSummary(WINDOW);
      const claudeSource = summary.sources.find(
        (source) => source.fingerprint.provider === "claude",
      );

      assert.strictEqual(
        claudeSource?.fingerprint.resolvedHomePath,
        NodePath.resolve(ambientConfigDir, "projects"),
      );
    }).pipe(Effect.scoped),
  );

  it.live("scans symlink aliases of one Command Code transcript directory once", () =>
    Effect.gen(function* () {
      const { settings, home } = yield* setup;
      const physicalHome = NodePath.join(home, "command-physical");
      const aliasHome = NodePath.join(home, "command-alias");
      const transcript = NodePath.join(
        physicalHome,
        ".commandcode",
        "projects",
        "command",
        "session.jsonl",
      );
      yield* Effect.promise(() => NodeFSP.mkdir(NodePath.dirname(transcript), { recursive: true }));
      yield* Effect.promise(() => NodeFSP.writeFile(transcript, commandCodeLine(13)));
      yield* Effect.promise(() => NodeFSP.symlink(physicalHome, aliasHome, "dir"));

      const configured = {
        ...settings,
        providerInstances: {
          commandcode: {
            driver: "commandcode",
            displayName: "Canonical",
            environment: [{ name: "HOME", value: physicalHome, sensitive: false }],
            config: {},
          },
          command_alias: {
            driver: "commandcode",
            displayName: "Alias",
            environment: [{ name: "HOME", value: aliasHome, sensitive: false }],
            config: {},
          },
        },
      } as const;
      const service = yield* UsageService.make.pipe(
        Effect.provide(
          serviceLayers({ prefix: "usage-service-command-alias-test", home, settings: configured }),
        ),
      );
      const summary = yield* service.readSummary({
        ...WINDOW,
        supportedProviders: ["commandcode"],
      });

      assert.strictEqual(summary.sources.length, 1);
      assert.strictEqual(summary.sources[0]?.sourceId, UsageSourceId.make("command_alias"));
      assert.strictEqual(
        summary.sources[0]?.fingerprint.resolvedHomePath,
        yield* Effect.promise(() =>
          NodeFSP.realpath(NodePath.join(aliasHome, ".commandcode", "projects")),
        ),
      );
      assert.strictEqual(totalOutputTokens(summary), 13);
    }).pipe(Effect.scoped),
  );

  it.live("hydrates instance transcript sources and negotiates emitted providers", () =>
    Effect.gen(function* () {
      const home = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "usage-service-instances-test-")),
      );
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => NodeFSP.rm(home, { recursive: true, force: true })),
      );

      const legacyClaudeHome = NodePath.join(home, "claude-legacy");
      const sharedClaudeHome = NodePath.join(home, "claude-shared");
      const envClaudeHome = NodePath.join(home, "claude-env");
      const commandHome = NodePath.join(home, "command-home");
      const transcriptFiles = [
        [NodePath.join(legacyClaudeHome, "projects", "legacy", "session.jsonl"), claudeLine(1, 5)],
        [NodePath.join(sharedClaudeHome, "projects", "shared", "session.jsonl"), claudeLine(2, 7)],
        [NodePath.join(envClaudeHome, "projects", "env", "session.jsonl"), claudeLine(3, 11)],
        [
          NodePath.join(commandHome, ".commandcode", "projects", "command", "session.jsonl"),
          commandCodeLine(13),
        ],
        [NodePath.join(home, "grok", "sessions", "grok-session", "updates.jsonl"), grokLine(17)],
      ] as const;
      for (const [file, contents] of transcriptFiles) {
        yield* Effect.promise(() => NodeFSP.mkdir(NodePath.dirname(file), { recursive: true }));
        yield* Effect.promise(() => NodeFSP.writeFile(file, contents));
      }
      const settings = {
        providers: {
          claudeAgent: { homePath: legacyClaudeHome },
          codex: { homePath: NodePath.join(home, "codex") },
        },
        providerInstances: {
          claude_z_duplicate: {
            driver: "claudeAgent",
            displayName: "Duplicate",
            config: { homePath: sharedClaudeHome },
          },
          claude_a_canonical: {
            driver: "claudeAgent",
            displayName: "Work",
            accentColor: "#123456",
            enabled: false,
            config: { homePath: sharedClaudeHome },
          },
          claude_env: {
            driver: "claudeAgent",
            displayName: "Environment",
            environment: [{ name: "CLAUDE_CONFIG_DIR", value: envClaudeHome, sensitive: false }],
            config: {},
          },
          command_work: {
            driver: "commandcode",
            displayName: "Command Work",
            enabled: false,
            environment: [{ name: "HOME", value: commandHome, sensitive: false }],
            config: {},
          },
          command_z_duplicate: {
            driver: "commandcode",
            displayName: "Command Duplicate",
            environment: [{ name: "HOME", value: commandHome, sensitive: false }],
            config: {},
          },
        },
      } as const;

      const service = yield* UsageService.make.pipe(
        Effect.provide(serviceLayers({ prefix: "usage-service-instances-test", home, settings })),
      );

      const legacy = yield* service.readSummary(WINDOW);
      assert.deepStrictEqual(
        [...new Set(legacy.sources.map((source) => source.fingerprint.provider))].sort(),
        ["claude", "codex"],
      );
      assert.deepStrictEqual([...new Set(legacy.buckets.map((bucket) => bucket.provider))].sort(), [
        "claude",
      ]);

      const negotiated = yield* service.readSummary({
        ...WINDOW,
        supportedProviders: [...UsageProviderKind.literals],
      });
      assert.deepStrictEqual(
        [...new Set(negotiated.sources.map((source) => source.fingerprint.provider))].sort(),
        ["claude", "codex", "commandcode", "grok"],
      );
      assert.deepStrictEqual(
        [...new Set(negotiated.buckets.map((bucket) => bucket.provider))].sort(),
        ["claude", "commandcode", "grok"],
      );

      const claudeSources = negotiated.sources.filter(
        (source) => source.fingerprint.provider === "claude",
      );
      assert.strictEqual(claudeSources.length, 3);
      assert.deepStrictEqual(
        claudeSources
          .map((source) => ({
            sourceId: source.sourceId,
            instanceId: source.profile?.instanceId,
            displayName: source.profile?.displayName,
            accentColor: source.profile?.accentColor,
            path: source.fingerprint.resolvedHomePath,
          }))
          .sort((left, right) => String(left.sourceId).localeCompare(String(right.sourceId))),
        [
          {
            sourceId: UsageSourceId.make("claude_a_canonical"),
            instanceId: ProviderInstanceId.make("claude_a_canonical"),
            displayName: "Work",
            accentColor: "#123456",
            path: NodePath.join(sharedClaudeHome, "projects"),
          },
          {
            sourceId: UsageSourceId.make("claude_env"),
            instanceId: ProviderInstanceId.make("claude_env"),
            displayName: "Environment",
            accentColor: undefined,
            path: NodePath.join(envClaudeHome, "projects"),
          },
          {
            sourceId: UsageSourceId.make("claudeAgent"),
            instanceId: ProviderInstanceId.make("claudeAgent"),
            displayName: undefined,
            accentColor: undefined,
            path: NodePath.join(legacyClaudeHome, "projects"),
          },
        ],
      );

      const commandSources = negotiated.sources.filter(
        (source) => source.fingerprint.provider === "commandcode",
      );
      assert.deepStrictEqual(
        commandSources.map((source) => ({
          sourceId: source.sourceId,
          instanceId: source.profile?.instanceId,
          displayName: source.profile?.displayName,
        })),
        [
          {
            sourceId: UsageSourceId.make("command_work"),
            instanceId: ProviderInstanceId.make("command_work"),
            displayName: "Command Work",
          },
          {
            sourceId: UsageSourceId.make("commandcode"),
            instanceId: ProviderInstanceId.make("commandcode"),
            displayName: undefined,
          },
        ],
      );
      assert.deepStrictEqual(
        negotiated.buckets.map((bucket) => [bucket.provider, bucket.sourceId]),
        [
          ["claude", UsageSourceId.make("claude_a_canonical")],
          ["claude", UsageSourceId.make("claude_env")],
          ["claude", UsageSourceId.make("claudeAgent")],
          ["commandcode", UsageSourceId.make("command_work")],
          ["grok", undefined],
        ],
      );
    }).pipe(Effect.scoped),
  );

  it.live("shares an in-flight scan across provider negotiations and projects each response", () =>
    Effect.gen(function* () {
      const { settings, home } = yield* setup;
      const commandTranscript = NodePath.join(
        home,
        "host",
        ".commandcode",
        "projects",
        "command",
        "session.jsonl",
      );
      yield* Effect.promise(() =>
        NodeFSP.mkdir(NodePath.dirname(commandTranscript), { recursive: true }),
      );
      yield* Effect.promise(() => NodeFSP.writeFile(commandTranscript, commandCodeLine(13)));

      const fileSystem = yield* FileSystem.FileSystem;
      const ratesStarted = yield* Deferred.make<void>();
      const secondResolutionFinished = yield* Deferred.make<void>();
      const releaseRates = yield* Deferred.make<void>();
      let ratesFetches = 0;
      let commandRootResolutions = 0;
      const commandRoot = NodePath.dirname(NodePath.dirname(commandTranscript));
      const service = yield* UsageService.make.pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fileSystem,
          realPath: (target) =>
            fileSystem.realPath(target).pipe(
              Effect.tap(() => {
                if (target !== commandRoot) return Effect.void;
                commandRootResolutions += 1;
                return commandRootResolutions === 2
                  ? Deferred.succeed(secondResolutionFinished, undefined)
                  : Effect.void;
              }),
            ),
        }),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.sync(() => {
              ratesFetches += 1;
            }).pipe(
              Effect.andThen(Deferred.succeed(ratesStarted, undefined)),
              Effect.andThen(Deferred.await(releaseRates)),
              Effect.as(HttpClientResponse.fromWeb(request, Response.json({}))),
            ),
          ),
        ),
        Effect.provide(
          serviceLayers({ prefix: "usage-service-negotiation-race-test", home, settings }),
        ),
      );

      const legacy = yield* service.readSummary(WINDOW).pipe(Effect.forkChild);
      yield* Deferred.await(ratesStarted);
      const negotiated = yield* service
        .readSummary({ ...WINDOW, supportedProviders: [...UsageProviderKind.literals] })
        .pipe(Effect.forkChild);
      yield* Deferred.await(secondResolutionFinished);
      yield* Deferred.succeed(releaseRates, undefined);

      assert.notInclude(
        (yield* Fiber.join(legacy)).buckets.map((bucket) => bucket.provider),
        "commandcode",
      );
      assert.include(
        (yield* Fiber.join(negotiated)).buckets.map((bucket) => bucket.provider),
        "commandcode",
      );
      assert.strictEqual(ratesFetches, 1);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("does not join an in-flight scan after its resolved source settings change", () =>
    Effect.gen(function* () {
      const { settings, home } = yield* setup;
      const firstHome = settings.providers.claudeAgent.homePath;
      const secondHome = NodePath.join(home, "claude-second");
      const firstTranscript = NodePath.join(firstHome, "projects", "first", "session.jsonl");
      const secondTranscript = NodePath.join(secondHome, "projects", "second", "session.jsonl");
      yield* Effect.promise(() =>
        NodeFSP.mkdir(NodePath.dirname(firstTranscript), { recursive: true }),
      );
      yield* Effect.promise(() =>
        NodeFSP.mkdir(NodePath.dirname(secondTranscript), { recursive: true }),
      );
      yield* Effect.promise(() => NodeFSP.writeFile(firstTranscript, claudeLine(1, 5)));
      yield* Effect.promise(() => NodeFSP.writeFile(secondTranscript, claudeLine(2, 7)));

      yield* Effect.gen(function* () {
        const settingsService = yield* ServerSettings.ServerSettingsService;
        const firstSettings = yield* settingsService.getSettings;
        const secondSettings = yield* settingsService.updateSettings({
          providers: { claudeAgent: { homePath: secondHome } },
        });
        let reads = 0;
        const changingSettings = ServerSettings.ServerSettingsService.of({
          ...settingsService,
          getSettings: Effect.sync(() => (reads++ === 0 ? firstSettings : secondSettings)),
        });
        const ratesStarted = yield* Deferred.make<void>();
        const releaseRates = yield* Deferred.make<void>();
        const service = yield* UsageService.make.pipe(
          Effect.provideService(ServerSettings.ServerSettingsService, changingSettings),
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make((request) =>
              Deferred.succeed(ratesStarted, undefined).pipe(
                Effect.andThen(Deferred.await(releaseRates)),
                Effect.as(HttpClientResponse.fromWeb(request, Response.json({}))),
              ),
            ),
          ),
        );

        const first = yield* service.readSummary(WINDOW).pipe(Effect.forkChild);
        yield* Deferred.await(ratesStarted);
        const second = yield* service.readSummary(WINDOW).pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        yield* Deferred.succeed(releaseRates, undefined);

        assert.strictEqual(totalOutputTokens(yield* Fiber.join(first)), 5);
        assert.strictEqual(totalOutputTokens(yield* Fiber.join(second)), 7);
      }).pipe(
        Effect.provide(serviceLayers({ prefix: "usage-service-source-race-test", home, settings })),
      );
    }).pipe(Effect.scoped),
  );

  it.live("reprices unchanged transcripts when custom prices are added, edited, or removed", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      yield* Effect.promise(() => NodeFSP.writeFile(transcript, claudeLine(1, 5, "example-model")));

      yield* Effect.gen(function* () {
        const settingsService = yield* ServerSettings.ServerSettingsService;
        const service = yield* UsageService.make;

        const original = yield* service.readSummary(WINDOW);
        assert.strictEqual(original.buckets[0]?.costUsd, 0);
        assert.strictEqual(original.buckets[0]?.unpricedRecords, 1);

        yield* settingsService.updateSettings({
          usagePriceOverrides: {
            "example-model": { inputCostPerMillionTokens: 2, outputCostPerMillionTokens: 8 },
          },
        });
        const overridden = yield* service.readSummary(WINDOW);
        assert.closeTo(overridden.buckets[0]?.costUsd ?? -1, 0.00006, 1e-12);
        assert.strictEqual(overridden.buckets[0]?.costSource, "modelPriced");
        assert.strictEqual(overridden.buckets[0]?.unpricedRecords, 0);
        assert.deepStrictEqual(overridden.buckets[0]?.totals, original.buckets[0]?.totals);

        yield* settingsService.updateSettings({
          usagePriceOverrides: {
            "example-model": { inputCostPerMillionTokens: 4, outputCostPerMillionTokens: 16 },
          },
        });
        const edited = yield* service.readSummary(WINDOW);
        assert.closeTo(edited.buckets[0]?.costUsd ?? -1, 0.00012, 1e-12);

        yield* settingsService.updateSettings({ usagePriceOverrides: { "example-model": null } });
        const restored = yield* service.readSummary(WINDOW);
        assert.deepStrictEqual(restored.buckets, original.buckets);
      }).pipe(
        Effect.provide(
          serviceLayers({ prefix: "usage-service-price-overrides-test", home, settings }),
        ),
      );
    }).pipe(Effect.scoped),
  );

  it.live("counts appended usage on a rescan of a grown transcript", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      yield* Effect.promise(() => NodeFSP.writeFile(transcript, claudeLine(1, 5)));

      const service = yield* UsageService.make.pipe(
        Effect.provide(serviceLayers({ prefix: "usage-service-grow-test", home, settings })),
      );

      const first = yield* service.readSummary(WINDOW);
      assert.strictEqual(totalOutputTokens(first), 5);

      yield* Effect.promise(() => NodeFSP.appendFile(transcript, claudeLine(2, 7)));
      const second = yield* service.readSummary(WINDOW);
      assert.strictEqual(totalOutputTokens(second), 12);
    }).pipe(Effect.scoped),
  );

  it.live("does not share an in-flight scan after custom prices change", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      yield* Effect.promise(() => NodeFSP.writeFile(transcript, claudeLine(1, 5, "example-model")));

      yield* Effect.gen(function* () {
        const settingsService = yield* ServerSettings.ServerSettingsService;
        const fileSystem = yield* FileSystem.FileSystem;
        const firstScanStarted = yield* Deferred.make<void>();
        const secondScanStarted = yield* Deferred.make<void>();
        const releaseRates = yield* Deferred.make<void>();
        let homeProbes = 0;
        const service = yield* UsageService.make.pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fileSystem,
            exists: (path) =>
              fileSystem.exists(path).pipe(
                Effect.tap(() => {
                  if (path !== NodePath.join(home, "claude", "projects")) return Effect.void;
                  homeProbes += 1;
                  return Deferred.succeed(
                    homeProbes === 1 ? firstScanStarted : secondScanStarted,
                    undefined,
                  );
                }),
              ),
          }),
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make((request) =>
              Deferred.await(releaseRates).pipe(
                Effect.as(HttpClientResponse.fromWeb(request, Response.json({}))),
              ),
            ),
          ),
        );

        const first = yield* service.readSummary(WINDOW).pipe(Effect.forkChild);
        yield* Deferred.await(firstScanStarted);
        yield* settingsService.updateSettings({
          usagePriceOverrides: {
            "example-model": { inputCostPerMillionTokens: 2, outputCostPerMillionTokens: 8 },
          },
        });
        const second = yield* service.readSummary(WINDOW).pipe(Effect.forkChild);
        yield* Deferred.await(secondScanStarted);
        yield* Deferred.succeed(releaseRates, undefined);

        const original = yield* Fiber.join(first);
        const updated = yield* Fiber.join(second);
        assert.strictEqual(original.buckets[0]?.costUsd, 0);
        assert.closeTo(updated.buckets[0]?.costUsd ?? -1, 0.00006, 1e-12);
      }).pipe(
        Effect.provide(serviceLayers({ prefix: "usage-service-price-race-test", home, settings })),
      );
    }).pipe(Effect.scoped),
  );

  it.live("shares one scan between concurrent identical requests", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      yield* Effect.promise(() => NodeFSP.writeFile(transcript, claudeLine(1, 5)));

      let ratesFetches = 0;
      const service = yield* UsageService.make.pipe(
        Effect.provide(
          serviceLayers({
            prefix: "usage-service-flight-test",
            home,
            settings,
            onRatesFetch: () => {
              ratesFetches += 1;
            },
          }),
        ),
      );

      const [first, second] = yield* Effect.all(
        [service.readSummary(WINDOW), service.readSummary(WINDOW)],
        { concurrency: 2 },
      );
      assert.deepStrictEqual(first, second);
      assert.strictEqual(ratesFetches, 1);

      // A later request is fresh work again, not a stale cached answer.
      yield* service.readSummary(WINDOW);
      assert.strictEqual(ratesFetches, 2);
    }).pipe(Effect.scoped),
  );

  it.live("refetches a rate table inside its TTL only when the client asks", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      yield* Effect.promise(() => NodeFSP.writeFile(transcript, claudeLine(1, 5)));

      let ratesFetches = 0;
      const service = yield* UsageService.make.pipe(
        Effect.provide(
          serviceLayers({
            prefix: "usage-service-rates-refresh-test",
            home,
            settings,
            ratesDocument: {
              "claude-fable-5": { input_cost_per_token: 1e-5, output_cost_per_token: 5e-5 },
            },
            onRatesFetch: () => {
              ratesFetches += 1;
            },
          }),
        ),
      );

      const first = yield* service.readSummary(WINDOW);
      assert.strictEqual(ratesFetches, 1);
      assert.strictEqual(first.pricing.status, "fresh");

      // Inside the daily TTL a plain rescan keeps the cached table.
      yield* TestClock.adjust(Duration.minutes(2));
      yield* service.readSummary(WINDOW);
      assert.strictEqual(ratesFetches, 1);

      // An explicit refresh fetches again so a newly listed model gets priced.
      // A burst of refreshes shares that one fetch.
      const [refreshed] = yield* Effect.all([service.refreshRates, service.refreshRates], {
        concurrency: 2,
      });
      assert.strictEqual(ratesFetches, 2);
      assert.strictEqual(refreshed.status, "fresh");
      assert.strictEqual(refreshed.knownModels, 1);
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );

  it.live("does not orphan an in-flight scan when its first caller is interrupted", () =>
    Effect.gen(function* () {
      const { settings, home } = yield* setup;
      const service = yield* UsageService.make.pipe(
        Effect.provide(
          serviceLayers({ prefix: "usage-service-interruption-test", home, settings }),
        ),
      );

      let orphanedAt: number | undefined;
      for (let interruptAt = 1; interruptAt <= 31; interruptAt += 1) {
        const tasks: Array<() => void> = [];
        const dispatcher: Scheduler.SchedulerDispatcher = {
          scheduleTask: (task) => tasks.push(task),
          flush: () => {
            let task: (() => void) | undefined;
            while ((task = tasks.shift()) !== undefined) task();
          },
        };

        let requestFiber: Fiber.Fiber<unknown, unknown> | undefined;
        let requestChecks = 0;
        const scheduler: Scheduler.Scheduler = {
          executionMode: "async",
          makeDispatcher: () => dispatcher,
          shouldYield: (fiber) => {
            if (fiber !== requestFiber) return false;
            requestChecks += 1;
            if (requestChecks !== interruptAt) return false;
            fiber.interruptUnsafe();
            return true;
          },
        };

        // Each candidate needs a distinct key because the broken case leaves
        // its entry in the service's private in-flight map. The invalid window
        // keeps the real scan synchronous once its detached fiber starts.
        const input: UsageSummaryInput = {
          ...WINDOW,
          sinceDay: UsageDay.make("2026-09-01"),
          untilDay: UsageDay.make(`2026-08-${String(interruptAt).padStart(2, "0")}`),
        };
        const first = yield* service
          .readSummary(input)
          .pipe(
            Effect.exit,
            Effect.provideService(Scheduler.Scheduler, scheduler),
            Effect.forkChild,
          );
        requestFiber = first;
        yield* Effect.yieldNow;
        dispatcher.flush();

        const second = yield* service.readSummary(input).pipe(
          Effect.match({
            onFailure: (error) => error.reason,
            onSuccess: () => "success" as const,
          }),
          Effect.provideService(Scheduler.Scheduler, scheduler),
          Effect.forkChild,
        );
        yield* Effect.yieldNow;
        dispatcher.flush();
        const secondExit = second.pollUnsafe();
        if (secondExit === undefined) {
          second.interruptUnsafe();
          orphanedAt = interruptAt;
          break;
        }
        if (Exit.isFailure(secondExit)) {
          assert.fail("the matching request fiber was interrupted");
        }
        assert.strictEqual(secondExit.value, "invalidWindow");
      }

      assert.isUndefined(
        orphanedAt,
        `interruption left the next matching request pending at scheduler check ${orphanedAt}`,
      );
    }).pipe(Effect.scoped),
  );
});
