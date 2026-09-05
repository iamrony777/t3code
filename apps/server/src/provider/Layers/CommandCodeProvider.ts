import {
  type CommandCodeSettings,
  type CustomModelSetting,
  type ModelCapabilities,
  type ProviderGlobalOption,
  ProviderInstanceId,
  ProviderDriverKind,
  type ServerProviderModel,
  type ServerProviderSlashCommand,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveCommandPath, resolveSpawnCommand } from "@t3tools/shared/shell";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import type { CommandCodeCatalogIdentity, CommandCodeCatalogModel } from "../commandCodeCatalog.ts";
import {
  commandCodeGlobalOptionsFromSettings,
  parseCommandCodeGlobalSettings,
} from "../commandCodeGlobalOptions.ts";
import { discoverCommandCodeSkills } from "../Drivers/CommandCodeSkills.ts";
import {
  type CommandCodeModel,
  parseCommandCodeModels,
  parseCommandCodeStatus,
} from "../commandCodeCli.ts";
import {
  buildSelectOptionDescriptor,
  buildServerProvider,
  isCommandMissingCause,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";

const PROVIDER = ProviderDriverKind.make("commandcode");
const PROBE_TIMEOUT_MS = 10_000;
const PROBE_FORCE_KILL_AFTER = "1 second";
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({ optionDescriptors: [] });
const PRESENTATION = {
  displayName: "Command Code",
  badgeLabel: "Early Access",
  showInteractionModeToggle: true,
  requiresNewThreadForModelChange: false,
} as const;
const FALLBACK_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "deepseek/deepseek-v4-flash",
    name: "DeepSeek V4 Flash",
    isCustom: false,
    isDefault: true,
    capabilities: EMPTY_CAPABILITIES,
  },
];
const DEFAULT_GLOBAL_OPTIONS = commandCodeGlobalOptionsFromSettings(
  parseCommandCodeGlobalSettings(undefined),
);
const SLASH_COMMANDS: ReadonlyArray<ServerProviderSlashCommand> = [
  { name: "compact", description: "Compact the conversation history" },
];

export function attachCommandCodeGlobalOptions<Snapshot extends ServerProviderDraft>(
  snapshot: Snapshot,
  globalOptions: ReadonlyArray<ProviderGlobalOption>,
): Snapshot {
  return { ...snapshot, globalOptions };
}

function modelsFromSettings(
  settings: CommandCodeSettings,
  discovered: ReadonlyArray<ServerProviderModel> = FALLBACK_MODELS,
) {
  return providerModelsFromSettings(discovered, settings.customModels, EMPTY_CAPABILITIES);
}

const EFFORT_LABELS: Readonly<Record<string, string>> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
  ultra: "Ultra",
};

function capabilitiesFromCatalogModel(model: CommandCodeCatalogModel): ModelCapabilities {
  if (model.effort.kind !== "adjustable") {
    return EMPTY_CAPABILITIES;
  }
  return createModelCapabilities({
    optionDescriptors: [
      buildSelectOptionDescriptor({
        id: "reasoningEffort",
        label: "Reasoning",
        options: [
          { value: "default", label: "Default", isDefault: true },
          ...model.effort.values
            .filter((value) => value !== "default")
            .map((value) => ({ value, label: EFFORT_LABELS[value] ?? value })),
        ],
      }),
    ],
  });
}

export function commandCodeCatalogModelsToServerModels(
  catalog: ReadonlyArray<CommandCodeCatalogModel>,
  customModels: ReadonlyArray<CustomModelSetting>,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(
    catalog.map((model) => ({
      slug: model.slug,
      name: model.name,
      subProvider: model.subProvider,
      isCustom: false,
      ...(model.isDefault !== undefined ? { isDefault: model.isDefault } : {}),
      capabilities: capabilitiesFromCatalogModel(model),
    })),
    customModels,
    EMPTY_CAPABILITIES,
  );
}

export interface CommandCodeCatalogSeed {
  readonly identity: CommandCodeCatalogIdentity;
  readonly cliModels: ReadonlyArray<CommandCodeModel>;
}

export interface CommandCodeProviderProbeResult {
  readonly snapshot: ServerProviderDraft;
  readonly catalogSeed?: CommandCodeCatalogSeed | undefined;
}

interface CommandCodeCatalogSnapshotController {
  readonly catalogFromCache: (
    identity: CommandCodeCatalogIdentity,
    cliModels: ReadonlyArray<CommandCodeModel>,
  ) => Effect.Effect<ReadonlyArray<CommandCodeCatalogModel>>;
  readonly refresh: (
    identity: CommandCodeCatalogIdentity,
    cliModels: ReadonlyArray<CommandCodeModel>,
  ) => Effect.Effect<ReadonlyArray<CommandCodeCatalogModel>>;
}

export const enrichCommandCodeProviderSnapshot = Effect.fn("enrichCommandCodeProviderSnapshot")(
  function* <Snapshot extends ServerProviderDraft>(input: {
    readonly controller: CommandCodeCatalogSnapshotController;
    readonly settings: CommandCodeSettings;
    readonly snapshot: Snapshot;
    readonly seed: CommandCodeCatalogSeed;
    readonly getSnapshot: Effect.Effect<Snapshot>;
    readonly enrichAdvisory: (snapshot: Snapshot) => Effect.Effect<Snapshot>;
    readonly publishSnapshot: (snapshot: Snapshot) => Effect.Effect<void>;
  }) {
    const modelsFromCatalog = (catalog: ReadonlyArray<CommandCodeCatalogModel>) =>
      commandCodeCatalogModelsToServerModels(catalog, input.settings.customModels);

    const cached = yield* input.controller.catalogFromCache(
      input.seed.identity,
      input.seed.cliModels,
    );
    yield* input.publishSnapshot({
      ...input.snapshot,
      models: modelsFromCatalog(cached),
    } as Snapshot);

    const currentSnapshot = yield* input.getSnapshot;
    const advisedSnapshot = yield* input.enrichAdvisory(currentSnapshot);
    yield* input.publishSnapshot(advisedSnapshot);

    const refreshed = yield* input.controller.refresh(input.seed.identity, input.seed.cliModels);
    const latestSnapshot = yield* input.getSnapshot;
    yield* input.publishSnapshot({
      ...latestSnapshot,
      models: modelsFromCatalog(refreshed),
    } as Snapshot);
  },
);

export const makeCommandCodeProbeCommand = Effect.fn("makeCommandCodeProbeCommand")(function* (
  settings: CommandCodeSettings,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
) {
  const binaryPath = settings.binaryPath || "command-code";
  const spawnCommand = yield* resolveSpawnCommand(binaryPath, args, { env: environment });
  return ChildProcess.make(spawnCommand.command, spawnCommand.args, {
    env: environment,
    shell: spawnCommand.shell,
    forceKillAfter: PROBE_FORCE_KILL_AFTER,
  });
});

const runCommand = (
  settings: CommandCodeSettings,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
) =>
  Effect.gen(function* () {
    const binaryPath = settings.binaryPath || "command-code";
    const command = yield* makeCommandCodeProbeCommand(settings, args, environment);
    return yield* spawnAndCollect(binaryPath, command);
  });

const hasCompleteCommandCodeModelList = (stdout: string) =>
  /^Docs:\s+\S+\s*$/m.test(stdout) && parseCommandCodeModels(stdout).length > 0;

const runModelListCommand = (settings: CommandCodeSettings, environment: NodeJS.ProcessEnv) =>
  Effect.scoped(
    Effect.gen(function* () {
      const command = yield* makeCommandCodeProbeCommand(
        settings,
        ["--list-models", "--no-auto-update"],
        environment,
      );
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const child = yield* spawner.spawn(command);
      const stdoutRef = yield* Ref.make("");
      const stderrRef = yield* Ref.make("");
      const outputComplete = yield* Deferred.make<void>();

      const stdoutFiber = yield* Effect.forkScoped(
        child.stdout.pipe(
          Stream.decodeText(),
          Stream.runForEach((chunk) =>
            Ref.updateAndGet(stdoutRef, (stdout) => `${stdout}${chunk}`).pipe(
              Effect.flatMap((stdout) =>
                hasCompleteCommandCodeModelList(stdout)
                  ? Deferred.succeed(outputComplete, undefined).pipe(Effect.ignore)
                  : Effect.void,
              ),
            ),
          ),
        ),
      );
      const stderrFiber = yield* Effect.forkScoped(
        child.stderr.pipe(
          Stream.decodeText(),
          Stream.runForEach((chunk) => Ref.update(stderrRef, (stderr) => `${stderr}${chunk}`)),
        ),
      );

      const outcome = yield* Effect.raceFirst(
        child.exitCode.pipe(
          Effect.map((code) => ({ _tag: "Exited" as const, code: Number(code) })),
        ),
        Deferred.await(outputComplete).pipe(Effect.as({ _tag: "OutputComplete" as const })),
      );
      if (outcome._tag === "OutputComplete") {
        yield* child.kill({ forceKillAfter: PROBE_FORCE_KILL_AFTER }).pipe(Effect.ignore);
      }
      yield* Fiber.join(stdoutFiber);
      yield* Fiber.join(stderrFiber);

      return {
        code: outcome._tag === "Exited" ? outcome.code : 0,
        stdout: yield* Ref.get(stdoutRef),
        stderr: yield* Ref.get(stderrRef),
      };
    }),
  );

export function buildInitialCommandCodeProviderSnapshot(
  settings: CommandCodeSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    return attachCommandCodeGlobalOptions(
      buildServerProvider({
        driver: PROVIDER,
        presentation: PRESENTATION,
        enabled: settings.enabled,
        checkedAt,
        models: modelsFromSettings(settings),
        slashCommands: SLASH_COMMANDS,
        probe: settings.enabled
          ? {
              installed: true,
              version: null,
              status: "warning",
              auth: { status: "unknown" },
              message: "Checking Command Code CLI availability...",
            }
          : {
              installed: false,
              version: null,
              status: "warning",
              auth: { status: "unknown" },
              message: "Command Code is disabled in T3 Code settings.",
            },
      }),
      DEFAULT_GLOBAL_OPTIONS,
    );
  });
}

export const probeCommandCodeProviderStatus = Effect.fn("probeCommandCodeProviderStatus")(
  function* (
    settings: CommandCodeSettings,
    instanceId: ProviderInstanceId,
    environment: NodeJS.ProcessEnv = process.env,
    cwd?: string,
  ): Effect.fn.Return<
    CommandCodeProviderProbeResult,
    never,
    ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
  > {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const fallbackModels = modelsFromSettings(settings);

    if (!settings.enabled) {
      return { snapshot: yield* buildInitialCommandCodeProviderSnapshot(settings) };
    }

    const statusExit = yield* runCommand(
      settings,
      ["status", "--json", "--no-auto-update"],
      environment,
    ).pipe(Effect.timeoutOption(PROBE_TIMEOUT_MS), Effect.result);

    if (Result.isFailure(statusExit)) {
      const missing = isCommandMissingCause(statusExit.failure);
      return {
        snapshot: buildServerProvider({
          driver: PROVIDER,
          presentation: PRESENTATION,
          enabled: true,
          checkedAt,
          models: fallbackModels,
          probe: {
            installed: !missing,
            version: null,
            status: "error",
            auth: { status: "unknown" },
            message: missing
              ? "Command Code CLI (`command-code`) is not installed or not on PATH."
              : "Failed to execute the Command Code CLI health check.",
          },
        }),
      };
    }

    if (Option.isNone(statusExit.success)) {
      return {
        snapshot: buildServerProvider({
          driver: PROVIDER,
          presentation: PRESENTATION,
          enabled: true,
          checkedAt,
          models: fallbackModels,
          probe: {
            installed: true,
            version: null,
            status: "error",
            auth: { status: "unknown" },
            message: "Command Code CLI status check timed out.",
          },
        }),
      };
    }

    const statusResult = statusExit.success.value;
    const status =
      statusResult.code === 0 ? parseCommandCodeStatus(statusResult.stdout) : undefined;
    if (!status) {
      return {
        snapshot: buildServerProvider({
          driver: PROVIDER,
          presentation: PRESENTATION,
          enabled: true,
          checkedAt,
          models: fallbackModels,
          probe: {
            installed: true,
            version: null,
            status: "error",
            auth: { status: "unknown" },
            message: "Command Code CLI returned an unexpected status response.",
          },
        }),
      };
    }

    if (!status.authenticated) {
      return {
        snapshot: buildServerProvider({
          driver: PROVIDER,
          presentation: PRESENTATION,
          enabled: true,
          checkedAt,
          models: fallbackModels,
          probe: {
            installed: true,
            version: status.version,
            status: "error",
            auth: { status: "unauthenticated" },
            message: "Command Code is not authenticated. Run `command-code login`.",
          },
        }),
      };
    }

    const modelExit = yield* runModelListCommand(settings, environment).pipe(
      Effect.timeoutOption(PROBE_TIMEOUT_MS),
      Effect.result,
    );
    const cliModels =
      Result.isSuccess(modelExit) &&
      Option.isSome(modelExit.success) &&
      modelExit.success.value.code === 0
        ? parseCommandCodeModels(modelExit.success.value.stdout)
        : [];
    const discovered = cliModels.map((model): ServerProviderModel => ({
      ...model,
      isCustom: false,
      capabilities: EMPTY_CAPABILITIES,
    }));
    const modelDiscoveryFailed = cliModels.length === 0;
    const skills = yield* discoverCommandCodeSkills(cwd);

    const snapshot = buildServerProvider({
      driver: PROVIDER,
      presentation: PRESENTATION,
      enabled: true,
      checkedAt,
      models: modelsFromSettings(settings, modelDiscoveryFailed ? FALLBACK_MODELS : discovered),
      skills,
      slashCommands: SLASH_COMMANDS,
      probe: {
        installed: true,
        version: status.version,
        status: modelDiscoveryFailed ? "warning" : "ready",
        auth: {
          status: "authenticated",
          ...(status.user ? { label: status.user } : {}),
        },
        ...(modelDiscoveryFailed
          ? { message: "Command Code is ready, but its model list could not be loaded." }
          : {}),
      },
    });
    if (modelDiscoveryFailed) {
      return { snapshot };
    }
    const binaryPath = settings.binaryPath || "command-code";
    const resolvedBinaryPath = yield* resolveCommandPath(binaryPath, {
      env: environment,
    }).pipe(Effect.option);
    if (Option.isNone(resolvedBinaryPath)) {
      return { snapshot };
    }
    return {
      snapshot,
      catalogSeed: {
        identity: {
          instanceId,
          resolvedBinaryPath: resolvedBinaryPath.value,
          cliVersion: status.version,
        },
        cliModels,
      },
    };
  },
);

export const checkCommandCodeProviderStatus = Effect.fn("checkCommandCodeProviderStatus")(
  function* (
    settings: CommandCodeSettings,
    environment: NodeJS.ProcessEnv = process.env,
    cwd?: string,
  ): Effect.fn.Return<
    ServerProviderDraft,
    never,
    ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
  > {
    return (yield* probeCommandCodeProviderStatus(
      settings,
      ProviderInstanceId.make("commandcode"),
      environment,
      cwd,
    )).snapshot;
  },
);
