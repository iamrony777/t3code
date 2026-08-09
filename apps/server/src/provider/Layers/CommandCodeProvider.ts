import {
  type CommandCodeSettings,
  type ModelCapabilities,
  ProviderDriverKind,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { parseCommandCodeModels, parseCommandCodeStatus } from "../commandCodeCli.ts";
import {
  buildServerProvider,
  isCommandMissingCause,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";

const PROVIDER = ProviderDriverKind.make("commandcode");
const PROBE_TIMEOUT_MS = 10_000;
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

function modelsFromSettings(
  settings: CommandCodeSettings,
  discovered: ReadonlyArray<ServerProviderModel> = FALLBACK_MODELS,
) {
  return providerModelsFromSettings(discovered, settings.customModels, EMPTY_CAPABILITIES);
}

const runCommand = (
  settings: CommandCodeSettings,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
) =>
  Effect.gen(function* () {
    const binaryPath = settings.binaryPath || "command-code";
    const spawnCommand = yield* resolveSpawnCommand(binaryPath, args, { env: environment });
    return yield* spawnAndCollect(
      binaryPath,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
  });

export function buildInitialCommandCodeProviderSnapshot(
  settings: CommandCodeSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    return buildServerProvider({
      driver: PROVIDER,
      presentation: PRESENTATION,
      enabled: settings.enabled,
      checkedAt,
      models: modelsFromSettings(settings),
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
    });
  });
}

export const checkCommandCodeProviderStatus = Effect.fn("checkCommandCodeProviderStatus")(
  function* (
    settings: CommandCodeSettings,
    environment: NodeJS.ProcessEnv = process.env,
  ): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const fallbackModels = modelsFromSettings(settings);

    if (!settings.enabled) {
      return yield* buildInitialCommandCodeProviderSnapshot(settings);
    }

    const statusExit = yield* runCommand(
      settings,
      ["status", "--json", "--no-auto-update"],
      environment,
    ).pipe(Effect.timeoutOption(PROBE_TIMEOUT_MS), Effect.result);

    if (Result.isFailure(statusExit)) {
      const missing = isCommandMissingCause(statusExit.failure);
      return buildServerProvider({
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
      });
    }

    if (Option.isNone(statusExit.success)) {
      return buildServerProvider({
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
      });
    }

    const statusResult = statusExit.success.value;
    const status =
      statusResult.code === 0 ? parseCommandCodeStatus(statusResult.stdout) : undefined;
    if (!status) {
      return buildServerProvider({
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
      });
    }

    if (!status.authenticated) {
      return buildServerProvider({
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
      });
    }

    const modelExit = yield* runCommand(
      settings,
      ["--list-models", "--no-auto-update"],
      environment,
    ).pipe(Effect.timeoutOption(PROBE_TIMEOUT_MS), Effect.result);
    const discovered =
      Result.isSuccess(modelExit) &&
      Option.isSome(modelExit.success) &&
      modelExit.success.value.code === 0
        ? parseCommandCodeModels(modelExit.success.value.stdout).map(
            (model): ServerProviderModel => ({
              ...model,
              isCustom: false,
              capabilities: EMPTY_CAPABILITIES,
            }),
          )
        : [];
    const modelDiscoveryFailed = discovered.length === 0;

    return buildServerProvider({
      driver: PROVIDER,
      presentation: PRESENTATION,
      enabled: true,
      checkedAt,
      models: modelsFromSettings(settings, modelDiscoveryFailed ? FALLBACK_MODELS : discovered),
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
  },
);
