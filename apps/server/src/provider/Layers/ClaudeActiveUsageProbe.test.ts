import * as NodeServices from "@effect/platform-node/NodeServices";
import { HostProcessExecutablePath, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import { assert, describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";

import * as PtyAdapter from "../../terminal/PtyAdapter.ts";
import * as NodePtyAdapter from "../../terminal/NodePtyAdapter.ts";

import {
  isClaudeSubscriptionQuotaProfile,
  makeClaudeActiveUsageProbe,
  parseClaudeUsageTuiOutput,
  resolveClaudeActiveUsageProbeLaunch,
  shouldRunClaudeActiveUsageProbe,
} from "./ClaudeActiveUsageProbe.ts";

const subscriptionCapabilities = {
  subscriptionType: "pro",
  tokenSource: "oauth",
  apiProvider: "firstParty",
  rateLimitsAvailable: true,
  hasRateLimitWindows: false,
};

describe("shouldRunClaudeActiveUsageProbe", () => {
  it("classifies only first-party OAuth subscriptions as quota profiles", () => {
    expect(
      isClaudeSubscriptionQuotaProfile({
        capabilities: subscriptionCapabilities,
        environment: {},
      }),
    ).toBe(true);
    expect(
      isClaudeSubscriptionQuotaProfile({
        capabilities: { ...subscriptionCapabilities, tokenSource: "api-key" },
        environment: {},
      }),
    ).toBe(false);
    expect(
      isClaudeSubscriptionQuotaProfile({
        capabilities: subscriptionCapabilities,
        environment: { ANTHROPIC_BASE_URL: "https://proxy.example.test" },
      }),
    ).toBe(false);
  });

  it("requires an explicit manual limits refresh", () => {
    expect(
      shouldRunClaudeActiveUsageProbe({
        refreshUsageLimits: false,
        capabilities: subscriptionCapabilities,
        environment: {},
      }),
    ).toBe(false);
  });

  it("allows a first-party subscription whose passive usage omitted windows", () => {
    expect(
      shouldRunClaudeActiveUsageProbe({
        refreshUsageLimits: true,
        capabilities: subscriptionCapabilities,
        environment: {},
      }),
    ).toBe(true);
    expect(
      shouldRunClaudeActiveUsageProbe({
        refreshUsageLimits: true,
        capabilities: { ...subscriptionCapabilities, subscriptionType: "claudeTeamSubscription" },
        environment: {},
      }),
    ).toBe(true);
    expect(
      shouldRunClaudeActiveUsageProbe({
        refreshUsageLimits: true,
        capabilities: { ...subscriptionCapabilities, subscriptionType: "Claude Max" },
        environment: {},
      }),
    ).toBe(true);
    expect(
      shouldRunClaudeActiveUsageProbe({
        refreshUsageLimits: true,
        capabilities: { ...subscriptionCapabilities, subscriptionType: "maxplan" },
        environment: {},
      }),
    ).toBe(true);
  });

  it("rejects free, API-token, third-party, custom-base, and already-populated probes", () => {
    const rejected = [
      { capabilities: { ...subscriptionCapabilities, subscriptionType: "free" }, environment: {} },
      {
        capabilities: { ...subscriptionCapabilities, subscriptionType: "unknown-paid-ish-plan" },
        environment: {},
      },
      {
        capabilities: { ...subscriptionCapabilities, subscriptionType: "claude_free_plan" },
        environment: {},
      },
      { capabilities: { ...subscriptionCapabilities, tokenSource: "api-key" }, environment: {} },
      {
        capabilities: { ...subscriptionCapabilities, tokenSource: "ANTHROPIC_AUTH_TOKEN" },
        environment: {},
      },
      { capabilities: { ...subscriptionCapabilities, apiProvider: "bedrock" }, environment: {} },
      {
        capabilities: { ...subscriptionCapabilities, rateLimitsAvailable: false },
        environment: {},
      },
      { capabilities: { ...subscriptionCapabilities, hasRateLimitWindows: true }, environment: {} },
      { capabilities: subscriptionCapabilities, environment: { ANTHROPIC_API_KEY: "secret" } },
      { capabilities: subscriptionCapabilities, environment: { anthropic_Api_Key: "secret" } },
      { capabilities: subscriptionCapabilities, environment: { AnThRoPiC_aUtH_tOkEn: "secret" } },
      {
        capabilities: subscriptionCapabilities,
        environment: { anthropic_Base_Url: "https://proxy.example.test" },
      },
      { capabilities: subscriptionCapabilities, environment: { claude_code_use_BedRock: "1" } },
      { capabilities: subscriptionCapabilities, environment: { ANTHROPIC_AUTH_TOKEN: "secret" } },
      {
        capabilities: subscriptionCapabilities,
        environment: { ANTHROPIC_BASE_URL: "https://proxy.example.test" },
      },
      {
        capabilities: subscriptionCapabilities,
        environment: { CLAUDE_CODE_API_BASE_URL: "https://gateway.example.test" },
      },
      {
        capabilities: subscriptionCapabilities,
        environment: { ANTHROPIC_BEDROCK_BASE_URL: "https://bedrock.example.test" },
      },
      { capabilities: subscriptionCapabilities, environment: { CLAUDE_CODE_USE_BEDROCK: "1" } },
      {
        capabilities: subscriptionCapabilities,
        environment: { CLAUDE_CODE_USE_ANTHROPIC_AWS: "1" },
      },
      { capabilities: subscriptionCapabilities, environment: { CLAUDE_CODE_USE_VERTEX: "true" } },
      { capabilities: subscriptionCapabilities, environment: { CLAUDE_CODE_USE_FOUNDRY: "true" } },
    ];

    for (const input of rejected) {
      expect(
        shouldRunClaudeActiveUsageProbe({
          refreshUsageLimits: true,
          ...input,
        }),
      ).toBe(false);
    }
  });
});

describe("parseClaudeUsageTuiOutput", () => {
  it("maps the flat current-session and all-models weekly rows", () => {
    expect(
      parseClaudeUsageTuiOutput(
        [
          "Plan usage limits",
          "Current session",
          "12.5% used",
          "Resets in 2 hours 54 minutes",
          "Current week (all models)",
          "34% used",
          "Resets Sep 12 at 4:00 PM",
          "Current week (Sonnet)",
          "99% used",
        ].join("\n"),
        "2027-01-15T08:00:00.000Z",
      ),
    ).toEqual({
      checkedAt: "2027-01-15T08:00:00.000Z",
      windows: [
        {
          id: "five_hour",
          kind: "session",
          label: "Session",
          windowDurationMins: 300,
          usedPercent: 12.5,
          resetsAt: "2027-01-15T10:54:00.000Z",
        },
        {
          id: "seven_day",
          kind: "weekly",
          label: "Weekly",
          windowDurationMins: 10_080,
          usedPercent: 34,
          resetsAt: "2027-09-12T16:00:00.000Z",
        },
      ],
    });
  });

  it("accepts same-line and ANSI-rendered usage while ignoring model-specific rows", () => {
    expect(
      parseClaudeUsageTuiOutput(
        "\u001b[1mCurrent session\u001b[0m 18% used · resets 5:49pm (Europe/Kyiv)\r\n" +
          "Weekly limit 41% used · resets Mon 12:00am (Europe/Kyiv)\r\n" +
          "Current week (Opus) 100% used",
        "2027-01-15T08:00:00.000Z",
      )?.windows.map(({ id, usedPercent, resetsAt }) => ({ id, usedPercent, resetsAt })),
    ).toEqual([
      { id: "five_hour", usedPercent: 18, resetsAt: "2027-01-15T15:49:00.000Z" },
      { id: "seven_day", usedPercent: 41, resetsAt: "2027-01-17T22:00:00.000Z" },
    ]);
  });

  it("parses current duplicate percentages and a comma-separated month-day reset", () => {
    expect(
      parseClaudeUsageTuiOutput(
        [
          "Current session",
          "0% 0% used",
          "Resets 11:09pm (Asia/Kolkata)",
          "Current week (all models)",
          "9% 9% used",
          "Resets Sep 8, 4:29am (Asia/Kolkata)",
          "Current week (Fable)",
          "12% 12% used",
        ].join("\n"),
        "2026-09-06T12:46:00.000Z",
      )?.windows.map(({ id, usedPercent, resetsAt }) => ({ id, usedPercent, resetsAt })),
    ).toEqual([
      { id: "five_hour", usedPercent: 0, resetsAt: "2026-09-06T17:39:00.000Z" },
      { id: "seven_day", usedPercent: 9, resetsAt: "2026-09-07T22:59:00.000Z" },
    ]);
  });

  it("omits only an unparseable window reset", () => {
    expect(
      parseClaudeUsageTuiOutput(
        "Current session 18% used · resets next billing interval\n" +
          "Current week (all models) 41% used · resets in 1 day",
        "2027-01-15T08:00:00.000Z",
      )?.windows,
    ).toEqual([
      {
        id: "five_hour",
        kind: "session",
        label: "Session",
        windowDurationMins: 300,
        usedPercent: 18,
      },
      {
        id: "seven_day",
        kind: "weekly",
        label: "Weekly",
        windowDurationMins: 10_080,
        usedPercent: 41,
        resetsAt: "2027-01-16T08:00:00.000Z",
      },
    ]);
  });

  it("excludes model-specific weekly labels unless an all-models row is present", () => {
    const checkedAt = "2027-01-15T08:00:00.000Z";
    expect(
      parseClaudeUsageTuiOutput("Weekly limit (Opus) 91% used · resets in 1 day", checkedAt),
    ).toBeUndefined();
    expect(
      parseClaudeUsageTuiOutput(
        "Weekly limit 41% used · resets in 2 days\n" +
          "Current week (Opus) 91% used · resets in 1 day",
        checkedAt,
      )?.windows,
    ).toEqual([
      {
        id: "seven_day",
        kind: "weekly",
        label: "Weekly",
        windowDurationMins: 10_080,
        usedPercent: 41,
        resetsAt: "2027-01-17T08:00:00.000Z",
      },
    ]);
  });

  it("parses ISO, 10-digit epoch, and 13-digit epoch reset timestamps", () => {
    const checkedAt = "2027-01-15T08:00:00.000Z";
    const resetsAt = (reset: string) =>
      parseClaudeUsageTuiOutput(`Current session 1% used · resets ${reset}`, checkedAt)?.windows[0]
        ?.resetsAt;

    expect(resetsAt("2027-01-15T09:30:00Z")).toBe("2027-01-15T09:30:00.000Z");
    expect(resetsAt("1800000000")).toBe("2027-01-15T08:00:00.000Z");
    expect(resetsAt("1800000000000")).toBe("2027-01-15T08:00:00.000Z");
  });

  it("rejects malformed, missing, and out-of-range TUI data", () => {
    const invalid = [
      "not usage",
      "Current session -1% used",
      "Current session 101% used",
      "Current week (Sonnet) 10% used",
    ];

    for (const input of invalid) {
      expect(parseClaudeUsageTuiOutput(input, "2027-01-15T08:00:00.000Z")).toBeUndefined();
    }
  });
});

describe("resolveClaudeActiveUsageProbeLaunch", () => {
  it.effect("runs a Windows cli.js entry through the host runtime", () =>
    Effect.gen(function* () {
      const cliPath = "C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js";
      expect(
        yield* resolveClaudeActiveUsageProbeLaunch({
          executablePath: cliPath,
          args: ["--model", "haiku"],
          environment: { PATH: "C:\\Windows\\System32" },
        }),
      ).toEqual({
        shell: "C:\\Program Files\\nodejs\\node.exe",
        args: [cliPath, "--model", "haiku"],
      });
    }).pipe(
      Effect.provideService(HostProcessPlatform, "win32"),
      Effect.provideService(HostProcessExecutablePath, "C:\\Program Files\\nodejs\\node.exe"),
    ),
  );

  it.effect("routes a Windows command shim through the configured command interpreter", () =>
    Effect.gen(function* () {
      const launch = yield* resolveClaudeActiveUsageProbeLaunch({
        executablePath: "claude",
        args: ["--model", "haiku"],
        environment: {
          PATH: "C:\\Users\\dev\\AppData\\Roaming\\npm",
          PATHEXT: ".COM;.EXE;.BAT;.CMD",
          ComSpec: "C:\\Windows\\System32\\cmd.exe",
        },
      });

      expect(launch.shell).toBe("C:\\Windows\\System32\\cmd.exe");
      expect(launch.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
      expect(launch.args[3]).toContain("claude.cmd");
      expect(launch.args[3]).toContain("--model");
    }).pipe(
      Effect.provideService(HostProcessPlatform, "win32"),
      Effect.provideService(
        SpawnExecutableResolution,
        () => "C:\\Users\\dev\\AppData\\Roaming\\npm\\claude.cmd",
      ),
    ),
  );
});

class FakePtyProcess implements PtyAdapter.PtyProcess {
  readonly pid: number;
  readonly writes: string[] = [];
  killed = false;
  exited = false;
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(event: PtyAdapter.PtyExitEvent) => void>();
  readonly listenerOrder: string[] = [];
  private readonly wrotePing: Deferred.Deferred<void>;
  private readonly wroteUsage: Deferred.Deferred<void>;
  private readonly dataSubscribed: Deferred.Deferred<void>;
  private readonly throwOnDataRegistration: boolean;
  private readonly exitDuringExitRegistration: boolean;
  private readonly asyncExitOnKill: boolean;

  constructor(
    pid: number,
    wrotePing: Deferred.Deferred<void>,
    wroteUsage: Deferred.Deferred<void>,
    dataSubscribed: Deferred.Deferred<void>,
    throwOnDataRegistration: boolean,
    exitDuringExitRegistration: boolean,
    asyncExitOnKill: boolean,
  ) {
    this.pid = pid;
    this.wrotePing = wrotePing;
    this.wroteUsage = wroteUsage;
    this.dataSubscribed = dataSubscribed;
    this.throwOnDataRegistration = throwOnDataRegistration;
    this.exitDuringExitRegistration = exitDuringExitRegistration;
    this.asyncExitOnKill = asyncExitOnKill;
  }

  write(data: string): void {
    this.writes.push(data);
    if (data === "ping (reply with pong)\r") Deferred.doneUnsafe(this.wrotePing, Effect.void);
    if (data === "/usage\r") Deferred.doneUnsafe(this.wroteUsage, Effect.void);
  }

  resize(): void {}

  kill(): void {
    this.killed = true;
    if (this.asyncExitOnKill) queueMicrotask(() => this.emitExit(0));
    else this.emitExit(0);
  }

  onData(callback: (data: string) => void): () => void {
    this.listenerOrder.push("data");
    if (this.throwOnDataRegistration) {
      throw new Error("listener registration failed");
    }
    this.dataListeners.add(callback);
    Deferred.doneUnsafe(this.dataSubscribed, Effect.void);
    return () => this.dataListeners.delete(callback);
  }

  onExit(callback: (event: PtyAdapter.PtyExitEvent) => void): () => void {
    this.listenerOrder.push("exit");
    this.exitListeners.add(callback);
    if (this.exitDuringExitRegistration) this.emitExit(17);
    return () => this.exitListeners.delete(callback);
  }

  emitData(data: string): void {
    for (const listener of this.dataListeners) listener(data);
  }

  emitExit(exitCode = 1): void {
    this.exited = true;
    for (const listener of this.exitListeners) listener({ exitCode, signal: null });
  }
}

const makeFakePty = Effect.fn("ClaudeActiveUsageProbe.test.makeFakePty")(function* (
  options: {
    readonly throwOnDataRegistration?: boolean;
    readonly exitDuringExitRegistration?: boolean;
    readonly asyncExitOnKill?: boolean;
  } = {},
) {
  const spawned = yield* Deferred.make<{
    readonly input: PtyAdapter.PtySpawnInput;
    readonly process: FakePtyProcess;
  }>();
  const secondSpawned = yield* Deferred.make<{
    readonly input: PtyAdapter.PtySpawnInput;
    readonly process: FakePtyProcess;
  }>();
  const wrotePing = yield* Deferred.make<void>();
  const wroteUsage = yield* Deferred.make<void>();
  const dataSubscribed = yield* Deferred.make<void>();
  const wroteSecondPing = yield* Deferred.make<void>();
  const wroteSecondUsage = yield* Deferred.make<void>();
  const secondDataSubscribed = yield* Deferred.make<void>();
  const spawnInputs: PtyAdapter.PtySpawnInput[] = [];
  const processes: FakePtyProcess[] = [];
  const service = PtyAdapter.PtyAdapter.of({
    spawn: (input) =>
      Effect.sync(() => {
        const isSecond = processes.length === 1;
        const process = new FakePtyProcess(
          9_000 + processes.length,
          isSecond ? wroteSecondPing : wrotePing,
          isSecond ? wroteSecondUsage : wroteUsage,
          isSecond ? secondDataSubscribed : dataSubscribed,
          options.throwOnDataRegistration ?? false,
          options.exitDuringExitRegistration ?? false,
          options.asyncExitOnKill ?? false,
        );
        spawnInputs.push(input);
        processes.push(process);
        Deferred.doneUnsafe(spawned, Effect.succeed({ input, process }));
        if (isSecond) {
          Deferred.doneUnsafe(secondSpawned, Effect.succeed({ input, process }));
        }
        return process;
      }),
  });
  return {
    service,
    spawned,
    secondSpawned,
    wrotePing,
    wroteUsage,
    dataSubscribed,
    wroteSecondPing,
    wroteSecondUsage,
    secondDataSubscribed,
    spawnInputs,
    processes,
  };
});

it.layer(NodeServices.layer)("Claude active usage PTY probe", (it) => {
  it.effect(
    "isolates the TUI, sends one exact prompt after readiness, captures limits, and cleans up",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const profileDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-profile-" });
        const profileSettings = path.join(profileDir, "settings.json");
        const profileCredentials = path.join(profileDir, ".credentials.json");
        const profilePluginDir = path.join(profileDir, "plugins");
        const profilePlugin = path.join(profilePluginDir, "installed.json");
        yield* fs.writeFileString(profileSettings, '{"statusLine":{"command":"user-owned"}}');
        yield* fs.writeFileString(profileCredentials, '{"oauthToken":"test-only-auth-material"}');
        yield* fs.makeDirectory(profilePluginDir);
        yield* fs.writeFileString(profilePlugin, '{"enabled":true}');
        const originalProfileEntries = (yield* fs.readDirectory(profileDir)).toSorted();
        const fake = yield* makeFakePty();
        const probe = yield* makeClaudeActiveUsageProbe({ cooldownMs: 60_000 }).pipe(
          Effect.provideService(PtyAdapter.PtyAdapter, fake.service),
        );
        const fiber = yield* probe
          .probe({
            profileKey: profileDir,
            cooldownKey: "claude-work:auth-a",
            executablePath: "/usr/bin/claude",
            environment: {
              claude_config_dir: profileDir,
              Anthropic_Api_Key: "must-not-reach-child",
              anthropic_AUTH_token: "must-not-reach-child",
              Anthropic_Base_Url: "https://must-not-reach-child.example.test",
              claude_CODE_use_vertex: "true",
              claude_code_safe_mode: "duplicate-must-be-removed",
              HOME: "/Users/tester",
              PATH: "/usr/bin",
            },
          })
          .pipe(Effect.forkChild);

        const spawned = yield* Deferred.await(fake.spawned);
        yield* Deferred.await(fake.dataSubscribed);
        assert.notEqual(spawned.input.cwd, profileDir);
        const isolatedConfigDir = spawned.input.env.CLAUDE_CONFIG_DIR;
        if (isolatedConfigDir === undefined) {
          return yield* Effect.die("Claude probe omitted its isolated paths.");
        }
        assert.notEqual(isolatedConfigDir, profileDir);
        assert.equal(spawned.input.env.HOME, "/Users/tester");
        expect(
          Object.keys(spawned.input.env).filter(
            (name) => name.toUpperCase() === "CLAUDE_CONFIG_DIR",
          ),
        ).toEqual(["CLAUDE_CONFIG_DIR"]);
        const childEnvironmentNames = new Set(
          Object.keys(spawned.input.env).map((name) => name.toUpperCase()),
        );
        expect(childEnvironmentNames.has("ANTHROPIC_API_KEY")).toBe(false);
        expect(childEnvironmentNames.has("ANTHROPIC_AUTH_TOKEN")).toBe(false);
        expect(childEnvironmentNames.has("ANTHROPIC_BASE_URL")).toBe(false);
        expect(childEnvironmentNames.has("CLAUDE_CODE_USE_VERTEX")).toBe(false);
        expect(yield* fs.readFileString(path.join(isolatedConfigDir, ".credentials.json"))).toBe(
          '{"oauthToken":"test-only-auth-material"}',
        );
        expect(
          (yield* fs.stat(path.join(isolatedConfigDir, ".credentials.json"))).mode & 0o777,
        ).toBe(0o600);
        yield* fs.writeFileString(path.join(isolatedConfigDir, "new-cli-state.json"), "{}");
        yield* fs.writeFileString(
          path.join(isolatedConfigDir, ".credentials.json"),
          '{"oauthToken":"mutated-only-in-temp"}',
        );
        assert.include(spawned.input.args ?? [], "--safe-mode");
        assert.include(spawned.input.args ?? [], "--ax-screen-reader");
        assert.include(spawned.input.args ?? [], "--restricted");
        assert.include(spawned.input.args ?? [], "--strict-mcp-config");
        const modelIndex = spawned.input.args?.indexOf("--model") ?? -1;
        const toolsIndex = spawned.input.args?.indexOf("--tools") ?? -1;
        assert.equal(spawned.input.args?.[modelIndex + 1], "haiku");
        assert.equal(spawned.input.args?.[toolsIndex + 1], "");

        const settingsIndex = spawned.input.args?.indexOf("--settings") ?? -1;
        const mcpIndex = spawned.input.args?.indexOf("--mcp-config") ?? -1;
        assert.equal(settingsIndex, -1);
        assert.isAtLeast(mcpIndex, 0);
        const temporaryMcpPath = spawned.input.args?.[mcpIndex + 1];
        if (temporaryMcpPath === undefined) {
          return yield* Effect.die("Claude probe omitted its temporary config paths.");
        }
        assert.equal(spawned.input.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS, "1");
        assert.equal(spawned.input.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, "1");
        expect(
          // @effect-diagnostics-next-line preferSchemaOverJson:off -- inspect trusted test fixture JSON
          JSON.parse(yield* fs.readFileString(path.join(isolatedConfigDir, ".claude.json"))),
        ).toEqual({
          hasCompletedOnboarding: true,
          theme: "dark",
          projects: {
            [spawned.input.cwd]: { hasTrustDialogAccepted: true },
          },
        });
        // @effect-diagnostics-next-line preferSchemaOverJson:off -- inspect trusted test fixture JSON
        expect(JSON.parse(yield* fs.readFileString(temporaryMcpPath))).toEqual({ mcpServers: {} });

        spawned.process.emitData("Claude Code\n$ ");
        yield* Deferred.await(fake.wrotePing);
        expect(spawned.process.writes).toEqual(["ping (reply with pong)\r"]);

        spawned.process.emitData("pong\n> ");
        yield* Deferred.await(fake.wroteUsage);
        expect(spawned.process.writes).toEqual(["ping (reply with pong)\r", "/usage\r"]);
        spawned.process.emitData("Plan usage limits\nCurrent session\n18% used\n");
        yield* Effect.forEach([0, 1], () => Effect.yieldNow, { discard: true });
        expect(fiber.pollUnsafe()).toBeUndefined();
        spawned.process.emitData("Resets in 1 hour\nCurrent week (all models)\n41% used\n");
        yield* Effect.forEach([0, 1], () => Effect.yieldNow, { discard: true });
        expect(fiber.pollUnsafe()).toBeUndefined();
        spawned.process.emitData("Resets in 6 days\n> ");
        const limits = yield* Fiber.join(fiber);

        expect(limits.windows.map(({ id, usedPercent }) => ({ id, usedPercent }))).toEqual([
          { id: "five_hour", usedPercent: 18 },
          { id: "seven_day", usedPercent: 41 },
        ]);
        expect(spawned.process.killed).toBe(true);
        expect(yield* fs.exists(spawned.input.cwd)).toBe(false);
        expect(yield* fs.exists(temporaryMcpPath)).toBe(false);
        expect(yield* fs.exists(isolatedConfigDir)).toBe(false);
        expect((yield* fs.readDirectory(profileDir)).toSorted()).toEqual(originalProfileEntries);
        expect(yield* fs.readFileString(profileSettings)).toBe(
          '{"statusLine":{"command":"user-owned"}}',
        );
        expect(yield* fs.readFileString(profileCredentials)).toBe(
          '{"oauthToken":"test-only-auth-material"}',
        );
        expect(yield* fs.readFileString(profilePlugin)).toBe('{"enabled":true}');
      }).pipe(Effect.scoped),
  );

  it.effect("serializes a profile and reuses the recent outcome during cooldown", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePty();
      const now = 1_000;
      const probe = yield* makeClaudeActiveUsageProbe({
        cooldownMs: 60_000,
        now: () => now,
      }).pipe(Effect.provideService(PtyAdapter.PtyAdapter, fake.service));
      const input = {
        profileKey: "/profiles/work",
        cooldownKey: "claude-work:auth-a",
        executablePath: "/usr/bin/claude",
        environment: { CLAUDE_CONFIG_DIR: "/profiles/work" },
      };
      const run = probe.probe(input);
      const first = yield* run.pipe(Effect.forkChild);
      const second = yield* run.pipe(Effect.forkChild);
      const spawned = yield* Deferred.await(fake.spawned);
      yield* Deferred.await(fake.dataSubscribed);
      spawned.process.emitData("Claude Code\n> ");
      yield* Deferred.await(fake.wrotePing);
      spawned.process.emitData("pong\n> ");
      yield* Deferred.await(fake.wroteUsage);
      spawned.process.emitData(
        "Current session\n9% used\nResets in 1 hour\n" +
          "Current week (all models)\n19% used\nResets in 6 days\n",
      );
      const [firstLimits, secondLimits] = yield* Effect.all([
        Fiber.join(first),
        Fiber.join(second),
      ]);
      expect(firstLimits).toEqual(secondLimits);
      expect(fake.spawnInputs).toHaveLength(1);

      expect(yield* run).toEqual(firstLimits);
      expect(fake.spawnInputs).toHaveLength(1);

      const otherAccount = yield* probe
        .probe({ ...input, cooldownKey: "claude-personal:auth-b" })
        .pipe(Effect.forkChild);
      const secondSpawned = yield* Deferred.await(fake.secondSpawned);
      yield* Deferred.await(fake.secondDataSubscribed);
      secondSpawned.process.emitData("Claude Code\n> ");
      yield* Deferred.await(fake.wroteSecondPing);
      secondSpawned.process.emitData("pong\n> ");
      yield* Deferred.await(fake.wroteSecondUsage);
      secondSpawned.process.emitData(
        "Current session\n29% used\nResets in 1 hour\n" +
          "Current week (all models)\n39% used\nResets in 6 days\n",
      );
      expect((yield* Fiber.join(otherAccount)).windows[0]?.usedPercent).toBe(29);
      expect(fake.spawnInputs).toHaveLength(2);
    }).pipe(Effect.scoped),
  );

  it.effect("backs off after a malformed capture and kills the exact PTY", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const fake = yield* makeFakePty();
      const probe = yield* makeClaudeActiveUsageProbe({ cooldownMs: 60_000 }).pipe(
        Effect.provideService(PtyAdapter.PtyAdapter, fake.service),
      );
      const input = {
        profileKey: "/profiles/work",
        cooldownKey: "claude-work:auth-a",
        executablePath: "/usr/bin/claude",
        environment: { CLAUDE_CONFIG_DIR: "/profiles/work" },
      };
      const fiber = yield* probe.probe(input).pipe(Effect.exit, Effect.forkChild);
      const spawned = yield* Deferred.await(fake.spawned);
      yield* Deferred.await(fake.dataSubscribed);
      spawned.process.emitData("Claude Code\n> ");
      yield* Deferred.await(fake.wrotePing);
      spawned.process.emitData("pong\n> ");
      yield* Deferred.await(fake.wroteUsage);
      spawned.process.emitData("Current week (Sonnet)\n101% used\n");
      spawned.process.emitExit();

      const exit = yield* Fiber.join(fiber);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(spawned.process.killed).toBe(true);
      expect(yield* fs.exists(spawned.input.cwd)).toBe(false);
      expect(Exit.isFailure(yield* probe.probe(input).pipe(Effect.exit))).toBe(true);
      expect(fake.spawnInputs).toHaveLength(1);
    }).pipe(Effect.scoped),
  );

  it.effect("rejects two percentage windows when either reset is unparseable", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePty();
      const probe = yield* makeClaudeActiveUsageProbe({ cooldownMs: 0 }).pipe(
        Effect.provideService(PtyAdapter.PtyAdapter, fake.service),
      );
      const fiber = yield* probe
        .probe({
          profileKey: "/profiles/work",
          cooldownKey: "claude-work:auth-a",
          executablePath: "/usr/bin/claude",
          environment: { CLAUDE_CONFIG_DIR: "/profiles/work" },
        })
        .pipe(Effect.exit, Effect.forkChild);
      const spawned = yield* Deferred.await(fake.spawned);
      yield* Deferred.await(fake.dataSubscribed);
      spawned.process.emitData("Claude Code\n> ");
      yield* Deferred.await(fake.wrotePing);
      spawned.process.emitData("pong\n> ");
      yield* Deferred.await(fake.wroteUsage);
      spawned.process.emitData(
        [
          "Current session",
          "10% used",
          "Resets in 1 hour",
          "Current week (all models)",
          "20% used",
          "Resets next billing interval",
          "",
        ].join("\n"),
      );
      spawned.process.emitExit(9);

      const exit = yield* Fiber.join(fiber);
      expect(Exit.isFailure(exit)).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.effect("owns and kills the PTY before listener registration can fail", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const fake = yield* makeFakePty({
        throwOnDataRegistration: true,
        asyncExitOnKill: true,
      });
      const probe = yield* makeClaudeActiveUsageProbe({ cooldownMs: 0 }).pipe(
        Effect.provideService(PtyAdapter.PtyAdapter, fake.service),
      );

      const exit = yield* probe
        .probe({
          profileKey: "/profiles/work",
          cooldownKey: "claude-work:auth-a",
          executablePath: "/usr/bin/claude",
          environment: { CLAUDE_CONFIG_DIR: "/profiles/work" },
        })
        .pipe(Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      expect(fake.processes).toHaveLength(1);
      expect(fake.processes[0]?.listenerOrder).toEqual(["exit", "data"]);
      expect(fake.processes[0]?.killed).toBe(true);
      expect(fake.processes[0]?.exited).toBe(true);
      expect(yield* fs.exists(fake.spawnInputs[0]!.cwd)).toBe(false);
    }).pipe(Effect.scoped),
  );

  it.effect("observes an exit emitted before the data listener can be registered", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const fake = yield* makeFakePty({ exitDuringExitRegistration: true });
      const probe = yield* makeClaudeActiveUsageProbe({ cooldownMs: 0 }).pipe(
        Effect.provideService(PtyAdapter.PtyAdapter, fake.service),
      );

      const exit = yield* probe
        .probe({
          profileKey: "/profiles/work",
          cooldownKey: "claude-work:auth-a",
          executablePath: "/usr/bin/claude",
          environment: { CLAUDE_CONFIG_DIR: "/profiles/work" },
        })
        .pipe(Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      expect(fake.processes[0]?.listenerOrder).toEqual(["exit"]);
      expect(fake.processes[0]?.killed).toBe(true);
      expect(yield* fs.exists(fake.spawnInputs[0]!.cwd)).toBe(false);
    }).pipe(Effect.scoped),
  );

  it.effect("kills the exact PTY and removes temp state when interrupted after spawn", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const fake = yield* makeFakePty();
      const probe = yield* makeClaudeActiveUsageProbe({ cooldownMs: 0 }).pipe(
        Effect.provideService(PtyAdapter.PtyAdapter, fake.service),
      );
      const fiber = yield* probe
        .probe({
          profileKey: "/profiles/work",
          cooldownKey: "claude-work:auth-a",
          executablePath: "/usr/bin/claude",
          environment: { CLAUDE_CONFIG_DIR: "/profiles/work" },
        })
        .pipe(Effect.forkChild);

      const spawned = yield* Deferred.await(fake.spawned);
      yield* Fiber.interrupt(fiber);

      expect(spawned.process.killed).toBe(true);
      expect(yield* fs.exists(spawned.input.cwd)).toBe(false);
    }).pipe(Effect.scoped),
  );
});

it.effect("times out without sleeps and kills the exact PTY", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const fake = yield* makeFakePty();
    const probe = yield* makeClaudeActiveUsageProbe({ timeoutMs: 1_000, cooldownMs: 0 }).pipe(
      Effect.provideService(PtyAdapter.PtyAdapter, fake.service),
    );
    const fiber = yield* probe
      .probe({
        profileKey: "/profiles/work",
        cooldownKey: "claude-work:auth-a",
        executablePath: "/usr/bin/claude",
        environment: { CLAUDE_CONFIG_DIR: "/profiles/work" },
      })
      .pipe(Effect.exit, Effect.forkChild);
    const spawned = yield* Deferred.await(fake.spawned);
    yield* Deferred.await(fake.dataSubscribed);
    spawned.process.emitData("Claude Code\n> ");
    yield* Deferred.await(fake.wrotePing);
    spawned.process.emitData("pong\n> ");
    yield* Deferred.await(fake.wroteUsage);
    spawned.process.emitData("Current session\n10% used\nCurrent week (all models)\n20% used\n");
    yield* Effect.forEach([0, 1, 2], () => Effect.yieldNow, { discard: true });
    expect(fiber.pollUnsafe()).toBeUndefined();
    yield* TestClock.adjust("1001 millis");

    const exit = yield* Fiber.join(fiber);
    expect(Exit.isFailure(exit)).toBe(true);
    expect(spawned.process.killed).toBe(true);
    expect(yield* fs.exists(spawned.input.cwd)).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

const realPtyLayer = NodePtyAdapter.layer.pipe(Layer.provide(NodeServices.layer));
const realProbeLayer = Layer.merge(realPtyLayer, NodeServices.layer);

it.effect("drives a hermetic Claude executable through the real PTY adapter", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-pty-e2e-" });
    const profile = path.join(root, "profile");
    const argsPath = path.join(root, "args.json");
    const writesPath = path.join(root, "writes.txt");
    yield* fs.makeDirectory(profile, { mode: 0o700 });
    yield* fs.writeFileString(path.join(profile, ".credentials.json"), '{"oauth":"test"}');
    const executablePath = path.join(import.meta.dirname, "fixtures", "fake-claude-usage.cjs");
    const probe = yield* makeClaudeActiveUsageProbe({ timeoutMs: 5_000, cooldownMs: 0 });

    const limits = yield* probe.probe({
      profileKey: profile,
      cooldownKey: "claude-e2e:auth-a",
      executablePath,
      environment: {
        ...process.env,
        CLAUDE_CONFIG_DIR: profile,
        CLAUDE_PROBE_TEST_ARGS_PATH: argsPath,
        CLAUDE_PROBE_TEST_WRITES_PATH: writesPath,
      },
    });

    // @effect-diagnostics-next-line preferSchemaOverJson:off -- inspect trusted fixture output
    const args = JSON.parse(yield* fs.readFileString(argsPath)) as string[];
    expect(args).toContain("--safe-mode");
    expect(args).toContain("--ax-screen-reader");
    expect(args).not.toContain("--settings");
    expect(yield* fs.readFileString(writesPath)).toBe("ping (reply with pong)\n/usage\n");
    expect(limits.windows.map(({ id, usedPercent }) => ({ id, usedPercent }))).toEqual([
      { id: "five_hour", usedPercent: 23 },
      { id: "seven_day", usedPercent: 47 },
    ]);
    expect(limits.windows.every((window) => window.resetsAt !== undefined)).toBe(true);
    expect((yield* fs.readDirectory(profile)).toSorted()).toEqual([".credentials.json"]);
  }).pipe(Effect.scoped, Effect.provide(realProbeLayer)),
);
