/**
 * ClaudeDriver — `ProviderDriver` for the Claude Agent SDK runtime.
 *
 * Mirrors `CodexDriver`: a plain value whose `create()` returns one
 * `ProviderInstance` bundling `snapshot` / `adapter` / `textGeneration`
 * closures captured over the per-instance `ClaudeSettings`.
 *
 * Unlike Codex, the Claude snapshot probe may invoke a secondary probe
 * (`probeClaudeCapabilities`) to read Anthropic account + slash-command
 * metadata. That probe is per-instance and keyed by binary + resolved HOME so
 * two concurrent Claude instances don't cross-contaminate account metadata.
 *
 * @module provider/Drivers/ClaudeDriver
 */
import { ClaudeSettings, ProviderDriverKind } from "@t3tools/contracts";
import * as Cache from "effect/Cache";
import * as Duration from "effect/Duration";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import { makeClaudeTextGeneration } from "../../textGeneration/ClaudeTextGeneration.ts";
import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { expandHomePath } from "../../pathExpansion.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeClaudeAdapter } from "../Layers/ClaudeAdapter.ts";
import {
  ClaudeActiveUsageProbe,
  ClaudeActiveUsageProbeError,
} from "../Layers/ClaudeActiveUsageProbe.ts";
import { makeClaudeScopedLimitNames } from "../Layers/claudeUsageLimits.ts";
import {
  checkClaudeProviderStatus,
  makePendingClaudeProvider,
  probeClaudeCapabilities,
} from "../Layers/ClaudeProvider.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { resolveClaudeModelCatalog } from "../ClaudeModelCatalog.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import * as ModelManifest from "../ModelManifest.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { withInstanceIdentity } from "./instanceIdentity.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  makeCachedProviderMaintenanceResolution,
  makePackageManagedProviderMaintenanceResolver,
  normalizeCommandPath,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "../providerMaintenance.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";
import {
  makeClaudeCapabilitiesCacheKey,
  makeClaudeContinuationGroupKey,
  makeClaudeEnvironment,
  resolveClaudeConfigDirectoryPath,
} from "./ClaudeHome.ts";
import { resolveClaudeSdkExecutablePath } from "./ClaudeExecutable.ts";
import { discoverClaudeSkills } from "./ClaudeSkills.ts";
import { resolveUsageLimitsAfterProbe } from "../providerUsageLimits.ts";
const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);

const DRIVER_KIND = ProviderDriverKind.make("claudeAgent");
const CAPABILITIES_PROBE_TTL = Duration.minutes(5);

export function getClaudeCapabilitiesForRefresh<Key, A, E, R>(
  cache: Cache.Cache<Key, A, E, R>,
  key: Key,
  refreshUsageLimits: boolean,
): Effect.Effect<A, E, R> {
  return refreshUsageLimits
    ? Cache.invalidate(cache, key).pipe(Effect.andThen(Cache.get(cache, key)))
    : Cache.get(cache, key);
}

const isClaudeAccountEnvironmentName = (name: string): boolean => {
  const normalized = name.toUpperCase();
  return (
    normalized === "HOME" ||
    normalized === "USERPROFILE" ||
    normalized.startsWith("ANTHROPIC_") ||
    normalized.startsWith("CLAUDE_") ||
    normalized.startsWith("AWS_") ||
    normalized.startsWith("GOOGLE_") ||
    normalized.startsWith("VERTEX_")
  );
};

export const makeClaudeActiveUsageCooldownKey = Effect.fn("makeClaudeActiveUsageCooldownKey")(
  function* (input: {
    readonly instanceId: string;
    readonly profilePath: string;
    readonly environment: NodeJS.ProcessEnv;
  }) {
    const crypto = yield* Crypto.Crypto;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const credentialMaterial = yield* fileSystem
      .readFileString(path.join(input.profilePath, ".credentials.json"))
      .pipe(Effect.orElseSucceed(() => "<missing>"));
    const environmentMaterial = Object.entries(input.environment)
      .filter(([name]) => isClaudeAccountEnvironmentName(name))
      .toSorted(([left], [right]) => left.toUpperCase().localeCompare(right.toUpperCase()))
      .map(
        ([name, value]) =>
          `${name.toUpperCase().length}:${name.toUpperCase()}${value?.length ?? 0}:${value ?? ""}`,
      )
      .join(";");
    const material = `${input.instanceId.length}:${input.instanceId}|${environmentMaterial}|${credentialMaterial}`;
    const digest = yield* crypto.digest("SHA-256", new TextEncoder().encode(material));
    return Encoding.encodeHex(digest);
  },
);

function isClaudeNativeCommandPath(commandPath: string): boolean {
  const normalized = normalizeCommandPath(commandPath);
  return (
    normalized.endsWith("/.local/bin/claude") ||
    normalized.endsWith("/.local/bin/claude.exe") ||
    normalized.includes("/.local/share/claude/")
  );
}

const UPDATE = makePackageManagedProviderMaintenanceResolver({
  provider: DRIVER_KIND,
  npmPackageName: "@anthropic-ai/claude-code",
  nativeUpdate: {
    args: ["update"],
    isCommandPath: isClaudeNativeCommandPath,
  },
});

export type ClaudeDriverEnv =
  | BackgroundPolicy.BackgroundPolicy
  | ChildProcessSpawner.ChildProcessSpawner
  | ClaudeActiveUsageProbe
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | ModelManifest.ModelManifest
  | Path.Path
  | ProviderEventLoggers
  | ServerConfig
  | ServerSettingsService;

export const ClaudeDriver: ProviderDriver<ClaudeSettings, ClaudeDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Claude",
    supportsMultipleInstances: true,
  },
  configSchema: ClaudeSettings,
  defaultConfig: (): ClaudeSettings => decodeClaudeSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const crypto = yield* Crypto.Crypto;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { cwd } = yield* ServerConfig;
      const httpClient = yield* HttpClient.HttpClient;
      const serverSettings = yield* ServerSettingsService;
      const eventLoggers = yield* ProviderEventLoggers;
      const modelManifest = yield* ModelManifest.ModelManifest;
      const activeUsageProbe = yield* ClaudeActiveUsageProbe;
      const modelCatalog = modelManifest.current.pipe(Effect.map(resolveClaudeModelCatalog));
      const processEnv = mergeProviderInstanceEnvironment(environment);
      const fallbackContinuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const effectiveConfig = {
        ...config,
        enabled,
        binaryPath: expandHomePath(config.binaryPath),
      } satisfies ClaudeSettings;
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
      const continuationGroupKey = yield* makeClaudeContinuationGroupKey(effectiveConfig);
      const stampIdentity = withInstanceIdentity({
        instanceId,
        driverKind: DRIVER_KIND,
        displayName,
        accentColor,
        continuationGroupKey,
      });

      // One per instance: the status probe writes the model-scoped bucket
      // names it saw, the adapter reads them to place turn-driven events.
      const scopedLimitNames = yield* makeClaudeScopedLimitNames;
      const adapterOptions = {
        instanceId,
        environment: processEnv,
        modelCatalog,
        scopedLimitNames,
        ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
      };
      const adapter = yield* makeClaudeAdapter(effectiveConfig, adapterOptions);
      const textGeneration = yield* makeClaudeTextGeneration(
        effectiveConfig,
        processEnv,
        modelCatalog,
      );

      // Per-instance capabilities cache: keyed on binary + resolved HOME so
      // account-specific probes never share auth metadata across instances.
      const capabilitiesProbeCache = yield* Cache.make({
        capacity: 1,
        timeToLive: CAPABILITIES_PROBE_TTL,
        lookup: () =>
          probeClaudeCapabilities(effectiveConfig, processEnv, cwd).pipe(
            Effect.provideService(Path.Path, path),
          ),
      });
      const capabilitiesCacheKey = yield* makeClaudeCapabilitiesCacheKey(effectiveConfig, cwd);
      const resolvedActiveProbeEnvironment = yield* makeClaudeEnvironment(
        effectiveConfig,
        processEnv,
      );
      const activeProbeProfileKey = yield* resolveClaudeConfigDirectoryPath(
        effectiveConfig,
        processEnv,
      );
      const activeProbeEnvironment = {
        ...resolvedActiveProbeEnvironment,
        CLAUDE_CONFIG_DIR: activeProbeProfileKey,
      };
      const activeProbeExecutablePath = yield* resolveClaudeSdkExecutablePath(
        effectiveConfig.binaryPath,
        activeProbeEnvironment,
      );

      // Start the TTL-gated refresh without delaying provider readiness. The
      // next check observes a remote manifest after the background fetch lands.
      const checkProviderWithUsageRefresh = (refreshUsageLimits: boolean) =>
        modelManifest.refreshInBackground.pipe(
          Effect.andThen(
            modelManifest.current.pipe(
              Effect.flatMap((manifest) =>
                checkClaudeProviderStatus(
                  effectiveConfig,
                  () =>
                    getClaudeCapabilitiesForRefresh(
                      capabilitiesProbeCache,
                      capabilitiesCacheKey,
                      refreshUsageLimits,
                    ),
                  processEnv,
                  cwd,
                  resolveClaudeModelCatalog(manifest),
                  scopedLimitNames,
                  {
                    refreshUsageLimits,
                    probe: makeClaudeActiveUsageCooldownKey({
                      instanceId,
                      profilePath: activeProbeProfileKey,
                      environment: activeProbeEnvironment,
                    }).pipe(
                      Effect.provideService(Crypto.Crypto, crypto),
                      Effect.provideService(FileSystem.FileSystem, fileSystem),
                      Effect.provideService(Path.Path, path),
                      Effect.mapError(
                        (cause) =>
                          new ClaudeActiveUsageProbeError({
                            reason: "spawnFailed",
                            message: "Claude usage probe could not fingerprint its auth context.",
                            cause,
                          }),
                      ),
                      Effect.flatMap((cooldownKey) =>
                        activeUsageProbe.probe({
                          profileKey: activeProbeProfileKey,
                          cooldownKey,
                          executablePath: activeProbeExecutablePath,
                          environment: activeProbeEnvironment,
                        }),
                      ),
                    ),
                  },
                ),
              ),
              Effect.map(stampIdentity),
            ),
          ),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        );
      const checkProvider = checkProviderWithUsageRefresh(false);

      const snapshotSettings = makeProviderSnapshotSettingsSource(effectiveConfig, serverSettings);
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<ClaudeSettings>>({
        resolveMaintenance,
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          modelManifest.current.pipe(
            Effect.flatMap((manifest) =>
              makePendingClaudeProvider(settings.provider, resolveClaudeModelCatalog(manifest)),
            ),
            Effect.map(stampIdentity),
          ),
        checkProvider,
        enrichSnapshot: ({ settings, snapshot, publishSnapshot }) =>
          resolveMaintenance().pipe(
            Effect.flatMap((maintenanceCapabilities) =>
              enrichProviderSnapshotWithVersionAdvisory(snapshot, maintenanceCapabilities, {
                enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
              }),
            ),
            Effect.provideService(HttpClient.HttpClient, httpClient),
            Effect.flatMap((enrichedSnapshot) => publishSnapshot(enrichedSnapshot)),
          ),
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build Claude snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );
      const snapshotForCwd = (cwd: string) =>
        !effectiveConfig.enabled
          ? snapshot.getSnapshot
          : Effect.all([
              snapshot.getSnapshot,
              discoverClaudeSkills(effectiveConfig, cwd, processEnv),
            ]).pipe(
              Effect.map(([machineSnapshot, skills]) => ({ ...machineSnapshot, skills })),
              Effect.provideService(FileSystem.FileSystem, fileSystem),
              Effect.provideService(Path.Path, path),
            );
      const refreshUsageLimits = () =>
        checkProviderWithUsageRefresh(true).pipe(
          Effect.flatMap((probedSnapshot) =>
            snapshot.updateSnapshot((publishedSnapshot) => {
              const usageLimits = resolveUsageLimitsAfterProbe({
                published: publishedSnapshot.usageLimits,
                probed: probedSnapshot.usageLimits,
              });
              const { usageLimits: _probedUsageLimits, ...rest } = probedSnapshot;
              return usageLimits ? { ...rest, usageLimits } : rest;
            }),
          ),
          Effect.mapError(
            (cause) =>
              new ProviderDriverError({
                driver: DRIVER_KIND,
                instanceId,
                detail: "Failed to refresh Claude subscription usage limits.",
                cause,
              }),
          ),
        );

      const usageKeepaliveHours = Number(effectiveConfig.usageKeepaliveHours);
      if (effectiveConfig.enabled && usageKeepaliveHours > 0) {
        yield* Effect.forever(
          Effect.sleep(Duration.hours(usageKeepaliveHours)).pipe(
            Effect.andThen(refreshUsageLimits()),
            Effect.ignoreCause({ log: true }),
          ),
        ).pipe(Effect.forkScoped);
      }

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity: {
          ...fallbackContinuationIdentity,
          continuationKey: continuationGroupKey,
        },
        displayName,
        accentColor,
        enabled,
        snapshot,
        snapshotForCwd,
        refreshUsageLimits,
        adapter,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};
