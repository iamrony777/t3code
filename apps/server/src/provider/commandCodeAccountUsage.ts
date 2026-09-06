import type {
  ServerProviderAccountUsage,
  ServerProviderUsageLimits,
  ServerProviderUsageWindow,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

type CommandCodeApiEnvironment = "local" | "staging" | "prod";

const AUTH_FILE_NAMES: Readonly<Record<CommandCodeApiEnvironment, string>> = {
  local: "auth.local.json",
  staging: "auth.staging.json",
  prod: "auth.json",
};
const API_BASE_URLS: Readonly<Record<CommandCodeApiEnvironment, string>> = {
  local: "http://localhost:9090",
  staging: "https://staging-api.commandcode.ai",
  prod: "https://api.commandcode.ai",
};
const STUDIO_BASE_URLS: Readonly<Record<CommandCodeApiEnvironment, string>> = {
  local: "http://localhost:3000",
  staging: "https://staging.commandcode.ai",
  prod: "https://commandcode.ai",
};
export const COMMAND_CODE_USAGE_MAX_BODY_BYTES = 256 * 1024;
export const COMMAND_CODE_USAGE_TIMEOUT_MS = 5_000;
const COMMAND_CODE_AUTH_MAX_BYTES = 64 * 1024;
const decodeUnknownJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

const PLAN_LABELS: Readonly<Record<string, string>> = {
  "individual-go": "Go",
  "individual-goat": "GOAT",
  "individual-pro": "Pro",
  "individual-pro-v1": "Pro",
  "individual-provider": "Provider",
  "individual-max": "Max",
  "individual-ultra": "Ultra",
  "teams-pro": "Teams Pro",
};

export interface CommandCodeAccountUsageFetchInput {
  readonly url: string;
  readonly apiKey: string;
  readonly maxBodyBytes: number;
  readonly timeoutMs: number;
}

export interface CommandCodeAccountUsageProbeResult {
  readonly accountUsage: ServerProviderAccountUsage;
  readonly usageLimits: ServerProviderUsageLimits;
  readonly accountLabel?: string;
}

export class CommandCodeAccountUsageProbeError extends Schema.TaggedErrorClass<CommandCodeAccountUsageProbeError>()(
  "CommandCodeAccountUsageProbeError",
  { reason: Schema.Literals(["readFailed", "fetchFailed", "badResponse"]) },
) {}

interface EndpointResult {
  readonly value: unknown;
  readonly failed: boolean;
}

const FAILED_ENDPOINT_RESULT: EndpointResult = { value: undefined, failed: true };

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  Predicate.isObject(value) && !Array.isArray(value) ? value : undefined;

const trimmedString = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const nonNegativeNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

const nonNegativeInt = (value: unknown): number | undefined => {
  const number = nonNegativeNumber(value);
  return number !== undefined && Number.isInteger(number) ? number : undefined;
};

const dateString = (value: unknown): string | undefined => {
  const string = trimmedString(value);
  return string !== undefined && Number.isFinite(Date.parse(string)) ? string : undefined;
};

const resetDateString = (value: unknown): string | undefined => {
  if (typeof value === "string") return dateString(value);
  const millis = nonNegativeInt(value);
  if (millis === undefined) return undefined;
  const parsed = DateTime.make(millis);
  return Option.isSome(parsed) ? DateTime.formatIso(parsed.value) : undefined;
};

const compact = <Value extends Record<string, unknown>>(value: Value): Value =>
  Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Value;

const resolveCommandCodeApiEnvironment = (
  environment: NodeJS.ProcessEnv,
): CommandCodeApiEnvironment => {
  const value = environment.COMMANDCODE_API_ENV;
  return value === "local" || value === "staging" || value === "prod" ? value : "prod";
};

const resolveCommandCodeEnvironment = (environment: NodeJS.ProcessEnv) => {
  const apiEnvironment = resolveCommandCodeApiEnvironment(environment);
  const customApiBaseUrl = trimmedString(environment.COMMANDCODE_API_URL);
  const apiBaseUrl =
    environment.COMMANDCODE_SANDBOX === "true" && customApiBaseUrl !== undefined
      ? Effect.try({
          try: () => {
            const parsed = new URL(customApiBaseUrl);
            if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
              throw new TypeError("Unsupported Command Code API URL protocol");
            }
            return parsed.toString();
          },
          catch: () => new CommandCodeAccountUsageProbeError({ reason: "badResponse" }),
        })
      : apiEnvironment === "local"
        ? Effect.try({
            try: () => {
              const rawOffset = trimmedString(environment.PORT_OFFSET);
              const portOffset = rawOffset === undefined ? 0 : Number(rawOffset);
              const port = 9090 + portOffset;
              if (!Number.isInteger(portOffset) || portOffset < 0 || port > 65_535) {
                throw new TypeError("Invalid Command Code local port offset");
              }
              return new URL(`http://localhost:${port}`).toString();
            },
            catch: () => new CommandCodeAccountUsageProbeError({ reason: "badResponse" }),
          })
        : Effect.succeed(API_BASE_URLS[apiEnvironment]);
  return apiBaseUrl.pipe(
    Effect.map((apiBaseUrl) => ({
      apiBaseUrl,
      studioBaseUrl: STUDIO_BASE_URLS[apiEnvironment],
      authFileName: AUTH_FILE_NAMES[apiEnvironment],
    })),
  );
};

const buildEndpoint = (
  baseUrl: string,
  path: string,
  params?: Readonly<Record<string, string | undefined>>,
) => {
  const url = new URL(path, baseUrl);
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  return url.toString();
};

const resolveApiKey = Effect.fn("resolveCommandCodeUsageApiKey")(function* (input: {
  readonly environment: NodeJS.ProcessEnv;
  readonly authFileName: string;
  readonly joinPath: (...parts: ReadonlyArray<string>) => string;
  readonly readFile: (path: string) => Effect.Effect<string, CommandCodeAccountUsageProbeError>;
}) {
  const fromEnvironment = trimmedString(input.environment.COMMAND_CODE_API_KEY);
  if (fromEnvironment !== undefined) return fromEnvironment;

  const home =
    trimmedString(input.environment.HOME) ?? trimmedString(input.environment.USERPROFILE);
  if (home === undefined) return undefined;
  const contents = yield* input
    .readFile(input.joinPath(home, ".commandcode", input.authFileName))
    .pipe(Effect.orElseSucceed(() => ""));
  if (contents.length === 0 || contents.length > COMMAND_CODE_AUTH_MAX_BYTES) return undefined;
  const decoded = yield* decodeUnknownJson(contents).pipe(Effect.result);
  return Result.isSuccess(decoded) ? trimmedString(asRecord(decoded.success)?.apiKey) : undefined;
});

const endpointResult = <E>(effect: Effect.Effect<unknown, E>) =>
  effect.pipe(
    Effect.result,
    Effect.map((result): EndpointResult =>
      Result.isSuccess(result)
        ? { value: result.success, failed: false }
        : { value: undefined, failed: true },
    ),
  );

const closeResponseBody = (response: HttpClientResponse.HttpClientResponse) =>
  response.stream.pipe(
    Stream.runForEachWhile(() => Effect.succeed(false)),
    Effect.ignore,
  );

const collectBoundedResponseBody = (
  response: HttpClientResponse.HttpClientResponse,
  maxBytes: number,
) =>
  Effect.gen(function* () {
    const chunks: Array<Uint8Array> = [];
    let bytes = 0;
    let truncated = false;
    yield* response.stream.pipe(
      Stream.runForEachWhile((chunk) =>
        Effect.sync(() => {
          const remaining = maxBytes - bytes;
          if (chunk.byteLength > remaining) {
            if (remaining > 0) chunks.push(chunk.slice(0, remaining));
            bytes = maxBytes;
            truncated = true;
            return false;
          }
          chunks.push(chunk);
          bytes += chunk.byteLength;
          return true;
        }),
      ),
    );
    return { text: Buffer.concat(chunks, bytes).toString("utf8"), truncated };
  });

const accountIdentity = (value: unknown) => {
  const root = asRecord(value);
  const org = asRecord(root?.org);
  const user = asRecord(root?.user);
  const orgId = trimmedString(org?.id);
  const userId = trimmedString(user?.id);
  const label =
    trimmedString(org?.login) ??
    trimmedString(org?.name) ??
    trimmedString(user?.userName) ??
    trimmedString(user?.name) ??
    trimmedString(user?.login) ??
    trimmedString(user?.email);
  return {
    orgId,
    userId,
    label,
    recognized: orgId !== undefined || userId !== undefined || label !== undefined,
  };
};

const stableAccountId = (
  apiBaseUrl: string,
  identity: ReturnType<typeof accountIdentity>,
): string | undefined => {
  const subject = identity.orgId
    ? ({ kind: "org", id: identity.orgId } as const)
    : identity.userId
      ? ({ kind: "user", id: identity.userId } as const)
      : undefined;
  return subject ? `${new URL(apiBaseUrl).origin}:${subject.kind}:${subject.id}` : undefined;
};

const subscriptionData = (value: unknown) => {
  const root = asRecord(value);
  const data = asRecord(root?.data);
  const planId = trimmedString(data?.planId);
  const status = trimmedString(data?.status);
  const periodStart = dateString(data?.currentPeriodStart);
  const periodEnd = dateString(data?.currentPeriodEnd);
  return {
    planId,
    status,
    periodStart,
    periodEnd,
    recognized:
      root !== undefined &&
      (root.data === null ||
        planId !== undefined ||
        status !== undefined ||
        periodStart !== undefined ||
        periodEnd !== undefined),
  };
};

const usageWindow = (
  value: unknown,
  descriptor: Pick<ServerProviderUsageWindow, "id" | "kind" | "label">,
): ServerProviderUsageWindow | undefined => {
  const data = asRecord(value);
  const used = nonNegativeNumber(data?.used);
  const cap = nonNegativeNumber(data?.cap);
  if (used === undefined || cap === undefined) return undefined;
  const resetsAt = resetDateString(data?.resetAt);
  return {
    ...descriptor,
    usedPercent: cap === 0 ? 0 : Math.min(100, (used / cap) * 100),
    ...(resetsAt !== undefined ? { resetsAt } : {}),
  };
};

const creditsData = (value: unknown) => {
  const root = asRecord(value);
  const credits = asRecord(root?.credits);
  const monthly = nonNegativeNumber(credits?.monthlyCredits);
  const purchased = nonNegativeNumber(credits?.purchasedCredits);
  const free = nonNegativeNumber(credits?.freeCredits);
  const planId = trimmedString(credits?.planId);
  const hasBalance = monthly !== undefined || purchased !== undefined || free !== undefined;
  const balance = hasBalance
    ? compact({
        monthly,
        purchased,
        free,
        total: (monthly ?? 0) + (purchased ?? 0) + (free ?? 0),
      })
    : undefined;
  const windowLimits = asRecord(root?.windowLimits);
  const windows = [
    usageWindow(windowLimits?.fiveHour, {
      id: "five_hour",
      kind: "session",
      label: "5-hour",
    }),
    usageWindow(windowLimits?.weekly, { id: "weekly", kind: "weekly", label: "Weekly" }),
  ].filter((window): window is ServerProviderUsageWindow => window !== undefined);
  return {
    planId,
    balance,
    windows,
    recognized:
      root !== undefined &&
      (root.credits === null ||
        root.windowLimits === null ||
        planId !== undefined ||
        hasBalance ||
        windows.length > 0),
  };
};

const summaryData = (value: unknown) => {
  const root = asRecord(value);
  const requestCount = nonNegativeInt(root?.totalCount);
  const costUsd = nonNegativeNumber(root?.totalCost);
  const input = nonNegativeInt(root?.totalTokensIn);
  const output = nonNegativeInt(root?.totalTokensOut);
  const total = nonNegativeInt(root?.totalTokens);
  const creditsTotal = nonNegativeNumber(root?.totalCredits);
  const creditsFree = nonNegativeNumber(root?.totalFreeCredits);
  const creditsMonthly = nonNegativeNumber(root?.totalMonthlyCredits);
  const creditsPurchased = nonNegativeNumber(root?.totalPurchasedCredits);
  const hasTokens = input !== undefined || output !== undefined || total !== undefined;
  const hasCredits =
    creditsTotal !== undefined ||
    creditsFree !== undefined ||
    creditsMonthly !== undefined ||
    creditsPurchased !== undefined;
  return {
    requestCount,
    costUsd,
    tokens: hasTokens ? compact({ input, output, total }) : undefined,
    creditsUsed: hasCredits
      ? compact({
          total: creditsTotal,
          free: creditsFree,
          monthly: creditsMonthly,
          purchased: creditsPurchased,
        })
      : undefined,
    recognized: requestCount !== undefined || costUsd !== undefined || hasTokens || hasCredits,
  };
};

export const probeCommandCodeAccountUsage = Effect.fn("probeCommandCodeAccountUsage")(
  function* (input: {
    readonly environment: NodeJS.ProcessEnv;
    readonly checkedAt: string;
    readonly joinPath: (...parts: ReadonlyArray<string>) => string;
    readonly readFile: (path: string) => Effect.Effect<string, CommandCodeAccountUsageProbeError>;
    readonly fetchJson: (
      input: CommandCodeAccountUsageFetchInput,
    ) => Effect.Effect<unknown, CommandCodeAccountUsageProbeError>;
  }): Effect.fn.Return<CommandCodeAccountUsageProbeResult> {
    const deadline = (yield* Clock.currentTimeMillis) + COMMAND_CODE_USAGE_TIMEOUT_MS;
    const commandCodeEnvironmentResult = yield* resolveCommandCodeEnvironment(
      input.environment,
    ).pipe(Effect.result);
    if (Result.isFailure(commandCodeEnvironmentResult)) {
      return {
        accountUsage: {
          checkedAt: input.checkedAt,
          unavailable: {
            reason: "probeFailed",
            message: "Command Code usage configuration is unavailable.",
          },
        },
        usageLimits: {
          checkedAt: input.checkedAt,
          windows: [],
          unavailable: {
            reason: "probeFailed",
            message: "Command Code usage configuration is unavailable.",
          },
        },
      };
    }
    const commandCodeEnvironment = commandCodeEnvironmentResult.success;
    const apiKeyResult = yield* resolveApiKey({
      ...input,
      authFileName: commandCodeEnvironment.authFileName,
    }).pipe(Effect.timeoutOption(COMMAND_CODE_USAGE_TIMEOUT_MS));
    const apiKey = Option.isSome(apiKeyResult) ? apiKeyResult.value : undefined;
    if (apiKey === undefined) {
      return {
        accountUsage: {
          checkedAt: input.checkedAt,
          unavailable: {
            reason: "probeFailed",
            message: "Command Code usage authentication is unavailable.",
          },
        },
        usageLimits: {
          checkedAt: input.checkedAt,
          windows: [],
          unavailable: {
            reason: "probeFailed",
            message: "Command Code usage authentication is unavailable.",
          },
        },
      };
    }

    const fetchEndpoint = (url: string) =>
      endpointResult(
        input.fetchJson({
          url,
          apiKey,
          maxBodyBytes: COMMAND_CODE_USAGE_MAX_BODY_BYTES,
          timeoutMs: COMMAND_CODE_USAGE_TIMEOUT_MS,
        }),
      );

    const fetchEndpointByDeadline = (url: string) =>
      Effect.gen(function* () {
        const remaining = deadline - (yield* Clock.currentTimeMillis);
        if (remaining <= 0) return FAILED_ENDPOINT_RESULT;
        const result = yield* fetchEndpoint(url).pipe(Effect.timeoutOption(remaining));
        return Option.isSome(result) ? result.value : FAILED_ENDPOINT_RESULT;
      });

    const whoamiResult = yield* fetchEndpointByDeadline(
      buildEndpoint(commandCodeEnvironment.apiBaseUrl, "/alpha/whoami", { limits: "1" }),
    );
    const identity = accountIdentity(whoamiResult.value);
    const [creditsResult, subscriptionResult] = yield* Effect.all(
      [
        fetchEndpointByDeadline(
          buildEndpoint(commandCodeEnvironment.apiBaseUrl, "/alpha/billing/credits", {
            orgId: identity.orgId,
          }),
        ),
        fetchEndpointByDeadline(
          buildEndpoint(commandCodeEnvironment.apiBaseUrl, "/alpha/billing/subscriptions", {
            orgId: identity.orgId,
          }),
        ),
      ],
      { concurrency: "unbounded" },
    );
    const subscription = subscriptionData(subscriptionResult.value);
    const summaryResult = yield* fetchEndpointByDeadline(
      buildEndpoint(commandCodeEnvironment.apiBaseUrl, "/alpha/usage/summary", {
        orgId: identity.orgId,
        since: subscription.periodStart,
      }),
    );
    const credits = creditsData(creditsResult.value);
    const summary = summaryData(summaryResult.value);
    const failed = [
      whoamiResult.failed || !identity.recognized,
      creditsResult.failed || !credits.recognized,
      subscriptionResult.failed || !subscription.recognized,
      summaryResult.failed || !summary.recognized,
    ];
    const recognizedCount = failed.filter((entry) => !entry).length;
    const planId = subscription.planId ?? credits.planId;
    const plan = planId === undefined ? undefined : (PLAN_LABELS[planId] ?? planId);
    const studioUsageUrl =
      identity.label === undefined
        ? undefined
        : `${commandCodeEnvironment.studioBaseUrl}/${encodeURIComponent(identity.label)}/settings/usage`;
    const accountUsage: ServerProviderAccountUsage = compact({
      checkedAt: input.checkedAt,
      accountId: stableAccountId(commandCodeEnvironment.apiBaseUrl, identity),
      accountLabel: identity.label,
      plan,
      status: subscription.status,
      periodStart: subscription.periodStart,
      periodEnd: subscription.periodEnd,
      requestCount: summary.requestCount,
      tokens: summary.tokens,
      costUsd: summary.costUsd,
      creditsUsed: summary.creditsUsed,
      creditsBalance: credits.balance,
      studioUsageUrl,
      unavailable: failed.some(Boolean)
        ? {
            reason: "probeFailed" as const,
            message:
              recognizedCount === 0
                ? "Command Code usage data could not be loaded."
                : "Some Command Code usage data could not be loaded.",
          }
        : undefined,
    });
    const usageLimits: ServerProviderUsageLimits =
      creditsResult.failed || !credits.recognized
        ? {
            checkedAt: input.checkedAt,
            windows: [],
            unavailable: {
              reason: "probeFailed",
              message: "Command Code usage limits could not be loaded.",
            },
          }
        : { checkedAt: input.checkedAt, windows: credits.windows };

    return {
      accountUsage,
      usageLimits,
      ...(identity.label !== undefined ? { accountLabel: identity.label } : {}),
    };
  },
);

/** Live Command Code usage probe using the effective provider instance's home and environment. */
export const fetchCommandCodeAccountUsage = Effect.fn("fetchCommandCodeAccountUsage")(
  function* (input: { readonly environment: NodeJS.ProcessEnv; readonly checkedAt: string }) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const httpClient = yield* HttpClient.HttpClient;

    return yield* probeCommandCodeAccountUsage({
      environment: input.environment,
      checkedAt: input.checkedAt,
      joinPath: path.join,
      readFile: (filePath) =>
        fileSystem.stat(filePath).pipe(
          Effect.flatMap((info) =>
            info.size > BigInt(COMMAND_CODE_AUTH_MAX_BYTES)
              ? Effect.succeed("")
              : fileSystem.readFileString(filePath),
          ),
          Effect.mapError(() => new CommandCodeAccountUsageProbeError({ reason: "readFailed" })),
        ),
      fetchJson: ({ url, apiKey, maxBodyBytes, timeoutMs }) =>
        Effect.gen(function* () {
          const request = HttpClientRequest.get(url).pipe(
            HttpClientRequest.setHeader("accept", "application/json"),
            HttpClientRequest.setHeader("authorization", `Bearer ${apiKey}`),
          );
          const response = yield* httpClient.execute(request);
          if (response.status < 200 || response.status >= 300) {
            yield* closeResponseBody(response);
            return yield* new CommandCodeAccountUsageProbeError({ reason: "badResponse" });
          }
          const contentLength = Number(response.headers["content-length"]);
          if (Number.isFinite(contentLength) && contentLength > maxBodyBytes) {
            yield* closeResponseBody(response);
            return yield* new CommandCodeAccountUsageProbeError({ reason: "badResponse" });
          }
          const collected = yield* collectBoundedResponseBody(response, maxBodyBytes);
          if (collected.truncated) {
            return yield* new CommandCodeAccountUsageProbeError({ reason: "badResponse" });
          }
          return yield* decodeUnknownJson(collected.text).pipe(
            Effect.mapError(() => new CommandCodeAccountUsageProbeError({ reason: "badResponse" })),
          );
        }).pipe(
          Effect.timeout(timeoutMs),
          Effect.mapError(() => new CommandCodeAccountUsageProbeError({ reason: "fetchFailed" })),
        ),
    });
  },
);
