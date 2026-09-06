import type { ServerProviderUsageLimits, ServerProviderUsageWindow } from "@t3tools/contracts";
import { HostProcessExecutablePath, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as PtyAdapter from "../../terminal/PtyAdapter.ts";
import { makeUsageLimits } from "../providerUsageLimits.ts";

export interface ClaudeActiveUsageProbeCapabilities {
  readonly subscriptionType: string | undefined;
  readonly tokenSource: string | undefined;
  readonly apiProvider: string | undefined;
  readonly rateLimitsAvailable: boolean;
  readonly hasRateLimitWindows: boolean;
}

const API_BILLING_ENVIRONMENT_VARIABLES = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_API_BASE_URL",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "ANTHROPIC_VERTEX_BASE_URL",
  "ANTHROPIC_FOUNDRY_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
  "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
  "CLAUDE_CODE_USE_GATEWAY",
  "CLAUDE_CODE_GB_BASE_URL",
] as const;

function environmentValue(environment: NodeJS.ProcessEnv, name: string): string | undefined {
  const normalizedName = name.toUpperCase();
  for (const [key, value] of Object.entries(environment)) {
    if (key.toUpperCase() === normalizedName && value?.trim()) return value;
  }
  return undefined;
}

function hasEnvironmentValue(environment: NodeJS.ProcessEnv, name: string): boolean {
  return environmentValue(environment, name) !== undefined;
}

function normalizedMetadata(value: string | undefined): string | undefined {
  const normalized = value
    ?.trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
  return normalized && normalized.length > 0 ? normalized : undefined;
}

function isPaidClaudeSubscription(subscriptionType: string | undefined): boolean {
  const normalized = normalizedMetadata(subscriptionType);
  return (
    normalized !== undefined &&
    [
      "pro",
      "max",
      "max5",
      "max5x",
      "max20",
      "max20x",
      "maxplan",
      "team",
      "enterprise",
      "claudepro",
      "claudemax",
      "claudemax5x",
      "claudemax20x",
      "claudeteam",
      "claudeenterprise",
      "claudeprosubscription",
      "claudemaxsubscription",
      "claudemax5xsubscription",
      "claudemax20xsubscription",
      "claudeteamsubscription",
      "claudeenterprisesubscription",
    ].includes(normalized)
  );
}

function isFirstPartyOAuthToken(tokenSource: string | undefined): boolean {
  const normalized = normalizedMetadata(tokenSource);
  return normalized === undefined || normalized === "oauth" || normalized === "claudeai";
}

export function shouldRunClaudeActiveUsageProbe(input: {
  readonly refreshUsageLimits: boolean;
  readonly capabilities: ClaudeActiveUsageProbeCapabilities;
  readonly environment: NodeJS.ProcessEnv;
}): boolean {
  const { capabilities, environment } = input;
  return (
    input.refreshUsageLimits &&
    capabilities.rateLimitsAvailable &&
    !capabilities.hasRateLimitWindows &&
    capabilities.apiProvider === "firstParty" &&
    isPaidClaudeSubscription(capabilities.subscriptionType) &&
    isFirstPartyOAuthToken(capabilities.tokenSource) &&
    !API_BILLING_ENVIRONMENT_VARIABLES.some((name) => hasEnvironmentValue(environment, name))
  );
}

function usageWindow(
  id: "five_hour" | "seven_day",
  usedPercent: number,
  resetsAt?: string,
): ServerProviderUsageWindow | undefined {
  if (!Number.isFinite(usedPercent) || usedPercent < 0 || usedPercent > 100) {
    return undefined;
  }
  return {
    id,
    kind: id === "five_hour" ? "session" : "weekly",
    label: id === "five_hour" ? "Session" : "Weekly",
    windowDurationMins: id === "five_hour" ? 5 * 60 : 7 * 24 * 60,
    usedPercent,
    ...(resetsAt ? { resetsAt } : {}),
  };
}

function flatTerminalText(input: string): string {
  return (
    input
      // eslint-disable-next-line no-control-regex -- terminal output contains OSC control sequences
      .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
      // eslint-disable-next-line no-control-regex -- terminal output contains ANSI CSI sequences
      .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
      .replaceAll("\r", "\n")
  );
}

function sectionAfterLabel(input: string, label: RegExp): string | undefined {
  const match = label.exec(input);
  if (!match || match.index === undefined) return undefined;
  const following = input.slice(match.index + match[0].length, match.index + match[0].length + 300);
  const boundary = following.search(/\b(?:current\s+session|current\s+week|weekly\s+limit)\b/i);
  return boundary >= 0 ? following.slice(0, boundary) : following;
}

function percentageFromSection(section: string | undefined): number | undefined {
  if (section === undefined) return undefined;
  const percentage = /(-?\d+(?:\.\d+)?)\s*%\s*used\b/i.exec(section)?.[1];
  return percentage === undefined ? undefined : Number(percentage);
}

function isoFromMillis(value: number): string | undefined {
  if (!Number.isFinite(value) || value <= 0) return undefined;
  const dateTime = DateTime.make(value);
  return Option.isSome(dateTime) ? DateTime.formatIso(dateTime.value) : undefined;
}

const RESET_MONTHS = new Map(
  ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].map(
    (month, index) => [month, index] as const,
  ),
);
const RESET_WEEKDAYS = new Map(
  ["sun", "mon", "tue", "wed", "thu", "fri", "sat"].map(
    (weekDay, index) => [weekDay, index] as const,
  ),
);

function clockHour(hour: number, meridiem: string | undefined): number | undefined {
  if (meridiem === undefined) return hour >= 0 && hour <= 23 ? hour : undefined;
  if (hour < 1 || hour > 12) return undefined;
  return (hour % 12) + (meridiem.toLowerCase() === "pm" ? 12 : 0);
}

function parseRelativeReset(resetText: string, nowMs: number): string | undefined {
  if (!/^in\b/i.test(resetText.trim())) return undefined;
  const units = [
    ...resetText.matchAll(/(\d+(?:\.\d+)?)\s*(days?|hours?|hrs?|minutes?|mins?|seconds?|secs?)/gi),
  ];
  if (units.length === 0) return undefined;
  let durationMs = 0;
  for (const [, rawValue, rawUnit] of units) {
    const value = Number(rawValue);
    const unit = rawUnit!.toLowerCase();
    durationMs +=
      value *
      (unit.startsWith("day")
        ? 86_400_000
        : unit.startsWith("hour") || unit.startsWith("hr")
          ? 3_600_000
          : unit.startsWith("min")
            ? 60_000
            : 1_000);
  }
  return isoFromMillis(nowMs + durationMs);
}

function resetTimeZone(resetText: string): string | undefined {
  return /\(([A-Za-z_+-]+\/[A-Za-z0-9_+./-]+)\)/.exec(resetText)?.[1];
}

type ResetDateParts = ReturnType<typeof DateTime.toParts>;

function localParts(nowMs: number, timeZone: string | undefined): ResetDateParts | undefined {
  const now = DateTime.make(nowMs);
  if (Option.isNone(now)) return undefined;
  if (timeZone === undefined) return DateTime.toPartsUtc(now.value);
  const zoned = DateTime.setZoneNamed(now.value, timeZone);
  return Option.isSome(zoned) ? DateTime.toParts(zoned.value) : undefined;
}

function wallClockEpoch(
  input: {
    readonly year: number;
    readonly month: number;
    readonly day: number;
    readonly hour: number;
    readonly minute: number;
  },
  timeZone: string | undefined,
): number | undefined {
  if (timeZone === undefined) {
    const candidate = DateTime.make({ ...input, second: 0, millisecond: 0 });
    if (Option.isNone(candidate)) return undefined;
    const parts = DateTime.toPartsUtc(candidate.value);
    return parts.year === input.year &&
      parts.month === input.month &&
      parts.day === input.day &&
      parts.hour === input.hour &&
      parts.minute === input.minute
      ? candidate.value.epochMilliseconds
      : undefined;
  }
  const candidate = DateTime.makeZoned(
    { ...input, second: 0, millisecond: 0 },
    { timeZone, adjustForTimeZone: true },
  );
  return Option.isSome(candidate) ? candidate.value.epochMilliseconds : undefined;
}

function shiftedCalendarDate(
  input: Pick<ResetDateParts, "year" | "month" | "day">,
  days: number,
): Pick<ResetDateParts, "year" | "month" | "day"> {
  const shifted = DateTime.add(DateTime.makeUnsafe(input), { days });
  const parts = DateTime.toPartsUtc(shifted);
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
  };
}

function parseAbsoluteReset(resetText: string, nowMs: number): string | undefined {
  const explicitTimestamp = resetText.match(
    /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})\b/i,
  )?.[0];
  if (explicitTimestamp) return isoFromMillis(Date.parse(explicitTimestamp));

  const epoch = /\b(\d{10}|\d{13})\b/.exec(resetText)?.[1];
  if (epoch) return isoFromMillis(Number(epoch) * (epoch.length === 10 ? 1_000 : 1));

  const timeZone = resetTimeZone(resetText);
  const nowParts = localParts(nowMs, timeZone);
  if (!nowParts) return undefined;
  const monthDate =
    /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{1,2})(?:,?\s+(\d{4}))?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i.exec(
      resetText,
    );
  if (monthDate) {
    const month = RESET_MONTHS.get(monthDate[1]!.slice(0, 3).toLowerCase());
    const explicitYear = monthDate[3] === undefined ? undefined : Number(monthDate[3]);
    const hour = clockHour(Number(monthDate[4]), monthDate[6]);
    const minute = Number(monthDate[5] ?? 0);
    if (month === undefined || hour === undefined || minute > 59) return undefined;
    let year = explicitYear ?? nowParts.year;
    let candidate = wallClockEpoch(
      { year, month: month + 1, day: Number(monthDate[2]), hour, minute },
      timeZone,
    );
    if (candidate === undefined) return undefined;
    if (explicitYear === undefined && candidate <= nowMs) {
      year += 1;
      candidate = wallClockEpoch(
        { year, month: month + 1, day: Number(monthDate[2]), hour, minute },
        timeZone,
      );
    }
    return candidate === undefined ? undefined : isoFromMillis(candidate);
  }

  const clock = /\b(\d{1,2})(?::(\d{2}))\s*(am|pm)\b/i.exec(resetText);
  if (!clock) return undefined;
  const hour = clockHour(Number(clock[1]), clock[3]);
  const minute = Number(clock[2]);
  if (hour === undefined || minute > 59) return undefined;

  const weekDayMatch = /\b(sun|mon|tue|wed|thu|fri|sat)[a-z]*\b/i.exec(resetText);
  const targetWeekDay = weekDayMatch
    ? RESET_WEEKDAYS.get(weekDayMatch[1]!.slice(0, 3).toLowerCase())
    : undefined;
  let days = targetWeekDay === undefined ? 0 : (targetWeekDay - nowParts.weekDay + 7) % 7;
  let date = shiftedCalendarDate(nowParts, days);
  let candidate = wallClockEpoch({ ...date, hour, minute }, timeZone);
  if (candidate === undefined) return undefined;
  if (candidate <= nowMs) {
    days = targetWeekDay === undefined ? 1 : 7;
    date = shiftedCalendarDate(date, days);
    candidate = wallClockEpoch({ ...date, hour, minute }, timeZone);
  }
  return candidate === undefined ? undefined : isoFromMillis(candidate);
}

function resetFromSection(section: string | undefined, nowMs: number): string | undefined {
  if (section === undefined) return undefined;
  const resetText = /\bresets?\s*:?\s*([^\n]+)/i.exec(section)?.[1]?.trim();
  if (!resetText) return undefined;
  return parseRelativeReset(resetText, nowMs) ?? parseAbsoluteReset(resetText, nowMs);
}

export function parseClaudeUsageTuiOutput(
  input: string,
  checkedAt: string,
): ServerProviderUsageLimits | undefined {
  const text = flatTerminalText(input);
  const nowMs = Date.parse(checkedAt);
  const windows: ServerProviderUsageWindow[] = [];
  const sessionSection = sectionAfterLabel(text, /\bcurrent\s+session\b/i);
  const weeklySection = sectionAfterLabel(
    text,
    /(?:\bweekly\s+limit(?:\s*\(\s*all\s+models\s*\)|(?!\s*\())|\bcurrent\s+week(?:\s*\(\s*all\s+models\s*\)|(?!\s*\()))/i,
  );
  const session = percentageFromSection(sessionSection);
  const weekly = percentageFromSection(weeklySection);
  if (session !== undefined) {
    const window = usageWindow("five_hour", session, resetFromSection(sessionSection, nowMs));
    if (!window) return undefined;
    windows.push(window);
  }
  if (weekly !== undefined) {
    const window = usageWindow("seven_day", weekly, resetFromSection(weeklySection, nowMs));
    if (!window) return undefined;
    windows.push(window);
  }
  return windows.length > 0 ? makeUsageLimits({ checkedAt, windows }) : undefined;
}

const DEFAULT_PROBE_TIMEOUT_MS = 30_000;
const DEFAULT_COOLDOWN_MS = 60_000;

export class ClaudeActiveUsageProbeError extends Schema.TaggedErrorClass<ClaudeActiveUsageProbeError>()(
  "ClaudeActiveUsageProbeError",
  {
    reason: Schema.Literals(["spawnFailed", "timedOut", "exited", "invalidCapture"]),
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export interface ClaudeActiveUsageProbeInput {
  readonly profileKey: string;
  readonly cooldownKey: string;
  readonly executablePath: string;
  readonly environment: NodeJS.ProcessEnv;
}

export interface ClaudeActiveUsageProbeShape {
  readonly probe: (
    input: ClaudeActiveUsageProbeInput,
  ) => Effect.Effect<ServerProviderUsageLimits, ClaudeActiveUsageProbeError>;
}

export class ClaudeActiveUsageProbe extends Context.Service<
  ClaudeActiveUsageProbe,
  ClaudeActiveUsageProbeShape
>()("t3/provider/Layers/ClaudeActiveUsageProbe") {}

const isClaudeActiveUsageProbeError = Schema.is(ClaudeActiveUsageProbeError);

type CachedProbeResult = {
  readonly completedAt: number;
  readonly result: Result.Result<ServerProviderUsageLimits, ClaudeActiveUsageProbeError>;
};

export const resolveClaudeActiveUsageProbeLaunch = Effect.fn("resolveClaudeActiveUsageProbeLaunch")(
  function* (input: {
    readonly executablePath: string;
    readonly args: ReadonlyArray<string>;
    readonly environment: NodeJS.ProcessEnv;
  }) {
    const platform = yield* HostProcessPlatform;
    const hostExecutablePath = yield* HostProcessExecutablePath;
    const resolved = yield* resolveSpawnCommand(input.executablePath, input.args, {
      env: input.environment,
    });

    if (/\.(?:c|m)?js$/i.test(resolved.command)) {
      return {
        shell: hostExecutablePath,
        args: [resolved.command, ...resolved.args],
      };
    }

    if (platform === "win32" && resolved.shell) {
      const commandInterpreter =
        input.environment.ComSpec?.trim() || input.environment.COMSPEC?.trim() || "cmd.exe";
      return {
        shell: commandInterpreter,
        args: ["/d", "/s", "/c", [resolved.command, ...resolved.args].join(" ")],
      };
    }

    return { shell: resolved.command, args: [...resolved.args] };
  },
);

function activeProbeArgs(mcpPath: string): ReadonlyArray<string> {
  return [
    "--safe-mode",
    "--ax-screen-reader",
    "--restricted",
    "--strict-mcp-config",
    "--mcp-config",
    mcpPath,
    "--model",
    "haiku",
    "--tools",
    "",
    "--permission-mode",
    "dontAsk",
    "--no-chrome",
    "--prompt-suggestions",
    "false",
  ];
}

const SANITIZED_PROBE_ENVIRONMENT_VARIABLES = new Set(
  [
    ...API_BILLING_ENVIRONMENT_VARIABLES,
    "CLAUDE_CONFIG_DIR",
    "ENABLE_CLAUDEAI_MCP_SERVERS",
    "FORCE_CODE_TERMINAL",
    "CLAUDE_CODE_SAFE_MODE",
    "CLAUDE_CODE_DISABLE_CLAUDE_MDS",
    "CLAUDE_CODE_DISABLE_AUTO_MEMORY",
    "CLAUDE_CODE_AUTO_CONNECT_IDE",
    "CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL",
  ].map((name) => name.toUpperCase()),
);

function makeProbeEnvironment(
  environment: NodeJS.ProcessEnv,
  isolatedConfigDirectory: string,
): NodeJS.ProcessEnv {
  const sanitized: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(environment)) {
    if (!SANITIZED_PROBE_ENVIRONMENT_VARIABLES.has(name.toUpperCase())) sanitized[name] = value;
  }
  return {
    ...sanitized,
    CLAUDE_CONFIG_DIR: isolatedConfigDirectory,
    ENABLE_CLAUDEAI_MCP_SERVERS: "false",
    CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    CLAUDE_CODE_AUTO_CONNECT_IDE: "0",
    CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL: "1",
  };
}

export const makeClaudeActiveUsageProbe = Effect.fn("makeClaudeActiveUsageProbe")(function* (
  options: {
    readonly timeoutMs?: number;
    readonly cooldownMs?: number;
    readonly now?: () => number;
  } = {},
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const ptyAdapter = yield* PtyAdapter.PtyAdapter;
  const semaphoresRef = yield* Ref.make<ReadonlyMap<string, Semaphore.Semaphore>>(new Map());
  const recentRef = yield* Ref.make<ReadonlyMap<string, CachedProbeResult>>(new Map());
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const now = options.now ?? Date.now;

  const semaphoreFor = Effect.fn("ClaudeActiveUsageProbe.semaphoreFor")(function* (
    profileKey: string,
  ) {
    const candidate = yield* Semaphore.make(1);
    return yield* Ref.modify(semaphoresRef, (current) => {
      const existing = current.get(profileKey);
      if (existing) return [existing, current] as const;
      const next = new Map(current);
      next.set(profileKey, candidate);
      return [candidate, next] as const;
    });
  });

  const execute = Effect.fn("ClaudeActiveUsageProbe.execute")(function* (
    input: ClaudeActiveUsageProbeInput,
  ): Effect.fn.Return<ServerProviderUsageLimits, ClaudeActiveUsageProbeError, never> {
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const tempDirectory = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-claude-usage-probe-",
        });
        yield* fileSystem.chmod(tempDirectory, 0o700);
        const mcpPath = path.join(tempDirectory, "mcp.json");
        const isolatedConfigDirectory = path.join(tempDirectory, "claude-config");
        yield* fileSystem.makeDirectory(isolatedConfigDirectory, { mode: 0o700 });
        yield* fileSystem.chmod(isolatedConfigDirectory, 0o700);
        const sourceConfigDirectory = environmentValue(input.environment, "CLAUDE_CONFIG_DIR");
        if (sourceConfigDirectory) {
          const sourceCredentials = path.join(sourceConfigDirectory, ".credentials.json");
          if (yield* fileSystem.exists(sourceCredentials)) {
            const isolatedCredentials = path.join(isolatedConfigDirectory, ".credentials.json");
            yield* fileSystem.copyFile(sourceCredentials, isolatedCredentials);
            yield* fileSystem.chmod(isolatedCredentials, 0o600);
          }
        }
        // @effect-diagnostics-next-line preferSchemaOverJson:off -- trusted internal MCP payload
        yield* fileSystem.writeFileString(mcpPath, JSON.stringify({ mcpServers: {} }));
        yield* fileSystem.chmod(mcpPath, 0o600);

        const probeEnvironment = makeProbeEnvironment(input.environment, isolatedConfigDirectory);
        const launch = yield* resolveClaudeActiveUsageProbeLaunch({
          executablePath: input.executablePath,
          args: activeProbeArgs(mcpPath),
          environment: probeEnvironment,
        });
        const exited = yield* Deferred.make<PtyAdapter.PtyExitEvent>();
        let exitListenerRegistered = false;
        let removeDataListener = () => {};
        let removeExitListener = () => {};
        const processHandle = yield* Effect.acquireRelease(
          ptyAdapter.spawn({
            shell: launch.shell,
            args: [...launch.args],
            cwd: tempDirectory,
            cols: 100,
            rows: 30,
            env: probeEnvironment,
          }),
          (handle) =>
            Effect.gen(function* () {
              const kill = (signal?: string) =>
                Effect.try(() => handle.kill(signal)).pipe(Effect.ignore);
              yield* kill();
              if (exitListenerRegistered) {
                const gracefulExit = yield* Deferred.await(exited).pipe(
                  Effect.timeoutOption(1_000),
                );
                if (Option.isNone(gracefulExit)) {
                  yield* kill("SIGKILL");
                  yield* Deferred.await(exited).pipe(Effect.timeoutOption(1_000), Effect.ignore);
                }
              }
              yield* Effect.try(() => {
                removeDataListener();
                removeExitListener();
              }).pipe(Effect.ignore);
            }).pipe(Effect.uninterruptible),
        );
        const ready = yield* Deferred.make<void>();
        const pongComplete = yield* Deferred.make<void>();
        const captured = yield* Deferred.make<ServerProviderUsageLimits>();
        let phase: "ready" | "pong" | "usage" = "ready";
        let dataBuffer = "";
        removeExitListener = yield* Effect.try(() =>
          processHandle.onExit((event) => {
            Deferred.doneUnsafe(exited, Effect.succeed(event));
          }),
        );
        exitListenerRegistered = true;

        const exitFailure = Deferred.await(exited).pipe(
          Effect.flatMap(
            (event) =>
              new ClaudeActiveUsageProbeError({
                reason: "exited",
                message: `Claude usage probe exited before reporting limits (exit ${event.exitCode}).`,
              }),
          ),
        );
        if (yield* Deferred.isDone(exited)) return yield* exitFailure;
        removeDataListener = yield* Effect.try(() =>
          processHandle.onData((data) => {
            dataBuffer = `${dataBuffer}${data}`.slice(-128 * 1024);
            const text = flatTerminalText(dataBuffer);
            const hasPrompt = (after = 0) => /(?:^|\n)[>❯]\s*$/m.test(text.slice(after));
            if (phase === "ready" && hasPrompt()) {
              Deferred.doneUnsafe(ready, Effect.void);
            } else if (phase === "pong") {
              const pongIndex = text.toLowerCase().lastIndexOf("pong");
              if (pongIndex >= 0 && hasPrompt(pongIndex + 4)) {
                Deferred.doneUnsafe(pongComplete, Effect.void);
              }
            } else if (phase === "usage") {
              const limits = parseClaudeUsageTuiOutput(
                text,
                DateTime.formatIso(DateTime.makeUnsafe(now())),
              );
              if (
                limits?.windows.length === 2 &&
                limits.windows.every((window) => window.resetsAt !== undefined)
              ) {
                Deferred.doneUnsafe(captured, Effect.succeed(limits));
              }
            }
          }),
        );

        yield* Effect.raceFirst(Deferred.await(ready), exitFailure);
        phase = "pong";
        dataBuffer = "";
        processHandle.write("ping (reply with pong)\r");
        yield* Effect.raceFirst(Deferred.await(pongComplete), exitFailure);
        phase = "usage";
        dataBuffer = "";
        processHandle.write("/usage\r");
        return yield* Effect.raceFirst(Deferred.await(captured), exitFailure);
      }),
    ).pipe(
      Effect.timeoutOption(timeoutMs),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            new ClaudeActiveUsageProbeError({
              reason: "timedOut",
              message: "Claude usage probe timed out before reporting limits.",
            }),
          onSome: Effect.succeed,
        }),
      ),
      Effect.catch((cause) =>
        isClaudeActiveUsageProbeError(cause)
          ? Effect.fail(cause)
          : Effect.fail(
              new ClaudeActiveUsageProbeError({
                reason: "spawnFailed",
                message: "Claude usage probe could not start or read its isolated terminal.",
                cause,
              }),
            ),
      ),
    );
  });

  const probe = Effect.fn("ClaudeActiveUsageProbe.probe")(function* (
    input: ClaudeActiveUsageProbeInput,
  ) {
    const semaphore = yield* semaphoreFor(input.profileKey);
    return yield* semaphore.withPermits(1)(
      Effect.gen(function* () {
        const currentTime = now();
        const recent = (yield* Ref.get(recentRef)).get(input.cooldownKey);
        if (recent && currentTime - recent.completedAt < cooldownMs) {
          return Result.isSuccess(recent.result)
            ? recent.result.success
            : yield* recent.result.failure;
        }

        const result = yield* execute(input).pipe(Effect.result);
        yield* Ref.update(recentRef, (current) => {
          const next = new Map(current);
          next.set(input.cooldownKey, { completedAt: now(), result });
          return next;
        });
        return Result.isSuccess(result) ? result.success : yield* result.failure;
      }),
    );
  });

  return ClaudeActiveUsageProbe.of({ probe });
});

export const ClaudeActiveUsageProbeLayer = Layer.effect(
  ClaudeActiveUsageProbe,
  makeClaudeActiveUsageProbe(),
);
