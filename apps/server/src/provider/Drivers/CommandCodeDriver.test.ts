import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { CommandCodeSettings, ProviderInstanceId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerSettingsModule from "../../serverSettings.ts";
import { CommandCodeDriver } from "./CommandCodeDriver.ts";

const decodeSettings = Schema.decodeSync(CommandCodeSettings);
const SettingsDocument = Schema.fromJsonString(
  Schema.Struct({ compactMode: Schema.String, tasteLearning: Schema.Boolean }),
);
const encodeSettingsDocument = Schema.encodeSync(SettingsDocument);
const decodeSettingsDocument = Schema.decodeUnknownSync(SettingsDocument);
const TEST_EPOCH = DateTime.makeUnsafe("1970-01-01T00:00:00.000Z");

const StubHttpClientLive = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ version: "0.0.0" }))),
  ),
);

const BackgroundPolicyAlwaysRunLayer = Layer.mock(BackgroundPolicy.BackgroundPolicy)({
  reportClientActivity: () => Effect.void,
  removeRpcClient: () => Effect.void,
  reportHostPowerState: () => Effect.void,
  snapshot: Effect.succeed({
    hostPower: {
      source: "unknown",
      idle: "unknown",
      idleSeconds: null,
      locked: "unknown",
      suspended: false,
      onBattery: "unknown",
      lowPowerMode: "unknown",
      thermalState: "unknown",
      stale: true,
      updatedAt: TEST_EPOCH,
    },
    leases: [],
    activeForegroundLeaseCount: 0,
    activeScopeKeys: [],
    shouldRunOpportunisticWork: true,
    updatedAt: TEST_EPOCH,
  }),
  streamChanges: Stream.empty,
  hasDemand: () => Effect.succeed(true),
  shouldRunScopeWork: () => Effect.succeed(true),
  shouldRunOpportunisticWork: Effect.succeed(true),
});

const DriverLayer = Layer.mergeAll(
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-command-code-driver-" }).pipe(
    Layer.provide(NodeServices.layer),
  ),
  ServerSettingsModule.layerTest(),
  StubHttpClientLive,
  BackgroundPolicyAlwaysRunLayer,
).pipe(Layer.provideMerge(NodeServices.layer));

/**
 * Fake `command-code` that only knows how to persist compact mode. Everything
 * else — probe subcommands included — exits nonzero without touching the
 * settings file, which is how the failure case below is provoked.
 */
const FAKE_CLI = [
  "#!/bin/sh",
  'settings="$HOME/.commandcode/config.json"',
  'if [ "$1" = "--config" ] && [ "$2" = "compact-mode=fast" ]; then',
  '  printf \'%s\' \'{"compactMode":"fast","tasteLearning":true}\' > "$settings"',
  "else",
  "  exit 7",
  "fi",
].join("\n");

const setUpInstance = Effect.fn("setUpInstance")(function* (spawnedArgs: Array<string>) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-command-code-driver-home-" });
  const commandCodeDir = path.join(home, ".commandcode");
  const settingsFile = path.join(commandCodeDir, "config.json");
  const executable = path.join(home, "command-code");
  yield* fs.makeDirectory(commandCodeDir, { recursive: true });
  yield* fs.writeFileString(
    settingsFile,
    encodeSettingsDocument({ compactMode: "default", tasteLearning: true }),
  );
  yield* fs.writeFileString(executable, FAKE_CLI);
  yield* fs.chmod(executable, 0o755);

  // Wrap the real spawner so the fake CLI still runs (the controller's
  // read-after-write check must be real) while every argv is recorded.
  const baseSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const recordingSpawner = ChildProcessSpawner.make((command) => {
    spawnedArgs.push((command as { readonly args: ReadonlyArray<string> }).args.join(" "));
    return baseSpawner.spawn(command);
  });

  const instance = yield* CommandCodeDriver.create({
    instanceId: ProviderInstanceId.make("commandcode"),
    displayName: undefined,
    // `HOME` points the driver at the temp config.json, never the developer's.
    environment: [{ name: "HOME", value: home, sensitive: false }],
    // Disabled keeps the managed provider's startup probe off the CLI
    // entirely, so anything recorded in `spawnedArgs` can only have come from
    // the mutation under test. The global-option seam behaves identically
    // either way — it never consults the probe.
    enabled: false,
    config: decodeSettings({ binaryPath: executable }),
  }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, recordingSpawner));
  const setGlobalOption = instance.setGlobalOption;
  if (setGlobalOption === undefined) {
    return yield* Effect.die(new Error("Command Code driver must expose setGlobalOption"));
  }
  // Startup work is forked; let it settle before we start counting so a late
  // boot spawn could never be mistaken for one the mutation caused.
  yield* Effect.yieldNow;
  spawnedArgs.length = 0;

  return { instance, setGlobalOption, settingsFile } as const;
});

const compactMode = (options: ReadonlyArray<{ readonly id: string }>) =>
  options.find((option) => option.id === "compactMode");

const tasteLearning = (options: ReadonlyArray<{ readonly id: string }>) =>
  options.find((option) => option.id === "tasteLearning");

describe("CommandCodeDriver.setGlobalOption", () => {
  it.effect("applies the new value without spawning a provider probe", () => {
    const spawnedArgs: Array<string> = [];
    return Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { instance, setGlobalOption, settingsFile } = yield* setUpInstance(spawnedArgs);

        const before = yield* instance.snapshot.getSnapshot;
        expect(compactMode(before.globalOptions)).toMatchObject({ currentValue: "default" });

        const updated = yield* setGlobalOption({ optionId: "compactMode", value: "fast" });

        // The mutation itself is the only thing allowed to reach the CLI: no
        // `--version`, no `auth status`, no `status --json`.
        expect(spawnedArgs).toEqual(["--config compact-mode=fast"]);
        expect(decodeSettingsDocument(yield* fs.readFileString(settingsFile))).toMatchObject({
          compactMode: "fast",
        });

        // The returned snapshot is what the RPC hands back, so it must already
        // carry the new value — nothing waits on the change stream.
        expect(updated?.instanceId).toBe("commandcode");
        expect(compactMode(updated?.globalOptions ?? [])).toMatchObject({ currentValue: "fast" });

        // ...and the instance's own state agrees, so later readers and
        // `streamChanges` subscribers converge on the same value.
        const after = yield* instance.snapshot.getSnapshot;
        expect(compactMode(after.globalOptions)).toMatchObject({ currentValue: "fast" });
      }),
    ).pipe(Effect.provide(DriverLayer));
  });

  it.effect("leaves the snapshot alone when the native mutation fails", () => {
    const spawnedArgs: Array<string> = [];
    return Effect.scoped(
      Effect.gen(function* () {
        const { instance, setGlobalOption } = yield* setUpInstance(spawnedArgs);

        const failure = yield* setGlobalOption({ optionId: "tasteLearning", value: false }).pipe(
          Effect.flip,
        );

        expect(failure._tag).toBe("ProviderGlobalOptionMutationError");
        expect(spawnedArgs).toEqual(["taste disable --user"]);
        const after = yield* instance.snapshot.getSnapshot;
        expect(tasteLearning(after.globalOptions)).toMatchObject({ currentValue: true });
      }),
    ).pipe(Effect.provide(DriverLayer));
  });
});
