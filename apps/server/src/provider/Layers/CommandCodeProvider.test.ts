import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { CommandCodeSettings, ProviderInstanceId } from "@t3tools/contracts";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import * as ServerConfig from "../../config.ts";
import type { CommandCodeCatalogModel } from "../commandCodeCatalog.ts";
import {
  activateCommandCodeCatalogForProbeResult,
  makeCommandCodeCatalogControllerForProvider,
  makeCommandCodeEffortProbeCommand,
  makeCommandCodeGlobalOptionCommand,
  makeCommandCodeGlobalOptionsControllerForProvider,
} from "../Drivers/CommandCodeDriver.ts";
import {
  attachCommandCodeGlobalOptions,
  buildInitialCommandCodeProviderSnapshot,
  checkCommandCodeProviderStatus,
  commandCodeCatalogModelsToServerModels,
  enrichCommandCodeProviderSnapshot,
  makeCommandCodeProbeCommand,
  probeCommandCodeProviderStatus,
} from "./CommandCodeProvider.ts";

const decodeSettings = Schema.decodeSync(CommandCodeSettings);
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const commandCodeApiLayer = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        Response.json({
          data: [{ id: "model", name: "API Model", context_length: 200_000 }],
        }),
      ),
    ),
  ),
);

const catalogRuntimeLayer = Layer.mergeAll(
  NodeServices.layer,
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-command-code-catalog-runtime-" }).pipe(
    Layer.provide(NodeServices.layer),
  ),
  commandCodeApiLayer,
);

describe("buildInitialCommandCodeProviderSnapshot", () => {
  it.effect("advertises the enabled Early Access provider while checking", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialCommandCodeProviderSnapshot(decodeSettings({}));
      expect(snapshot.displayName).toBe("Command Code");
      expect(snapshot.badgeLabel).toBe("Early Access");
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.status).toBe("warning");
      expect(snapshot.showInteractionModeToggle).toBe(true);
      expect(snapshot.models.map((model) => model.slug)).toEqual(["deepseek/deepseek-v4-flash"]);
      expect(snapshot.globalOptions).toEqual([
        {
          id: "compactMode",
          label: "Compact Mode",
          type: "select",
          currentValue: "default",
          options: [
            { id: "default", label: "Normal", isDefault: true },
            { id: "fast", label: "Fast" },
          ],
        },
        {
          id: "tasteLearning",
          label: "Taste Learning",
          type: "boolean",
          currentValue: true,
        },
      ]);
    }),
  );

  it.effect("replaces only global options when native settings are refreshed", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialCommandCodeProviderSnapshot(decodeSettings({}));
      const updated = attachCommandCodeGlobalOptions(snapshot, [
        {
          id: "tasteLearning",
          label: "Taste Learning",
          type: "boolean",
          currentValue: false,
        },
      ]);

      expect(updated.globalOptions[0]?.currentValue).toBe(false);
      expect(updated.models).toBe(snapshot.models);
      expect(updated.status).toBe(snapshot.status);
    }),
  );
});

describe("commandCodeCatalogModelsToServerModels", () => {
  it("preserves CLI identity while publishing API names and adjustable reasoning", () => {
    const models: ReadonlyArray<CommandCodeCatalogModel> = [
      {
        slug: "Claude-Haiku-4-5",
        name: "Claude Haiku 4.5",
        subProvider: "Anthropic",
        isDefault: true,
        contextWindow: 200_000,
        effort: { kind: "adjustable", values: ["low", "medium", "high", "xhigh", "max", "ultra"] },
      },
    ];

    expect(commandCodeCatalogModelsToServerModels(models, ["custom/model"])).toEqual([
      {
        slug: "Claude-Haiku-4-5",
        name: "Claude Haiku 4.5",
        subProvider: "Anthropic",
        isCustom: false,
        isDefault: true,
        capabilities: {
          optionDescriptors: [
            {
              id: "reasoningEffort",
              label: "Reasoning",
              type: "select",
              currentValue: "default",
              options: [
                { id: "default", label: "Default", isDefault: true },
                { id: "low", label: "Low" },
                { id: "medium", label: "Medium" },
                { id: "high", label: "High" },
                { id: "xhigh", label: "Extra High" },
                { id: "max", label: "Max" },
                { id: "ultra", label: "Ultra" },
              ],
            },
          ],
        },
      },
      {
        slug: "custom/model",
        name: "custom/model",
        isCustom: true,
        capabilities: { optionDescriptors: [] },
      },
    ]);
  });

  it("omits reasoning options for fixed and unknown effort models", () => {
    const models: ReadonlyArray<CommandCodeCatalogModel> = [
      {
        slug: "fixed-model",
        name: "Fixed",
        subProvider: "Command Code",
        effort: { kind: "fixed" },
      },
      {
        slug: "unknown-model",
        name: "Unknown",
        subProvider: "Command Code",
        effort: { kind: "unknown" },
      },
    ];

    expect(
      commandCodeCatalogModelsToServerModels(models, []).map((model) => model.capabilities),
    ).toEqual([{ optionDescriptors: [] }, { optionDescriptors: [] }]);
  });
});

describe("enrichCommandCodeProviderSnapshot", () => {
  it.effect("publishes cache and advisory before refresh while retaining advisory fields", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const refreshStarted = yield* Deferred.make<void>();
        const releaseRefresh = yield* Deferred.make<void>();
        const settings = decodeSettings({ customModels: ["custom/model"] });
        const snapshot = yield* buildInitialCommandCodeProviderSnapshot(settings);
        const seed = {
          identity: {
            instanceId: ProviderInstanceId.make("command-code-work"),
            resolvedBinaryPath: "/opt/bin/command-code",
            cliVersion: "1.15.1",
          },
          cliModels: [
            {
              slug: "Claude-Haiku-4-5",
              name: "Claude-Haiku-4-5",
              subProvider: "Anthropic",
              isDefault: true,
            },
          ],
        } as const;
        const cached: ReadonlyArray<CommandCodeCatalogModel> = [
          {
            ...seed.cliModels[0],
            name: "Cached Haiku",
            contextWindow: 200_000,
            effort: { kind: "unknown" },
          },
        ];
        const refreshed: ReadonlyArray<CommandCodeCatalogModel> = [
          {
            ...seed.cliModels[0],
            name: "API Haiku",
            contextWindow: 250_000,
            effort: { kind: "adjustable", values: ["high", "max"] },
          },
        ];
        const published: Array<typeof snapshot> = [];

        const fiber = yield* enrichCommandCodeProviderSnapshot({
          controller: {
            catalogFromCache: () => Effect.succeed(cached),
            refresh: () =>
              Deferred.succeed(refreshStarted, undefined).pipe(
                Effect.andThen(Deferred.await(releaseRefresh)),
                Effect.as(refreshed),
              ),
          },
          settings,
          snapshot,
          seed,
          getSnapshot: Effect.sync(() => published.at(-1) ?? snapshot),
          enrichAdvisory: (current) =>
            Effect.succeed({
              ...current,
              versionAdvisory: {
                status: "current",
                currentVersion: "1.15.1",
                latestVersion: "1.15.1",
                updateCommand: "npm install -g command-code@latest",
                canUpdate: true,
                checkedAt: "2026-08-09T00:00:00.000Z",
                message: "Command Code is up to date.",
              },
            }),
          publishSnapshot: (next) => Effect.sync(() => void published.push(next)),
        }).pipe(Effect.forkScoped);

        yield* Deferred.await(refreshStarted);
        expect(published.map((entry) => entry.models[0]?.name)).toEqual([
          "Cached Haiku",
          "Cached Haiku",
        ]);
        expect(published[1]?.versionAdvisory?.latestVersion).toBe("1.15.1");
        expect(published[0]?.models.map((model) => model.slug)).toEqual([
          "Claude-Haiku-4-5",
          "custom/model",
        ]);

        yield* Deferred.succeed(releaseRefresh, undefined);
        yield* Fiber.join(fiber);
        expect(published.map((entry) => entry.models[0]?.name)).toEqual([
          "Cached Haiku",
          "Cached Haiku",
          "API Haiku",
        ]);
        expect(published[2]?.models[0]?.slug).toBe("Claude-Haiku-4-5");
        expect(published[2]?.models).toHaveLength(2);
        expect(published[2]?.versionAdvisory?.latestVersion).toBe("1.15.1");
      }),
    ),
  );
});

describe("Command Code probe commands", () => {
  it.effect("resolves Windows effort probes through command shims with force-kill escalation", () =>
    Effect.gen(function* () {
      const command = yield* makeCommandCodeEffortProbeCommand(
        {
          executable: "command-code",
          args: ["--model", "model", "--effort", "invalid"],
          stdin: "closed",
          maxStdoutBytes: 64,
          maxStderrBytes: 64,
        },
        { PATH: "C:\\fake\\npm", PATHEXT: ".COM;.EXE;.BAT;.CMD" },
      ).pipe(
        Effect.provideService(HostProcessPlatform, "win32"),
        Effect.provideService(HostProcessEnvironment, {}),
        Effect.provideService(SpawnExecutableResolution, () => "C:\\fake\\npm\\command-code.cmd"),
      );

      expect(command.command).toMatch(/command-code\.cmd/i);
      expect(command.args).toHaveLength(4);
      expect(command.options.shell).toBe(true);
      expect(command.options.stdin).toBe("ignore");
      expect(command.options.forceKillAfter).toBe("1 second");
    }),
  );

  it.effect("adds force-kill escalation to status and model-list probes", () =>
    Effect.gen(function* () {
      for (const args of [
        ["status", "--json", "--no-auto-update"],
        ["--list-models", "--no-auto-update"],
      ]) {
        const command = yield* makeCommandCodeProbeCommand(
          decodeSettings({ binaryPath: "/opt/bin/command-code" }),
          args,
          process.env,
        );
        expect(command.options.forceKillAfter).toBe("1 second");
      }
    }),
  );

  it.effect("resolves global mutations without an interactive stdin and with force-kill", () =>
    Effect.gen(function* () {
      const command = yield* makeCommandCodeGlobalOptionCommand(
        decodeSettings({ binaryPath: "/opt/bin/command-code" }),
        ["--config", "compact-mode=default"],
        process.env,
      );
      expect(command.command).toBe("/opt/bin/command-code");
      expect(command.args).toEqual(["--config", "compact-mode=default"]);
      expect(command.options.shell).toBe(false);
      expect(command.options.stdin).toBe("ignore");
      expect(command.options.forceKillAfter).toBe("1 second");
    }),
  );

  it.effect("resolves Windows global mutations through command shims", () =>
    Effect.gen(function* () {
      const command = yield* makeCommandCodeGlobalOptionCommand(
        decodeSettings({}),
        ["taste", "enable", "--user"],
        { PATH: "C:\\fake\\npm", PATHEXT: ".COM;.EXE;.BAT;.CMD" },
      ).pipe(
        Effect.provideService(HostProcessPlatform, "win32"),
        Effect.provideService(HostProcessEnvironment, {}),
        Effect.provideService(SpawnExecutableResolution, () => "C:\\fake\\npm\\command-code.cmd"),
      );

      expect(command.command).toMatch(/command-code\.cmd/i);
      expect(command.args).toHaveLength(3);
      expect(command.options.shell).toBe(true);
      expect(command.options.stdin).toBe("ignore");
      expect(command.options.forceKillAfter).toBe("1 second");
    }),
  );
});

describe("makeCommandCodeCatalogControllerForProvider", () => {
  it.effect("activates every discovered inventory and clears results without a seed", () =>
    Effect.gen(function* () {
      const calls: Array<string> = [];
      const controller = {
        activateInventory: (
          identity: { readonly cliVersion: string },
          models: ReadonlyArray<unknown>,
        ) =>
          Effect.sync(() => {
            calls.push(`activate:${identity.cliVersion}:${models.length}`);
          }),
        clearInventory: () =>
          Effect.sync(() => {
            calls.push("clear");
          }),
      };
      const seed = {
        identity: {
          instanceId: "commandcode",
          resolvedBinaryPath: "/bin/command-code",
          cliVersion: "1.15.1",
        },
        cliModels: [{ slug: "model", name: "Model", subProvider: "Command Code" }],
      };

      yield* activateCommandCodeCatalogForProbeResult(controller, { catalogSeed: seed });
      yield* activateCommandCodeCatalogForProbeResult(controller, {});

      expect(calls).toEqual(["activate:1.15.1:1", "clear"]);
    }),
  );

  it.effect("uses server cache, bounded HTTP, atomic writes, and a closed-stdin effort probe", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const config = yield* ServerConfig.ServerConfig;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-command-code-effort-" });
        const executable = path.join(dir, "command-code");
        yield* fs.writeFileString(
          executable,
          [
            "#!/bin/sh",
            'test "$1" = "--model"',
            'test "$2" = "model"',
            'test "$3" = "--effort"',
            'test "$5" = "--no-auto-update"',
            "if read -r _line; then exit 2; fi",
            "printf '%s\\n' 'Unknown effort \"__t3_invalid_effort_probe__\". Supported: high, max.' >&2",
            "exit 1",
          ].join("\n"),
        );
        yield* fs.chmod(executable, 0o755);
        const controller = yield* makeCommandCodeCatalogControllerForProvider(process.env);
        const identity = {
          instanceId: "command-code-work",
          resolvedBinaryPath: executable,
          cliVersion: "1.15.1",
        } as const;

        const catalog = yield* controller.refresh(identity, [
          { slug: "model", name: "model", subProvider: "Command Code" },
        ]);

        expect(catalog[0]).toMatchObject({
          slug: "model",
          name: "API Model",
          contextWindow: 200_000,
          effort: { kind: "adjustable", values: ["high", "max"] },
        });
        expect(controller.cachePath(identity)).toBe(
          path.join(config.providerStatusCacheDir, "command-code-work.commandcode-catalog.json"),
        );
        expect(yield* fs.exists(controller.cachePath(identity))).toBe(true);
      }),
    ).pipe(Effect.provide(catalogRuntimeLayer)),
  );
});

describe("makeCommandCodeGlobalOptionsControllerForProvider", () => {
  it.effect("uses an isolated HOME and executes native mutations with read-after-write", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-command-code-home-" });
        const commandCodeDir = path.join(home, ".commandcode");
        const settingsFile = path.join(commandCodeDir, "config.json");
        const executable = path.join(home, "command-code");
        yield* fs.makeDirectory(commandCodeDir, { recursive: true });
        yield* fs.writeFileString(
          executable,
          [
            "#!/bin/sh",
            'settings="$HOME/.commandcode/config.json"',
            'if [ "$1" = "--config" ] && [ "$2" = "compact-mode=fast" ]; then',
            '  printf \'%s\' \'{"compactMode":"fast","tasteLearning":true}\' > "$settings"',
            "  exec sleep 30",
            'elif [ "$1" = "taste" ] && [ "$2" = "disable" ] && [ "$3" = "--user" ]; then',
            '  printf \'%s\' \'{"compactMode":"fast","tasteLearning":false}\' > "$settings"',
            "else",
            "  exit 7",
            "fi",
          ].join("\n"),
        );
        yield* fs.chmod(executable, 0o755);

        const controller = yield* makeCommandCodeGlobalOptionsControllerForProvider(
          decodeSettings({ binaryPath: executable }),
          { HOME: home, PATH: process.env.PATH },
        );
        expect((yield* controller.readOptions)[1]?.currentValue).toBe(true);

        yield* controller
          .setGlobalOption({ optionId: "compactMode", value: "fast" })
          .pipe(TestClock.withLive);
        yield* controller.setGlobalOption({ optionId: "tasteLearning", value: false });

        expect(decodeJson(yield* fs.readFileString(settingsFile))).toEqual({
          compactMode: "fast",
          tasteLearning: false,
        });
        expect((yield* controller.readOptions).map((option) => option.currentValue)).toEqual([
          "fast",
          false,
        ]);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});

it.layer(NodeServices.layer)("checkCommandCodeProviderStatus", (it) => {
  it.effect("reports authenticated status and discovered models", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-command-code-provider-" });
        const binaryPath = path.join(dir, "command-code");
        yield* fs.writeFileString(
          binaryPath,
          [
            "#!/bin/sh",
            'case " $* " in',
            '  *" status "*) printf \'%s\\n\' \'{"authenticated":true,"version":"1.15.1","user":"rony","provider":"command-code","model":"deepseek/deepseek-v4-flash","context_window":1000000}\' ;;',
            "  *\" --list-models \"*) printf '%s\\n' 'Open Source' 'deepseek/deepseek-v4-flash  DeepSeek V4 Flash (default)' 'Anthropic' 'claude-sonnet-4-6  Claude Sonnet 4.6' ;;",
            "esac",
          ].join("\n"),
        );
        yield* fs.chmod(binaryPath, 0o755);

        const snapshot = yield* checkCommandCodeProviderStatus(
          decodeSettings({ binaryPath, customModels: ["custom/model"] }),
        );

        expect(snapshot.status).toBe("ready");
        expect(snapshot.installed).toBe(true);
        expect(snapshot.version).toBe("1.15.1");
        expect(snapshot.auth).toEqual({ status: "authenticated", label: "rony" });
        expect(snapshot.models.map((model) => model.slug)).toEqual([
          "deepseek/deepseek-v4-flash",
          "claude-sonnet-4-6",
          "custom/model",
        ]);
        expect(snapshot.models[0]?.isDefault).toBe(true);
      }),
    ),
  );

  it.effect("returns an immediate unenriched CLI inventory and exact catalog identity", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-command-code-seed-" });
        const binaryPath = path.join(dir, "command-code");
        yield* fs.writeFileString(
          binaryPath,
          [
            "#!/bin/sh",
            'case " $* " in',
            '  *" status "*) printf \'%s\\n\' \'{"authenticated":true,"version":"1.15.1","provider":"command-code"}\' ;;',
            "  *\" --list-models \"*) printf '%s\\n' 'Anthropic' 'Claude-Haiku-4-5  CLI Name (default)' ;;",
            "esac",
          ].join("\n"),
        );
        yield* fs.chmod(binaryPath, 0o755);

        const result = yield* probeCommandCodeProviderStatus(
          decodeSettings({ binaryPath }),
          ProviderInstanceId.make("command-code-work"),
        );

        expect(result.snapshot.status).toBe("ready");
        expect(result.snapshot.models).toEqual([
          {
            slug: "Claude-Haiku-4-5",
            name: "Claude-Haiku-4-5",
            subProvider: "Anthropic",
            isCustom: false,
            isDefault: true,
            capabilities: { optionDescriptors: [] },
          },
        ]);
        expect(result.catalogSeed).toEqual({
          identity: {
            instanceId: "command-code-work",
            resolvedBinaryPath: binaryPath,
            cliVersion: "1.15.1",
          },
          cliModels: [
            {
              slug: "Claude-Haiku-4-5",
              name: "Claude-Haiku-4-5",
              subProvider: "Anthropic",
              isDefault: true,
            },
          ],
        });
      }),
    ),
  );

  it.effect("reports an unauthenticated installation without listing models", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-command-code-auth-" });
        const binaryPath = path.join(dir, "command-code");
        yield* fs.writeFileString(
          binaryPath,
          [
            "#!/bin/sh",
            'printf \'%s\\n\' \'{"authenticated":false,"version":"1.15.1","provider":"command-code"}\'',
          ].join("\n"),
        );
        yield* fs.chmod(binaryPath, 0o755);

        const snapshot = yield* checkCommandCodeProviderStatus(decodeSettings({ binaryPath }));
        expect(snapshot.installed).toBe(true);
        expect(snapshot.status).toBe("error");
        expect(snapshot.auth.status).toBe("unauthenticated");
        expect(snapshot.message).toContain("command-code login");
      }),
    ),
  );

  it.effect("reports a missing binary", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkCommandCodeProviderStatus(
        decodeSettings({ binaryPath: "/definitely/not/installed/command-code" }),
      );
      expect(snapshot.installed).toBe(false);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toContain("not installed");
    }),
  );
});
