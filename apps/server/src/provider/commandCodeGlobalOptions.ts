import type { ProviderGlobalOption } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import {
  type ProviderGlobalOptionMutation,
  ProviderGlobalOptionMutationError,
} from "./ProviderDriver.ts";

export const COMMAND_CODE_GLOBAL_OPTION_TIMEOUT_MS = 10_000;
export const COMMAND_CODE_GLOBAL_OPTION_OUTPUT_BYTES = 64 * 1024;
export const COMMAND_CODE_SETTINGS_MAX_BYTES = 1024 * 1024;
const COMMAND_CODE_SETTINGS_POLL_INTERVAL = "50 millis";

const CompactMode = Schema.Literals(["default", "fast"]);
type CompactMode = typeof CompactMode.Type;

const CommandCodeSettingsDocument = Schema.Struct({
  compactMode: Schema.optional(Schema.Unknown),
  tasteLearning: Schema.optional(Schema.Unknown),
});
const decodeSettingsDocument = Schema.decodeUnknownExit(
  Schema.fromJsonString(CommandCodeSettingsDocument),
);
const isCompactMode = Schema.is(CompactMode);
const isBoolean = Schema.is(Schema.Boolean);

export interface CommandCodeGlobalSettings {
  readonly compactMode: CompactMode;
  readonly tasteLearning: boolean;
}

export interface CommandCodeGlobalOptionCommandInput {
  readonly args: ReadonlyArray<string>;
  readonly maxStdoutBytes: number;
  readonly maxStderrBytes: number;
}

export interface CommandCodeGlobalOptionCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
}

export interface CommandCodeGlobalOptionsDependencies<DependencyError = never> {
  readonly settingsFilePath?: string | undefined;
  readonly readSettingsFile: (path: string) => Effect.Effect<string, DependencyError>;
  readonly runCommand: (
    input: CommandCodeGlobalOptionCommandInput,
  ) => Effect.Effect<CommandCodeGlobalOptionCommandResult, DependencyError>;
}

export function resolveCommandCodeSettingsFilePath(
  environment: NodeJS.ProcessEnv,
  joinPath: (...parts: ReadonlyArray<string>) => string,
): string | undefined {
  const homeDirectory = environment.HOME?.trim() || environment.USERPROFILE?.trim();
  return homeDirectory ? joinPath(homeDirectory, ".commandcode", "config.json") : undefined;
}

const DEFAULT_SETTINGS: CommandCodeGlobalSettings = {
  compactMode: "default",
  tasteLearning: true,
};

const utf8ByteLength = (value: string): number => new TextEncoder().encode(value).byteLength;

export function parseCommandCodeGlobalSettings(
  contents: string | undefined,
): CommandCodeGlobalSettings {
  if (contents === undefined || utf8ByteLength(contents) > COMMAND_CODE_SETTINGS_MAX_BYTES) {
    return DEFAULT_SETTINGS;
  }
  const decoded = decodeSettingsDocument(contents);
  if (Exit.isFailure(decoded)) return DEFAULT_SETTINGS;
  return {
    compactMode: isCompactMode(decoded.value.compactMode)
      ? decoded.value.compactMode
      : DEFAULT_SETTINGS.compactMode,
    tasteLearning: isBoolean(decoded.value.tasteLearning)
      ? decoded.value.tasteLearning
      : DEFAULT_SETTINGS.tasteLearning,
  };
}

export function commandCodeGlobalOptionsFromSettings(
  settings: CommandCodeGlobalSettings,
): ReadonlyArray<ProviderGlobalOption> {
  return [
    {
      id: "compactMode",
      label: "Compact Mode",
      type: "select",
      currentValue: settings.compactMode,
      options: [
        { id: "default", label: "Normal", isDefault: true },
        { id: "fast", label: "Fast" },
      ],
    },
    {
      id: "tasteLearning",
      label: "Taste Learning",
      type: "boolean",
      currentValue: settings.tasteLearning,
    },
  ];
}

function commandForMutation(
  mutation: ProviderGlobalOptionMutation,
): Effect.Effect<
  { readonly args: ReadonlyArray<string>; readonly expected: string | boolean },
  ProviderGlobalOptionMutationError
> {
  switch (mutation.optionId) {
    case "compactMode": {
      if (typeof mutation.value !== "string" || !isCompactMode(mutation.value)) {
        return Effect.fail(
          new ProviderGlobalOptionMutationError({
            message: 'Compact Mode must be either "default" or "fast".',
          }),
        );
      }
      return Effect.succeed({
        args: ["--config", `compact-mode=${mutation.value}`],
        expected: mutation.value,
      });
    }
    case "tasteLearning": {
      if (typeof mutation.value !== "boolean") {
        return Effect.fail(
          new ProviderGlobalOptionMutationError({
            message: "Taste Learning must be a boolean.",
          }),
        );
      }
      return Effect.succeed({
        args: ["taste", mutation.value ? "enable" : "disable", "--user"],
        expected: mutation.value,
      });
    }
    default:
      return Effect.fail(
        new ProviderGlobalOptionMutationError({
          message: `Unknown Command Code global option: ${mutation.optionId}`,
        }),
      );
  }
}

function boundedCommandDetail(result: CommandCodeGlobalOptionCommandResult): string {
  const detail = result.stderr.trim() || result.stdout.trim();
  return detail.length > 0 ? detail.slice(0, 1_000) : `exit code ${result.exitCode}`;
}

function settingValue(
  settings: CommandCodeGlobalSettings,
  optionId: ProviderGlobalOptionMutation["optionId"],
): string | boolean | undefined {
  switch (optionId) {
    case "compactMode":
      return settings.compactMode;
    case "tasteLearning":
      return settings.tasteLearning;
    default:
      return undefined;
  }
}

export const createCommandCodeGlobalOptionsController = Effect.fn(
  "createCommandCodeGlobalOptionsController",
)(function* <DependencyError>(dependencies: CommandCodeGlobalOptionsDependencies<DependencyError>) {
  const mutationSemaphore = yield* Semaphore.make(1);

  const readSettings = dependencies.settingsFilePath
    ? dependencies.readSettingsFile(dependencies.settingsFilePath).pipe(
        Effect.map(parseCommandCodeGlobalSettings),
        Effect.orElseSucceed(() => DEFAULT_SETTINGS),
      )
    : Effect.succeed(DEFAULT_SETTINGS);

  const readOptions = readSettings.pipe(Effect.map(commandCodeGlobalOptionsFromSettings));

  const setGlobalOptionBase = Effect.fn("CommandCodeGlobalOptions.setGlobalOption")(function* (
    mutation: ProviderGlobalOptionMutation,
  ) {
    const command = yield* commandForMutation(mutation);
    const settingsFilePath = dependencies.settingsFilePath;
    if (settingsFilePath === undefined) {
      return yield* new ProviderGlobalOptionMutationError({
        message: "Cannot resolve the Command Code settings path for this provider instance.",
      });
    }

    const commandEffect = dependencies
      .runCommand({
        args: command.args,
        maxStdoutBytes: COMMAND_CODE_GLOBAL_OPTION_OUTPUT_BYTES,
        maxStderrBytes: COMMAND_CODE_GLOBAL_OPTION_OUTPUT_BYTES,
      })
      .pipe(
        Effect.map((result) => ({ _tag: "CommandCompleted", result }) as const),
        Effect.catch((cause) => Effect.succeed({ _tag: "CommandFailed", cause } as const)),
      );

    const waitForExpectedSetting = (): Effect.Effect<{ readonly _tag: "SettingVerified" }, never> =>
      dependencies.readSettingsFile(settingsFilePath).pipe(
        Effect.map(parseCommandCodeGlobalSettings),
        Effect.flatMap((settings) =>
          settingValue(settings, mutation.optionId) === command.expected
            ? Effect.succeed({ _tag: "SettingVerified" } as const)
            : Effect.sleep(COMMAND_CODE_SETTINGS_POLL_INTERVAL).pipe(
                Effect.andThen(waitForExpectedSetting()),
              ),
        ),
        Effect.catch(() =>
          Effect.sleep(COMMAND_CODE_SETTINGS_POLL_INTERVAL).pipe(
            Effect.andThen(waitForExpectedSetting()),
          ),
        ),
      );

    // `--config` persists the value before Command Code enters its normal
    // interactive flow, so the verified write is the command's completion.
    const operation =
      mutation.optionId === "compactMode"
        ? Effect.raceFirst(commandEffect, waitForExpectedSetting())
        : commandEffect;
    const commandExit = yield* operation.pipe(
      Effect.timeoutOption(COMMAND_CODE_GLOBAL_OPTION_TIMEOUT_MS),
    );
    if (Option.isNone(commandExit)) {
      return yield* new ProviderGlobalOptionMutationError({
        message: "Command Code settings command timed out.",
      });
    }
    const outcome = commandExit.value;
    if (outcome._tag === "SettingVerified") return;
    if (outcome._tag === "CommandFailed") {
      return yield* new ProviderGlobalOptionMutationError({
        message: "Failed to run the Command Code settings command.",
        cause: outcome.cause,
      });
    }

    const result = outcome.result;
    if (result.stdoutTruncated || result.stderrTruncated) {
      return yield* new ProviderGlobalOptionMutationError({
        message: "Command Code settings command produced too much output.",
      });
    }
    if (mutation.optionId !== "compactMode" && result.exitCode !== 0) {
      return yield* new ProviderGlobalOptionMutationError({
        message: `Command Code settings command failed: ${boundedCommandDetail(result)}`,
      });
    }

    const verifiedDocument = yield* dependencies
      .readSettingsFile(settingsFilePath)
      .pipe(Effect.result);
    if (Result.isFailure(verifiedDocument)) {
      return yield* new ProviderGlobalOptionMutationError({
        message: "Could not read Command Code settings after the native command completed.",
        cause: verifiedDocument.failure,
      });
    }
    const verified = parseCommandCodeGlobalSettings(verifiedDocument.success);
    const actual = settingValue(verified, mutation.optionId);
    if (
      mutation.optionId === "compactMode" &&
      actual !== command.expected &&
      result.exitCode !== 0
    ) {
      return yield* new ProviderGlobalOptionMutationError({
        message: `Command Code settings command failed: ${boundedCommandDetail(result)}`,
      });
    }
    if (actual !== command.expected) {
      return yield* new ProviderGlobalOptionMutationError({
        message: `Command Code did not persist ${mutation.optionId}.`,
      });
    }
  });

  return {
    readOptions,
    setGlobalOption: (mutation: ProviderGlobalOptionMutation) =>
      mutationSemaphore.withPermits(1)(setGlobalOptionBase(mutation)),
  } as const;
});
