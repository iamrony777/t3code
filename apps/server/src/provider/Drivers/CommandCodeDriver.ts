import { CommandCodeSettings, ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Crypto from "effect/Crypto";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientError, HttpClientRequest } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { writeFileStringAtomically } from "../../atomicWrite.ts";
import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { collectUint8StreamText } from "../../stream/collectUint8StreamText.ts";
import { makeCommandCodeTextGeneration } from "../../textGeneration/CommandCodeTextGeneration.ts";
import {
  createCommandCodeCatalogController,
  type CommandCodeEffortProbeInput,
} from "../commandCodeCatalog.ts";
import {
  COMMAND_CODE_SETTINGS_MAX_BYTES,
  createCommandCodeGlobalOptionsController,
  resolveCommandCodeSettingsFilePath,
  type CommandCodeGlobalOptionCommandInput,
} from "../commandCodeGlobalOptions.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeCommandCodeAdapter } from "../Layers/CommandCodeAdapter.ts";
import {
  buildInitialCommandCodeProviderSnapshot,
  attachCommandCodeGlobalOptions,
  type CommandCodeCatalogSeed,
  type CommandCodeProviderProbeResult,
  enrichCommandCodeProviderSnapshot,
  probeCommandCodeProviderStatus,
} from "../Layers/CommandCodeProvider.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderGlobalOptionMutation,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  makePackageManagedProviderMaintenanceResolver,
  makeCachedProviderMaintenanceResolution,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "../providerMaintenance.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";

const decodeSettings = Schema.decodeSync(CommandCodeSettings);
const DRIVER_KIND = ProviderDriverKind.make("commandcode");
const UPDATE = makePackageManagedProviderMaintenanceResolver({
  provider: DRIVER_KIND,
  npmPackageName: "command-code",
  nativeUpdate: null,
});

export type CommandCodeDriverEnv =
  | BackgroundPolicy.BackgroundPolicy
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Path.Path
  | ServerConfig
  | ServerSettingsService;

class CommandCodeCatalogFetchError extends Data.TaggedError("CommandCodeCatalogFetchError")<{
  readonly detail: string;
}> {}

const PROBE_FORCE_KILL_AFTER = "1 second";

interface CommandCodeInventoryController {
  readonly activateInventory: (
    identity: CommandCodeCatalogSeed["identity"],
    cliModels: CommandCodeCatalogSeed["cliModels"],
  ) => Effect.Effect<void>;
  readonly clearInventory: () => Effect.Effect<void>;
}

export const activateCommandCodeCatalogForProbeResult = Effect.fn(
  "activateCommandCodeCatalogForProbeResult",
)(function* (
  controller: CommandCodeInventoryController,
  result: Pick<CommandCodeProviderProbeResult, "catalogSeed">,
) {
  if (result.catalogSeed === undefined) {
    yield* controller.clearInventory();
    return;
  }
  yield* controller.activateInventory(result.catalogSeed.identity, result.catalogSeed.cliModels);
});

export const makeCommandCodeEffortProbeCommand = Effect.fn("makeCommandCodeEffortProbeCommand")(
  function* (input: CommandCodeEffortProbeInput, environment: NodeJS.ProcessEnv) {
    const resolved = yield* resolveSpawnCommand(input.executable, input.args, {
      env: environment,
    });
    return ChildProcess.make(resolved.command, resolved.args, {
      env: environment,
      shell: resolved.shell,
      stdin: "ignore",
      forceKillAfter: PROBE_FORCE_KILL_AFTER,
    });
  },
);

export const makeCommandCodeCatalogControllerForProvider = Effect.fn(
  "makeCommandCodeCatalogControllerForProvider",
)(function* (environment: NodeJS.ProcessEnv) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const httpClient = yield* HttpClient.HttpClient;
  const serverConfig = yield* ServerConfig;

  return yield* createCommandCodeCatalogController<
    PlatformError.PlatformError | HttpClientError.HttpClientError | CommandCodeCatalogFetchError
  >({
    providerStatusCacheDir: serverConfig.providerStatusCacheDir,
    joinPath: path.join,
    readFile: fs.readFileString,
    writeFileAtomically: (filePath, contents) =>
      writeFileStringAtomically({ filePath, contents }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      ),
    fetchApiDocument: Effect.fn("CommandCodeCatalog.fetchApiDocument")(function* (input) {
      const response = yield* httpClient.execute(HttpClientRequest.get(input.url));
      if (response.status < 200 || response.status >= 300) {
        return yield* new CommandCodeCatalogFetchError({
          detail: `Command Code catalog API returned ${response.status}`,
        });
      }
      const contentLength = Number(response.headers["content-length"]);
      if (Number.isFinite(contentLength) && contentLength > input.maxBodyBytes) {
        return yield* new CommandCodeCatalogFetchError({
          detail: "Command Code catalog API response is too large",
        });
      }
      const collected = yield* collectUint8StreamText({
        stream: response.stream,
        maxBytes: input.maxBodyBytes + 1,
      });
      if (collected.bytes > input.maxBodyBytes || collected.truncated) {
        return yield* new CommandCodeCatalogFetchError({
          detail: "Command Code catalog API response is too large",
        });
      }
      return collected.text;
    }),
    probeEffort: Effect.fn("CommandCodeCatalog.probeEffort")(function* (input) {
      const command = yield* makeCommandCodeEffortProbeCommand(input, environment);
      const child = yield* spawner.spawn(command);
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          collectUint8StreamText({ stream: child.stdout, maxBytes: input.maxStdoutBytes }),
          collectUint8StreamText({ stream: child.stderr, maxBytes: input.maxStderrBytes }),
          child.exitCode,
        ],
        { concurrency: "unbounded" },
      );
      return {
        exitCode: Number(exitCode),
        stdout: stdout.text,
        stderr: stderr.text,
      };
    }, Effect.scoped),
  });
});

export const makeCommandCodeGlobalOptionCommand = Effect.fn("makeCommandCodeGlobalOptionCommand")(
  function* (
    settings: CommandCodeSettings,
    args: ReadonlyArray<string>,
    environment: NodeJS.ProcessEnv,
  ) {
    const binaryPath = settings.binaryPath || "command-code";
    const resolved = yield* resolveSpawnCommand(binaryPath, args, { env: environment });
    return ChildProcess.make(resolved.command, resolved.args, {
      env: environment,
      shell: resolved.shell,
      stdin: "ignore",
      forceKillAfter: PROBE_FORCE_KILL_AFTER,
    });
  },
);

export const makeCommandCodeGlobalOptionsControllerForProvider = Effect.fn(
  "makeCommandCodeGlobalOptionsControllerForProvider",
)(function* (settings: CommandCodeSettings, environment: NodeJS.ProcessEnv) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const settingsFilePath = resolveCommandCodeSettingsFilePath(environment, path.join);

  return yield* createCommandCodeGlobalOptionsController<PlatformError.PlatformError>({
    settingsFilePath,
    readSettingsFile: (filePath) =>
      fs
        .stat(filePath)
        .pipe(
          Effect.flatMap((info) =>
            info.size > BigInt(COMMAND_CODE_SETTINGS_MAX_BYTES)
              ? Effect.succeed("")
              : fs.readFileString(filePath),
          ),
        ),
    runCommand: Effect.fn("CommandCodeGlobalOptions.runCommand")(function* (
      input: CommandCodeGlobalOptionCommandInput,
    ) {
      const command = yield* makeCommandCodeGlobalOptionCommand(settings, input.args, environment);
      const child = yield* spawner.spawn(command);
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          collectUint8StreamText({ stream: child.stdout, maxBytes: input.maxStdoutBytes }),
          collectUint8StreamText({ stream: child.stderr, maxBytes: input.maxStderrBytes }),
          child.exitCode,
        ],
        { concurrency: "unbounded" },
      );
      return {
        exitCode: Number(exitCode),
        stdout: stdout.text,
        stderr: stderr.text,
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
      };
    }, Effect.scoped),
  });
});

const withInstanceIdentity =
  (input: {
    readonly instanceId: ProviderInstance["instanceId"];
    readonly displayName: string | undefined;
    readonly accentColor: string | undefined;
    readonly continuationGroupKey: string;
  }) =>
  (snapshot: ServerProviderDraft): ServerProvider => ({
    ...snapshot,
    instanceId: input.instanceId,
    driver: DRIVER_KIND,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    continuation: { groupKey: input.continuationGroupKey },
  });

export const CommandCodeDriver: ProviderDriver<CommandCodeSettings, CommandCodeDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Command Code",
    supportsMultipleInstances: true,
  },
  configSchema: CommandCodeSettings,
  defaultConfig: () => decodeSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const httpClient = yield* HttpClient.HttpClient;
      const path = yield* Path.Path;
      const serverSettings = yield* ServerSettingsService;
      const { cwd, attachmentsDir } = yield* ServerConfig;
      const processEnv = mergeProviderInstanceEnvironment(environment);
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const stampIdentity = withInstanceIdentity({
        instanceId,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      const effectiveConfig = { ...config, enabled } satisfies CommandCodeSettings;
      const catalogController = yield* makeCommandCodeCatalogControllerForProvider(processEnv);
      const globalOptionsController = yield* makeCommandCodeGlobalOptionsControllerForProvider(
        effectiveConfig,
        processEnv,
      );
      const readGlobalOptions = globalOptionsController.readOptions;
      const catalogSeedRef = yield* Ref.make<CommandCodeCatalogSeed | undefined>(undefined);
      const resolveMaintenance = yield* makeCachedProviderMaintenanceResolution(
        resolveProviderMaintenanceCapabilitiesEffect(UPDATE, {
          binaryPath: effectiveConfig.binaryPath,
          env: processEnv,
        }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        ),
      );

      const adapter = yield* makeCommandCodeAdapter(effectiveConfig, {
        instanceId,
        catalogController,
        environment: processEnv,
        attachmentsDir,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: cause.message ?? String(cause),
              cause,
            }),
        ),
      );
      const textGeneration = yield* makeCommandCodeTextGeneration(
        effectiveConfig,
        catalogController,
        processEnv,
      );
      const checkProvider = probeCommandCodeProviderStatus(
        effectiveConfig,
        instanceId,
        processEnv,
        cwd,
      ).pipe(
        Effect.tap((result) =>
          Effect.gen(function* () {
            yield* Ref.set(catalogSeedRef, result.catalogSeed);
            yield* activateCommandCodeCatalogForProbeResult(catalogController, result);
          }),
        ),
        Effect.flatMap((result) =>
          readGlobalOptions.pipe(
            Effect.map((globalOptions) =>
              stampIdentity(attachCommandCodeGlobalOptions(result.snapshot, globalOptions)),
            ),
          ),
        ),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      );
      const snapshotSettings = makeProviderSnapshotSettingsSource(effectiveConfig, serverSettings);
      const snapshot = yield* makeManagedServerProvider<
        ProviderSnapshotSettings<CommandCodeSettings>
      >({
        resolveMaintenance,
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          buildInitialCommandCodeProviderSnapshot(settings.provider).pipe(
            Effect.flatMap((initial) =>
              readGlobalOptions.pipe(
                Effect.map((globalOptions) =>
                  stampIdentity(attachCommandCodeGlobalOptions(initial, globalOptions)),
                ),
              ),
            ),
          ),
        checkProvider,
        enrichSnapshot: ({ settings, snapshot, getSnapshot, publishSnapshot }) =>
          Effect.gen(function* () {
            const maintenanceCapabilities = yield* resolveMaintenance();
            const seed = yield* Ref.get(catalogSeedRef);
            if (seed !== undefined) {
              yield* enrichCommandCodeProviderSnapshot({
                controller: catalogController,
                settings: settings.provider,
                snapshot,
                seed,
                getSnapshot,
                enrichAdvisory: (currentSnapshot) =>
                  enrichProviderSnapshotWithVersionAdvisory(
                    currentSnapshot,
                    maintenanceCapabilities,
                    {
                      enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
                    },
                  ).pipe(Effect.provideService(HttpClient.HttpClient, httpClient)),
                publishSnapshot: (nextSnapshot) =>
                  publishSnapshot({ ...snapshot, ...nextSnapshot }),
              });
              return;
            }
            const currentSnapshot = yield* getSnapshot;
            const advised = yield* enrichProviderSnapshotWithVersionAdvisory(
              currentSnapshot,
              maintenanceCapabilities,
              {
                enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
              },
            ).pipe(Effect.provideService(HttpClient.HttpClient, httpClient));
            yield* publishSnapshot(advised);
          }),
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build Command Code snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );

      // The controller only reports success once it has read the new value back
      // out of `~/.commandcode/config.json`, and global options are the only
      // part of the snapshot that file feeds. So re-reading the file and
      // patching the live snapshot is exactly as truthful as a full probe, at
      // one file read instead of two CLI round-trips.
      const setGlobalOption = Effect.fn("CommandCodeDriver.setGlobalOption")(function* (
        mutation: ProviderGlobalOptionMutation,
      ) {
        yield* globalOptionsController.setGlobalOption(mutation);
        const globalOptions = yield* readGlobalOptions;
        return yield* snapshot.updateSnapshot((current) =>
          attachCommandCodeGlobalOptions(current, globalOptions),
        );
      });

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        adapter,
        textGeneration,
        setGlobalOption,
      } satisfies ProviderInstance;
    }),
};
